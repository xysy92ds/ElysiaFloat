package com.elly.assistant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * 原生音频引擎：音乐播放 + 语音合成，共用一套唤醒锁和音频焦点。
 *
 * ## 为什么音乐要搬到原生
 *
 * 以前音乐是 WebView 里的 `<audio>` 在放。浮窗没有 Activity，WebView 一直处于
 * 「不可见」状态，Chromium 因此既不会去申请唤醒锁，也会在息屏后把渲染进程挂起 ——
 * 这就是「电池优化白名单明明给了，息屏照样断」的原因。
 * 电池白名单管的是「进程别被杀」，管不了「CPU 别睡」，本来就是两件事；
 * 而息屏时 CPU 睡着，音频线程自然停摆。
 *
 * 现在改成 MediaPlayer + PARTIAL_WAKE_LOCK（息屏时 CPU 保持清醒，这是续播的正解）
 * + 音频焦点（来电、别的 App 出声时自动让位，回来再续上）+ MediaSession
 * （锁屏、耳机线控、蓝牙都能控制）。
 *
 * ## 分工
 *
 * 原生只管「出声」。歌单、歌词、播放顺序依旧是 JS 说了算：通知栏和耳机上的按键
 * 统一回抛给 JS（`window.__mpCmd`），再由 JS 决定切哪一首 —— 免得两边各存一份歌单，
 * 迟早对不上。
 *
 * 所有会碰 MediaPlayer 的入口都在主线程执行（JS 桥是另一条线程）。
 */
class AudioEngine(private val svc: FloatService, private val wv: WebView) {

    companion object {
        const val CHANNEL_MUSIC = "elly_music"
        const val NOTI_MUSIC = 2

        /** 媒体通知上的按钮 → 回抛给 FloatService → 再转给这里。 */
        const val ACTION_MEDIA = "com.elly.assistant.action.MEDIA"
        const val EXTRA_CMD = "cmd"

        private const val CMD_TOGGLE = "toggle"
        private const val CMD_PLAY = "play"
        private const val CMD_PAUSE = "pause"
        private const val CMD_NEXT = "next"
        private const val CMD_PREV = "prev"
        private const val CMD_STOP = "stop"

        private const val WAKE_TAG = "elly:audio"
        private const val TICK_MS = 500L
    }

    private val main = Handler(Looper.getMainLooper())
    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }

    private val am: AudioManager? by lazy {
        try { svc.getSystemService(Context.AUDIO_SERVICE) as AudioManager } catch (e: Exception) { null }
    }

    /* ======================================================================
     *  唤醒锁：音乐和语音共用，谁在用谁举手，最后一个放下才真的释放
     * ====================================================================== */

    private var wake: PowerManager.WakeLock? = null
    private var musicWantsWake = false
    private var speechWantsWake = false

    private fun refillWakeLock() {
        if (wake != null) return
        try {
            val pm = svc.getSystemService(Context.POWER_SERVICE) as PowerManager
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG).apply {
                setReferenceCounted(false)
            }
        } catch (_: Exception) { }
    }

    private fun syncWake() {
        val need = musicWantsWake || speechWantsWake
        refillWakeLock()
        val w = wake ?: return
        try {
            if (need && !w.isHeld) w.acquire()
            else if (!need && w.isHeld) w.release()
        } catch (_: Exception) { }
    }

    /* ======================================================================
     *  音频焦点
     * ====================================================================== */

    private var focusReq: AudioFocusRequest? = null
    private var resumeOnGain = false

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                // 别人长期要声音（比如他自己开了播放器），我们彻底让位，不自动续
                resumeOnGain = false
                pauseInternal(true)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // 来电之类：先暂停，等它走了再自己接上
                resumeOnGain = playing
                pauseInternal(true)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> setVolume(0.25f)
            AudioManager.AUDIOFOCUS_GAIN -> {
                setVolume(1f)
                if (resumeOnGain) { resumeOnGain = false; playInternal() }
            }
        }
    }

    private fun requestFocus(): Boolean {
        try {
            val a = am ?: return true
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
                val r = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(focusListener)
                    .build()
                focusReq = r
                a.requestAudioFocus(r) != AudioManager.AUDIOFOCUS_REQUEST_FAILED
            } else {
                @Suppress("DEPRECATION")
                a.requestAudioFocus(
                    focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN
                ) != AudioManager.AUDIOFOCUS_REQUEST_FAILED
            }
        } catch (_: Exception) {
            return true
        }
    }

    private fun abandonFocus() {
        try {
            val a = am ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusReq?.let { a.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION") a.abandonAudioFocus(focusListener)
            }
            focusReq = null
        } catch (_: Exception) { }
    }

    /* ======================================================================
     *  音乐播放
     * ====================================================================== */

    private var player: MediaPlayer? = null
    private var session: MediaSession? = null

    private var prepared = false
    private var loading = false
    private var playing = false
    private var durationMs = 0
    private var errMsg = ""
    private var title = ""
    private var artist = ""

    /** 当前音量（供淡入淡出/被 duck 后恢复用）。 */
    private var volume = 1f

    /**
     * 用户想不想听。缓冲期间如果按了暂停，就不要再自作主张开始 ——
     * onPrepared 是无条件会回调的，不记住意图就会出现「暂停了它自己又放起来」。
     */
    private var wantPlay = false

    /** 前台服务类型要不要按「媒体播放」上报（Android 14 起媒体通知要求）。 */
    fun isActive(): Boolean = playing || loading

    private val ticker = object : Runnable {
        override fun run() {
            if (!playing) return
            pushProgress()
            main.postDelayed(this, TICK_MS)
        }
    }

    private fun startTicker() {
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, TICK_MS)
    }

    private fun stopTicker() = main.removeCallbacks(ticker)

    private fun newPlayer(): MediaPlayer {
        val p = MediaPlayer()
        // 让 MediaPlayer 自己跟着播放状态持锁：比手工 acquire/release 更不容易漏
        applyAudioAttrs(p)
        attachListeners(p)
        player = p
        return p
    }

    private fun applyAudioAttrs(p: MediaPlayer) {
        // reset() 会把这些属性清掉，所以每次 configure 都重新盖一遍
        try { p.setWakeMode(svc, PowerManager.PARTIAL_WAKE_LOCK) } catch (_: Exception) { }
        try {
            p.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
        } catch (_: Exception) { }
    }

    private fun attachListeners(p: MediaPlayer) {
        p.setOnPreparedListener { mp ->
            prepared = true
            loading = false
            durationMs = try { mp.duration } catch (e: Exception) { 0 }
            if (durationMs < 0) durationMs = 0
            try { mp.setVolume(volume, volume) } catch (_: Exception) { }
            if (wantPlay) {
                try { mp.start() } catch (_: Exception) { }
                playing = true
                musicWantsWake = true
                syncWake()
                ensureSession()
                updateSession()
                postMediaNotification()
                pushState()
                startTicker()
            } else {
                playing = false
                updateSession()
                postMediaNotification()
                pushState()
            }
        }
        p.setOnCompletionListener {
            playing = false
            musicWantsWake = false
            syncWake()
            stopTicker()
            updateSession()
            // 顺序 / 单曲循环 / 随机由 JS 决定，它拿到消息后会自己送下一首过来
            pushState()
            eval("window.__mpDone&&window.__mpDone()")
        }
        p.setOnErrorListener { _, what, extra ->
            loading = false
            playing = false
            musicWantsWake = false
            syncWake()
            prepared = false
            stopTicker()
            errMsg = "播放失败($what/$extra)"
            pushState()
            cancelMediaNotification()
            true
        }
    }

    /** 送一首新歌上去。name/artist 只用于通知栏和锁屏。 */
    fun load(url: String, name: String, artist: String) = onMain {
        title = name
        this.artist = artist
        errMsg = ""
        durationMs = 0
        prepared = false
        loading = true
        playing = false
        wantPlay = true

        val p = try { player ?: newPlayer() } catch (e: Exception) {
            loading = false
            errMsg = "无法初始化播放器"
            pushState()
            return@onMain
        }
        try {
            p.reset()
            applyAudioAttrs(p)
            attachListeners(p)
            p.setDataSource(url)
            p.prepareAsync()
        } catch (e: Exception) {
            loading = false
            errMsg = e.message ?: "音频加载失败"
            pushState()
            return@onMain
        }

        requestFocus()
        // 还在缓冲就把通知和锁先立起来 —— 缓冲往往才是最长的一段
        musicWantsWake = true
        syncWake()
        ensureSession()
        updateSession()
        postMediaNotification()
        pushState()
    }

    fun play() = onMain { playInternal() }

    private fun playInternal() {
        val p = player ?: return
        if (!prepared) { wantPlay = true; return }
        wantPlay = true
        try {
            p.start()
            playing = true
            musicWantsWake = true
            syncWake()
            requestFocus()
            updateSession()
            postMediaNotification()
            pushState()
            startTicker()
        } catch (_: Exception) { }
    }

    fun pause() = onMain { pauseInternal(false) }

    private fun pauseInternal(byFocus: Boolean) {
        val p = player
        if (p != null && prepared) {
            try { p.pause() } catch (_: Exception) { }
        }
        wantPlay = false
        playing = false
        // 被外人抢走焦点时先别放锁，等它回来还要接着放
        if (!byFocus) { musicWantsWake = false; syncWake() }
        stopTicker()
        updateSession()
        postMediaNotification()
        pushState()
    }

    fun toggle() = onMain { if (playing) pauseInternal(false) else playInternal() }

    fun seekTo(ms: Int) = onMain {
        val p = player ?: return@onMain
        try {
            p.seekTo(ms.coerceIn(0, if (durationMs > 0) durationMs else ms))
            pushProgress()
        } catch (_: Exception) { }
    }

    fun setVolume(v: Float) = onMain {
        volume = v.coerceIn(0f, 1f)
        try { player?.setVolume(volume, volume) } catch (_: Exception) { }
    }

    /** 停止播放并撤掉媒体通知（保留 MediaPlayer 以便下次复用）。 */
    fun stop() = onMain {
        try { player?.stop() } catch (_: Exception) { }
        try { player?.reset() } catch (_: Exception) { }
        prepared = false
        loading = false
        playing = false
        wantPlay = false
        durationMs = 0
        musicWantsWake = false
        syncWake()
        stopTicker()
        abandonFocus()
        cancelMediaNotification()
        updateSession()
        pushState()
    }

    /** 给 JS 主动查询用（息屏回来、重进音乐页时对一下状态）。 */
    fun stateJson(): String = try {
        JSONObject().apply {
            put("playing", playing)
            put("loading", loading)
            put("prepared", prepared)
            put("pos", position())
            put("dur", durationMs)
            put("err", errMsg)
            put("title", title)
            put("artist", artist)
        }.toString()
    } catch (e: Exception) { "{}" }

    private fun position(): Int = try {
        val p = player
        if (p != null && prepared) p.currentPosition else 0
    } catch (e: Exception) { 0 }

    private fun pushState() {
        syncForeground()
        eval("window.__mpState&&window.__mpState(${JSONObject.quote(stateJson())})")
    }

    /**
     * 「在不在放东西」变了才去动前台服务类型。
     * Android 14 起媒体通知需要 mediaPlayback 类型，而重报类型是相对贵的操作，
     * 所以只在真正跨过界线时做一次。
     */
    private var lastFgActive = false
    private fun syncForeground() {
        val a = isActive()
        if (a == lastFgActive) return
        lastFgActive = a
        try { svc.refreshForegroundType() } catch (_: Exception) { }
    }

    private fun pushProgress() {
        val pos = position()
        eval("window.__mpProgress&&window.__mpProgress($pos,$durationMs)")
    }

    /* ======================================================================
     *  MediaSession：锁屏 / 耳机线控 / 蓝牙
     * ====================================================================== */

    private fun ensureSession() {
        if (session != null) return
        try {
            val s = MediaSession(svc, "EllyFloat")
            s.setCallback(object : MediaSession.Callback() {
                override fun onPlay() = cmd(CMD_PLAY)
                override fun onPause() = cmd(CMD_PAUSE)
                override fun onStop() = cmd(CMD_STOP)
                override fun onSkipToNext() = cmd(CMD_NEXT)
                override fun onSkipToPrevious() = cmd(CMD_PREV)
                override fun onSeekTo(pos: Long) = seekTo(pos.toInt())
            })
            s.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or
                        MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            s.isActive = true
            session = s
        } catch (_: Exception) { }
    }

    private fun updateSession() {
        val s = session ?: return
        try {
            s.setMetadata(
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifBlank { "爱莉希雅" })
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                    .build()
            )
            val st = if (playing) PlaybackState.STATE_PLAYING
            else if (loading) PlaybackState.STATE_BUFFERING
            else PlaybackState.STATE_PAUSED
            s.setPlaybackState(
                PlaybackState.Builder()
                    .setActions(
                        PlaybackState.ACTION_PLAY or
                                PlaybackState.ACTION_PAUSE or
                                PlaybackState.ACTION_PLAY_PAUSE or
                                PlaybackState.ACTION_SKIP_TO_NEXT or
                                PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                                PlaybackState.ACTION_SEEK_TO or
                                PlaybackState.ACTION_STOP
                    )
                    .setState(st, position().toLong(), if (playing) 1f else 0f)
                    .build()
            )
        } catch (_: Exception) { }
    }

    /** 通知栏 / 耳机 / 锁屏上的操作统一回抛给 JS，由 JS 决定具体怎么切。 */
    private fun cmd(c: String) {
        when (c) {
            CMD_TOGGLE -> toggle()
            CMD_PLAY -> play()
            CMD_PAUSE -> pause()
            CMD_STOP -> {
                stop()
                eval("window.__mpCmd&&window.__mpCmd('stop')")
            }
            CMD_NEXT -> eval("window.__mpCmd&&window.__mpCmd('next')")
            CMD_PREV -> eval("window.__mpCmd&&window.__mpCmd('prev')")
        }
    }

    /** FloatService.onStartCommand 收到通知按钮的 Intent 后转交过来。 */
    fun onAction(c: String?) {
        if (c.isNullOrBlank()) return
        onMain { cmd(c) }
    }

    /* ======================================================================
     *  媒体通知
     * ====================================================================== */

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val nm = svc.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_MUSIC) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_MUSIC, "爱莉希雅正在播放", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "显示当前播放的歌曲，并提供上一首 / 暂停 / 下一首"
                    setShowBadge(false)
                }
            )
        } catch (_: Exception) { }
    }

    private fun actionIcon(icon: Int, label: String, cmd: String, code: Int): Notification.Action {
        val i = Intent(svc, FloatService::class.java)
            .setAction(ACTION_MEDIA)
            .putExtra(EXTRA_CMD, cmd)
        val pi = PendingIntent.getService(
            svc, code, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Action.Builder(Icon.createWithResource(svc, icon), label, pi).build()
    }

    private fun buildMediaNotification(): Notification? {
        val s = session ?: return null
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val content = PendingIntent.getActivity(
            svc, 0,
            Intent(svc, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            piFlags
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(svc, CHANNEL_MUSIC)
        else
            @Suppress("DEPRECATION") Notification.Builder(svc)

        b.setContentTitle(title.ifBlank { "爱莉希雅" })
            .setContentText(artist.ifBlank { "正在播放" })
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(content)
            .setOngoing(playing)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setPriority(Notification.PRIORITY_LOW)

        b.addAction(actionIcon(android.R.drawable.ic_media_previous, "上一首", CMD_PREV, 21))
        b.addAction(
            if (playing) actionIcon(android.R.drawable.ic_media_pause, "暂停", CMD_TOGGLE, 22)
            else actionIcon(android.R.drawable.ic_media_play, "播放", CMD_TOGGLE, 22)
        )
        b.addAction(actionIcon(android.R.drawable.ic_media_next, "下一首", CMD_NEXT, 23))
        b.addAction(actionIcon(android.R.drawable.ic_menu_close_clear_cancel, "停止", CMD_STOP, 24))

        try {
            // MediaStyle + MediaSession：锁屏和蓝牙才会认这是媒体通知
            val style = Notification.MediaStyle()
                .setMediaSession(s.sessionToken)
                .setShowActionsInCompactView(0, 1, 2)
            b.setStyle(style)
        } catch (_: Exception) { }
        return b.build()
    }

    private fun postMediaNotification() {
        val n = try { buildMediaNotification() } catch (_: Exception) { null } ?: return
        try {
            ensureChannel()
            (svc.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTI_MUSIC, n)
        } catch (_: Exception) { }
    }

    private fun cancelMediaNotification() {
        try {
            (svc.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(NOTI_MUSIC)
        } catch (_: Exception) { }
    }

    /* ======================================================================
     *  语音合成
     *  - 系统引擎：交给 Android 的 TextToSpeech（音色由系统的 TTS 引擎决定）
     *  - 自建引擎：JS 拼好 OpenAI 兼容的 /audio/speech 请求，原生负责下载 + 播放，
     *    这样息屏也能出声（走的是和音乐同一条原生通道）
     * ====================================================================== */

    private inner class SpeechReq(val url: String, val headers: String, val body: String)

    private var sysTts: TextToSpeech? = null
    private var sysTtsReady = false
    private var sysTtsPending: String? = null

    private var speechPlayer: MediaPlayer? = null
    private val speechQueue = ArrayDeque<SpeechReq>()
    private var speechBusy = false          // 正在下载或正在播，队列不能空转
    private var speechSeq = 0               // 每次 stop 自增，用来丢弃过期的下载结果

    private var prefetchReq: SpeechReq? = null
    private var prefetchFile: File? = null
    private var prefetchBusy = false
    private var prefetchFailed = false

    private fun ttsDir(): File = File(svc.cacheDir, "tts").apply { try { mkdirs() } catch (_: Exception) { } }

    /** 每次开始一轮新的朗读就清一次，免得缓存目录无限长。 */
    private fun cleanTtsDir() {
        try {
            ttsDir().listFiles()?.forEach { it.delete() }
        } catch (_: Exception) { }
    }

    /* ---- 系统引擎 ---- */

    fun speakSystem(text: String, rate: Float) = onMain {
        speechWantsWake = true
        syncWake()
        if (sysTtsReady) {
            doSpeakSystem(text, rate)
            return@onMain
        }
        sysTtsPending = text
        if (sysTts == null) {
            sysTts = TextToSpeech(svc) { status ->
                main.post {
                    if (status == TextToSpeech.SUCCESS) {
                        sysTtsReady = true
                        try {
                            sysTts?.language = Locale.CHINA
                            sysTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                                override fun onStart(id: String?) { eval("window.__ttsStart&&window.__ttsStart()") }
                                override fun onError(id: String?) { finishSystemSpeech() }
                                override fun onDone(id: String?) { finishSystemSpeech() }
                            })
                        } catch (_: Exception) { }
                        val t = sysTtsPending
                        sysTtsPending = null
                        if (!t.isNullOrBlank()) doSpeakSystem(t, lastSysRate)
                    } else {
                        speechWantsWake = false
                        syncWake()
                        eval("window.__ttsError&&window.__ttsError('系统语音引擎不可用')")
                    }
                }
            }
        }
    }

    private var lastSysRate = 1f

    private fun doSpeakSystem(text: String, rate: Float) {
        lastSysRate = rate
        try {
            sysTts?.setSpeechRate(rate.coerceIn(0.3f, 3f))
            val id = "elly_" + System.currentTimeMillis()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                sysTts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
            } else {
                @Suppress("DEPRECATION") sysTts?.speak(text, TextToSpeech.QUEUE_FLUSH, null)
            }
        } catch (_: Exception) { finishSystemSpeech() }
    }

    private fun finishSystemSpeech() {
        main.post {
            speechWantsWake = false
            syncWake()
            eval("window.__ttsDone&&window.__ttsDone()")
        }
    }

    fun stopSystem() = onMain {
        try { sysTts?.stop() } catch (_: Exception) { }
        speechWantsWake = false
        syncWake()
    }

    /* ---- 自建（AI）引擎 ---- */

    fun speakAi(url: String, headers: String, body: String) = onMain {
        if (speechQueue.isEmpty() && !speechBusy) cleanTtsDir()
        speechQueue.addLast(SpeechReq(url, headers, body))
        speechWantsWake = true
        syncWake()
        pumpSpeech()
        prefetchSpeech()
    }

    private fun downloadToFile(req: SpeechReq): File? = try {
        val conn = (URL(req.url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15000
            readTimeout = 60000
            doOutput = true
            doInput = true
        }
        try {
            JSONObject(req.headers).keys().forEach { k ->
                conn.setRequestProperty(k, JSONObject(req.headers).getString(k))
            }
        } catch (_: Exception) { }
        if (conn.getRequestProperty("Content-Type") == null) {
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        conn.outputStream.use { it.write(req.body.toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        if (code !in 200..299) {
            val msg = conn.errorStream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
            conn.disconnect()
            throw IllegalStateException("语音接口 $code ${msg.take(120)}")
        }
        val f = File(ttsDir(), "s" + System.currentTimeMillis() + "_" + (0..999).random() + ".mp3")
        conn.inputStream.use { input -> FileOutputStream(f).use { input.copyTo(it) } }
        conn.disconnect()
        if (f.length() <= 0L) { f.delete(); null } else f
    } catch (e: Exception) {
        lastSpeechErr = e.message ?: "语音下载失败"
        null
    }

    private var lastSpeechErr = ""
    private var speechPlaying = false

    private fun pumpSpeech() {
        if (speechPlaying) return

        // 预取好的就直接放，省掉一段下载等待
        val head = speechQueue.firstOrNull()
        if (head != null && prefetchFile != null && prefetchReq == head) {
            val f = prefetchFile!!
            prefetchFile = null
            prefetchReq = null
            prefetchFailed = false
            speechQueue.removeFirst()
            playSpeechFile(f)
            prefetchSpeech()
            return
        }

        if (speechBusy) return
        val req = speechQueue.removeFirstOrNull() ?: return
        speechBusy = true
        val seq = speechSeq
        Thread {
            val f = downloadToFile(req)
            main.post {
                speechBusy = false
                if (seq != speechSeq) { f?.delete(); return@post }   // 期间被 stop 了
                if (f == null) {
                    eval("window.__ttsError&&window.__ttsError(${JSONObject.quote(lastSpeechErr)})")
                    if (speechQueue.isEmpty()) { speechWantsWake = false; syncWake() }
                    pumpSpeech()
                } else {
                    playSpeechFile(f)
                    prefetchSpeech()
                }
            }
        }.start()
    }

    /** 趁上一句在播，把下一句先下好。 */
    private fun prefetchSpeech() {
        if (prefetchBusy || prefetchFile != null || prefetchFailed) return
        val req = speechQueue.firstOrNull() ?: return
        prefetchReq = req
        prefetchBusy = true
        val seq = speechSeq
        Thread {
            val f = downloadToFile(req)
            main.post {
                prefetchBusy = false
                if (seq != speechSeq) { f?.delete(); return@post }
                if (f == null) { prefetchFailed = true; prefetchReq = null; return@post }
                prefetchFile = f
            }
        }.start()
    }

    private fun playSpeechFile(f: File) {
        try {
            val p = speechPlayer ?: MediaPlayer().also { speechPlayer = it }
            p.reset()
            try {
                p.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
            } catch (_: Exception) { }
            p.setWakeMode(svc, PowerManager.PARTIAL_WAKE_LOCK)
            p.setOnPreparedListener { mp ->
                try { mp.start() } catch (_: Exception) { }
                speechPlaying = true
                eval("window.__ttsStart&&window.__ttsStart()")
            }
            p.setOnCompletionListener {
                speechPlaying = false
                f.delete()
                if (speechQueue.isEmpty() && prefetchFile == null) {
                    speechWantsWake = false
                    syncWake()
                    eval("window.__ttsDone&&window.__ttsDone()")
                } else {
                    pumpSpeech()
                }
            }
            p.setOnErrorListener { _, _, _ ->
                speechPlaying = false
                f.delete()
                eval("window.__ttsError&&window.__ttsError('语音播放失败')")
                if (speechQueue.isEmpty()) { speechWantsWake = false; syncWake() }
                true
            }
            p.setDataSource(f.absolutePath)
            p.prepareAsync()
        } catch (e: Exception) {
            speechPlaying = false
            try { f.delete() } catch (_: Exception) { }
            eval("window.__ttsError&&window.__ttsError(${JSONObject.quote(e.message ?: "语音播放失败")})")
        }
    }

    /** 打断当前朗读，清空队列。 */
    fun stopSpeech() = onMain {
        speechSeq++
        speechQueue.clear()
        prefetchReq = null
        prefetchBusy = false
        prefetchFailed = false
        prefetchFile?.delete()
        prefetchFile = null
        try { speechPlayer?.reset() } catch (_: Exception) { }
        speechPlaying = false
        speechBusy = false
        cleanTtsDir()
        speechWantsWake = false
        syncWake()
    }

    /* ====================================================================== */

    private fun eval(js: String) {
        try { wv.evaluateJavascript(js, null) } catch (_: Exception) { }
    }

    fun destroy() {
        stopTicker()
        try { player?.release() } catch (_: Exception) { }
        player = null
        try { speechPlayer?.release() } catch (_: Exception) { }
        speechPlayer = null
        try { sysTts?.shutdown() } catch (_: Exception) { }
        sysTts = null
        try { session?.release() } catch (_: Exception) { }
        session = null
        speechWantsWake = false
        musicWantsWake = false
        syncWake()
        abandonFocus()
        cancelMediaNotification()
    }
}
