package com.elly.assistant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class FloatService : Service() {

    companion object {
        @Volatile
        var instance: FloatService? = null
            private set

        /** 由 PickImageActivity 写入，JS 通过 Android.getPickedImage() 取走。 */
        @Volatile
        var pendingPickedImage: String? = null
        var pendingPickedFile: String? = null

        /** 引导页会检查这个渠道有没有被用户关掉，所以得给 PermissionBridge 用。 */
        const val CHANNEL_ID = "elly_float"
        private const val NOTI_ID = 1

        /** 截屏前藏悬浮层后，留给合成器生效的时间。 */
        private const val SHOT_HIDE_DELAY_MS = 180L
    }

    private var wm: WindowManager? = null
    private var webView: WebView? = null
    private var params: WindowManager.LayoutParams? = null

    /**
     * 原生音频引擎（第二批）：音乐与语音合成都走它。
     * 以前音乐是 WebView 里的 <audio>，浮窗没有 Activity，WebView 一直「不可见」，
     * Chromium 不申请唤醒锁、息屏就挂起渲染进程 —— 所以电池白名单也救不了息屏续播。
     */
    private var audio: AudioEngine? = null

    /** 当前是不是处于截屏授权 / 投屏状态（决定前台服务类型要不要带 mediaProjection）。 */
    private var projectionOn = false

    fun audio(): AudioEngine? = audio

    private var bubble: ImageView? = null
    private var bubbleBmp: Bitmap? = null
    private var minimized = false
    private var savedFlags = 0
    private var savedRect: IntArray? = null

    /**
     * 聊天窗当前是不是已经藏起来了。
     * 以前这里用 minimized/capsuleMode 兼职判断，但两个 minimize 入口都是
     * 「先置位再 hideWebView()」，导致存档分支永远进不去，savedFlags 一直是 0：
     * 恢复后丢掉 FLAG_NOT_TOUCH_MODAL（外面点不动）和 FLAG_LAYOUT_NO_LIMITS
     * （位置被系统夹回固定角落）。所以单独用一个标志，语义才干净。
     */
    private var winHidden = false

    /** 窗口矩形写盘用的节流令牌，拖动时避免每帧都写 SharedPreferences。 */
    private val persistTick = Runnable { persistWinRect() }

    private val prefs get() = getSharedPreferences("elly", MODE_PRIVATE)

    /** 聊天窗最小尺寸：太小就没法用了，同时也会让 JS 那边的缩放下限算错。 */
    private fun minWindowSize(): Int = (120 * resources.displayMetrics.density).toInt()

    /**
     * 布局基准尺寸（物理像素）：页面永远是按这个尺寸排版然后再整体缩放的，
     * 所以它必须是常量。否则一缩放就重新排版，「像电脑窗口那样等比缩放」就没了。
     */
    private fun baseSize(): IntArray {
        val dm = resources.displayMetrics
        return intArrayOf(
            min((dm.widthPixels * 0.92).toInt(), (400 * dm.density).toInt()),
            min((dm.heightPixels * 0.78).toInt(), (660 * dm.density).toInt())
        )
    }

    /* 迷你播放器（独立系统悬浮窗，缩成小球后依然可见可拖动） */
    private var miniBar: LinearLayout? = null
    private var miniName: TextView? = null
    private var miniArtist: TextView? = null
    private var miniLyric: TextView? = null
    private var miniPlay: TextView? = null
    private var miniMode: TextView? = null
    private var miniPrev: TextView? = null
    private var miniNext: TextView? = null
    private var miniParams: WindowManager.LayoutParams? = null
    private var miniVisible = false

    /* 迷你条收起状态：只留音符小方块，点音符可展开 / 收起 */
    private var miniDisc: TextView? = null
    private var miniInfo: LinearLayout? = null
    private var miniClose: TextView? = null
    private var miniCollapsed = false
    private var miniExpandedWidth = 0

    /** 迷你条还没建出来时先存着歌词，建好立刻补上。 */
    private var miniLyricText = ""
    private var bubbleParams: WindowManager.LayoutParams? = null

    /* 状态胶囊：处理中（转圈）/ 有新消息（右上角红点） */
    private var capsule: View? = null
    private var capsuleParams: WindowManager.LayoutParams? = null
    private var capsuleText: TextView? = null
    private var capsuleSpinner: Ring? = null
    private var capsuleDot: View? = null
    private var capsuleDots: TextView? = null
    private var capsuleDotsPhase = 0
    private var capsuleMode = false

    private val capsuleDotsTick = object : Runnable {
        override fun run() {
            if (!capsuleMode || capsuleDots == null) return
            capsuleDotsPhase = (capsuleDotsPhase % 3) + 1
            capsuleDots?.text = "·".repeat(capsuleDotsPhase)
            main.postDelayed(this, 420L)
        }
    }

    /* 屏幕翻译：原位覆盖层（穿透不挡操作） + 「还原」小按钮（可点） */
    private var transOverlay: View? = null
    private var transOverlayParams: WindowManager.LayoutParams? = null
    private var transChip: View? = null
    private var transChipParams: WindowManager.LayoutParams? = null

    /** 截屏前临时藏起来的悬浮窗，用完要原样放回去。 */
    private class SavedWin(
        val v: View,
        val p: WindowManager.LayoutParams,
        val x: Int,
        val y: Int,
        val a: Float
    )

    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        startForegroundSafe()
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        try {
            setupWebView()
            audio = AudioEngine(this, webView!!)
            addFloatView()
            // 先用内置图垫底，再用用户实际头像覆盖，避免小球退化成系统默认图标
            setBubbleAvatar("file:///android_asset/avatar.jpg")
            val saved = getSharedPreferences("elly", MODE_PRIVATE).getString("avatar", null)
            if (!saved.isNullOrBlank()) setBubbleAvatar(saved)
        } catch (e: Exception) {
            // 没有悬浮窗权限或系统拒绝添加窗口时，避免直接崩溃。
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 媒体通知 / 耳机线控发过来的动作
        if (intent?.action == AudioEngine.ACTION_MEDIA) {
            audio?.onAction(intent.getStringExtra(AudioEngine.EXTRA_CMD))
        }
        // 允许系统在内存回收后尽量重建浮窗；用户点击关闭仍会 stopSelf。
        return START_STICKY
    }

    /**
     * 关键：@JavascriptInterface 的方法运行在 WebView 的 JS 线程，
     * 而 View / WindowManager 只能在主线程操作，否则会抛
     * "Only the original thread that created a view hierarchy can touch its views"，
     * 表现为「点缩小后应用直接被杀掉」「拖边缘调不了大小」。
     * 所以所有会碰 UI 的入口都统一切回主线程。
     */
    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }

    private fun overlayType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    /* ---------------- 前台通知 ---------------- */
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "爱莉希雅浮窗",
                NotificationManager.IMPORTANCE_LOW
            )
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            piFlags
        )
        return builder
            .setContentTitle("爱莉希雅")
            .setContentText("正在陪你哦~ ♪（点开回到聊天）")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW)
            .build()
    }

    private fun startForegroundSafe() {
        ensureChannel()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(
                    NOTI_ID, buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(NOTI_ID, buildNotification())
            }
        } catch (_: Exception) {
            // 某些系统在通知权限被拒时仍允许 FGS 运行。
        }
    }

    /**
     * Android 14 起，调用 MediaProjectionManager.getMediaProjection 之前，
     * 服务必须已经是带 mediaProjection 类型的前台服务，否则直接抛 SecurityException。
     */
    private fun upgradeForegroundForProjection() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        projectionOn = true
        refreshForegroundType()
    }

    /**
     * 重新上报前台服务类型。
     *
     * Android 14 起，发媒体通知要求应用跑着 mediaPlayback 类型的前台服务，
     * 所以开始播歌时要把这个类型加上，停了再撒掉。
     * 这整段都是「锦上添花」：任何一步失败都安静退回原样，
     * 服务本身、播放本身都不依赖它。
     */
    fun refreshForegroundType() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        try {
            var t = 0
            if (Build.VERSION.SDK_INT >= 34) {
                t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            }
            if (projectionOn) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            if (audio?.isActive() == true) {
                t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            }
            if (t == 0) {
                startForeground(NOTI_ID, buildNotification())
            } else {
                startForeground(NOTI_ID, buildNotification(), t)
            }
        } catch (_: Exception) {
            // 例如从后台被限制启动 FGS：不影响播放，媒体通知退化成普通通知而已。
            // 回退时也不能把 mediaProjection 带进去 —— Android 14 上拿到授权前声明它会被拒。
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    startForeground(NOTI_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                } else {
                    startForeground(NOTI_ID, buildNotification())
                }
            } catch (_: Exception) { }
        }
    }

    /* ---------------- WebView ---------------- */
    private fun setupWebView() {
        val wv = WebView(this)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            setAllowFileAccessFromFileURLs(true)
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            loadsImagesAutomatically = true
            useWideViewPort = true
        }
        wv.setBackgroundColor(0x00000000)
        wv.isVerticalScrollBarEnabled = false
        wv.isHorizontalScrollBarEnabled = false
        wv.webViewClient = WebViewClient()
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean = true
        }
        wv.addJavascriptInterface(JsBridge(this, wv), "Android")
        wv.addJavascriptInterface(PermissionBridge(this), "Perm")
        wv.loadUrl("file:///android_asset/index.html")
        webView = wv
    }

    /* ---------------- 聊天窗口 ---------------- */
    private fun addFloatView() {
        val wv = webView ?: return
        val dm = resources.displayMetrics
        val b = baseSize()
        val w = b[0]
        val h = b[1]

        val first = clampRect(
            prefs.getInt("win_x", (dm.widthPixels - w) / 2),
            prefs.getInt("win_y", (dm.heightPixels - h) / 3),
            prefs.getInt("win_w", w),
            prefs.getInt("win_h", h)
        )

        val p = WindowManager.LayoutParams(
            first[2], first[3], overlayType(),
            // FLAG_NOT_TOUCH_MODAL：窗口之外的点按要透传给后面的 App，
            // 少了它，缩小之后周围一整片都会「看得见点不到」。
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = first[0]
            y = first[1]
        }
        params = p
        savedFlags = p.flags
        winRect = first
        wm?.addView(wv, p)
    }

    fun moveBy(dx: Int, dy: Int) = runOnMain {
        val p = params ?: return@runOnMain
        val wv = webView ?: return@runOnMain
        val dm = resources.displayMetrics
        p.x = (p.x + dx).coerceIn(0, (dm.widthPixels - p.width).coerceAtLeast(0))
        p.y = (p.y + dy).coerceIn(0, (dm.heightPixels - p.height).coerceAtLeast(0))
        winRect = intArrayOf(p.x, p.y, p.width, p.height)
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
        schedulePersistWinRect()
        pushRectToJs(false)
    }

    fun resize(w: Int, h: Int) = runOnMain {
        val p = params ?: return@runOnMain
        applyRect(p.x, p.y, w, h)
    }

    fun windowRectJson(): String {
        val p = params ?: return "{}"
        return try {
            val b = baseSize()
            JSONObject().apply {
                put("x", p.x); put("y", p.y); put("w", p.width); put("h", p.height)
                put("bw", b[0]); put("bh", b[1])
                put("hidden", winHidden)
            }.toString()
        } catch (e: Exception) { "{}" }
    }

    /**
     * 把请求的矩形夹进「屏幕范围 + 最小尺寸」里。
     * 纯计算，不碰 View，所以 JS 线程也能直接调，返回值就是最终一定生效的结果。
     */
    private fun clampRect(x: Int, y: Int, w: Int, h: Int): IntArray {
        val dm = resources.displayMetrics
        val sw = dm.widthPixels
        val sh = dm.heightPixels
        val minSize = minWindowSize()
        val nw = w.coerceIn(minSize, max(minSize, sw))
        val nh = h.coerceIn(minSize, max(minSize, sh))
        val nx = x.coerceIn(0, (sw - nw).coerceAtLeast(0))
        val ny = y.coerceIn(0, (sh - nh).coerceAtLeast(0))
        return intArrayOf(nx, ny, nw, nh)
    }

    /**
     * JS 按住边缘缩放时回调，坐标与尺寸均为物理像素。
     *
     * 返回「真正生效」的矩形（JSON）。JS 用这个回执反推缩放比，
     * 就不用猜原生会不会夹它 —— 面板和窗口从此不可能对不上。
     */
    fun setWindowRect(x: Int, y: Int, w: Int, h: Int): String {
        val r = clampRect(x, y, w, h)
        runOnMain { applyClamped(r) }
        return rectJson(r)
    }

    private fun applyRect(x: Int, y: Int, w: Int, h: Int) {
        applyClamped(clampRect(x, y, w, h))
    }

    private fun applyClamped(r: IntArray) = runOnMain {
        val p = params ?: return@runOnMain
        val wv = webView ?: return@runOnMain
        p.x = r[0]; p.y = r[1]; p.width = r[2]; p.height = r[3]
        winRect = intArrayOf(r[0], r[1], r[2], r[3])
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
        schedulePersistWinRect()
        // 缩放过程中 JS 已经拿到 setWindowRect 的回执了，这里不必每帧都推，
        // 免得 evaluateJavascript 把拖动手感拖垮。
        pushRectToJs(false)
    }

    private fun rectJson(r: IntArray): String = try {
        val b = baseSize()
        JSONObject().apply {
            put("x", r[0]); put("y", r[1]); put("w", r[2]); put("h", r[3])
            // bw/bh 是布局基准，JS 用 ZOOM = w / bw 就能得到精确的缩放比。
            put("bw", b[0]); put("bh", b[1])
        }.toString()
    } catch (e: Exception) { "{}" }

    /** 当前窗口矩形缓存（物理像素），JS 那边对账时读它。 */
    @Volatile
    private var winRect: IntArray? = null

    private var lastRectPushAt = 0L

    private fun pushRectToJs() = pushRectToJs(true)

    /**
     * 拖拽时每帧都回推一次会让拖动手感发飘（evaluateJavascript 有开销），
     * 所以拖动路径走节流，结构性变化（显示 / 缩放落定）走立即。
     */
    private fun pushRectToJs(force: Boolean) {
        val r = winRect ?: return
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastRectPushAt < 100L) return
        lastRectPushAt = now
        val json = "window.__onWinRect&&window.__onWinRect(${rectJson(r)});"
        try { webView?.evaluateJavascript(json, null) } catch (_: Exception) { }
    }

    /* ---------------- 窗口 / 小球位置记忆 ---------------- */

    private fun schedulePersistWinRect() {
        main.removeCallbacks(persistTick)
        main.postDelayed(persistTick, 400)
    }

    private fun persistWinRect() {
        val r = winRect ?: return
        try {
            prefs.edit()
                .putInt("win_x", r[0]).putInt("win_y", r[1])
                .putInt("win_w", r[2]).putInt("win_h", r[3])
                .apply()
        } catch (_: Exception) { }
    }

    private fun persistBubblePos() {
        val p = bubbleParams ?: return
        try { prefs.edit().putInt("bubble_x", p.x).putInt("bubble_y", p.y).apply() } catch (_: Exception) { }
    }

    /** JS 直接给定绝对坐标（左边缘拖拽用），同样返回生效后的矩形。 */
    fun moveWindowTo(x: Int, y: Int): String {
        val p = params ?: return "{}"
        val r = clampRect(x, y, p.width, p.height)
        runOnMain { applyClamped(r) }
        return rectJson(r)
    }

    /** 尺寸限制给 JS，让它在自己那侧就算对，不必依赖原生兜底。 */
    fun windowLimitsJson(): String = try {
        val dm = resources.displayMetrics
        val b = baseSize()
        JSONObject().apply {
            put("minW", minWindowSize())
            put("minH", minWindowSize())
            put("maxW", dm.widthPixels)
            put("maxH", dm.heightPixels)
            put("bw", b[0])
            put("bh", b[1])
            put("density", dm.density.toDouble())
        }.toString()
    } catch (e: Exception) { "{}" }

    /* ---------------- 隐藏 / 恢复聊天窗（小球与胶囊共用） ---------------- */

    /** 把聊天窗藏起来：alpha=0 + 移出屏幕 + 不可触摸，三重保证一定不在截屏里。 */
    private fun hideWebView() {
        val p = params ?: return
        val wv = webView ?: return
        // 只在「窗口本来就在台面上」的时候记档。
        // 用 winHidden 判断而不是 minimized/capsuleMode：那两个是业务状态，
        // 而这里关心的是「当前到底可不可见」，两回事。
        if (!winHidden) {
            savedFlags = p.flags
            savedRect = intArrayOf(p.x, p.y, p.width, p.height)
        }
        winHidden = true
        p.alpha = 0f
        p.x = -p.width - 500
        p.flags = p.flags or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
    }

    private fun showWebView() {
        val p = params ?: return
        val wv = webView ?: return
        // 优先用台面上的存档；万一没存过（比如被截屏流程直接藏掉），
        // 退回到持久化的位置，总比被系统夹到固定角落强。
        savedRect?.let { p.x = it[0]; p.y = it[1]; p.width = it[2]; p.height = it[3] }
            ?: restorePersistedWinRect(p)
        if (savedFlags != 0) p.flags = savedFlags
        winHidden = false
        p.alpha = 1f
        winRect = intArrayOf(p.x, p.y, p.width, p.height)
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
        try { wv.requestLayout(); wv.invalidate() } catch (_: Exception) { }
        pushRectToJs()
    }

    private fun restorePersistedWinRect(p: WindowManager.LayoutParams) {
        val r = clampRect(
            prefs.getInt("win_x", p.x),
            prefs.getInt("win_y", p.y),
            prefs.getInt("win_w", p.width),
            prefs.getInt("win_h", p.height)
        )
        p.x = r[0]; p.y = r[1]; p.width = r[2]; p.height = r[3]
    }

    /* ---------------- 最小化成悬浮小球 ---------------- */
    fun minimizeToBubble() = runOnMain {
        if (minimized) return@runOnMain
        minimized = true
        hideCapsuleInternal()
        capsuleMode = false
        hideWebView()
        addBubble()
    }

    fun restoreFromBubble() = runOnMain {
        if (!minimized) return@runOnMain
        minimized = false
        removeBubble()
        if (!capsuleMode) showWebView()
    }

    private fun addBubble() {
        if (bubble != null) return
        val dm = resources.displayMetrics
        val size = (58 * dm.density).toInt()

        val iv = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setOval(0, 0, view.width, view.height)
                }
            }
            val ring = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFFFFFFF.toInt())
                setStroke((2 * dm.density).toInt(), 0x59FFFFFF)
            }
            background = ring
            contentDescription = "爱莉希雅"
        }
        bubbleBmp?.let { iv.setImageBitmap(it) } ?: run {
            try { iv.setImageResource(android.R.drawable.sym_def_app_icon) } catch (_: Exception) { }
        }

        val p = WindowManager.LayoutParams(
            size, size, overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // 小球位置也要记住，否则拖走之后再最小化，它又跳回默认点。
            x = prefs.getInt("bubble_x", dm.widthPixels - size - (10 * dm.density).toInt())
                .coerceIn(0, (dm.widthPixels - size).coerceAtLeast(0))
            y = prefs.getInt("bubble_y", (dm.heightPixels * 0.60).toInt())
                .coerceIn(0, (dm.heightPixels - size).coerceAtLeast(0))
        }
        attachBubbleTouch(iv, p, dm)
        bubble = iv
        bubbleParams = p
        try { wm?.addView(iv, p) } catch (_: Exception) { bubble = null; bubbleParams = null }
    }

    private fun attachBubbleTouch(v: View, p: WindowManager.LayoutParams, dm: android.util.DisplayMetrics) {
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        v.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.rawX; downY = ev.rawY
                    startX = p.x; startY = p.y; moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX
                    val dy = ev.rawY - downY
                    if (abs(dx) > 8 || abs(dy) > 8) moved = true
                    p.x = (startX + dx).toInt().coerceIn(0, (dm.widthPixels - p.width).coerceAtLeast(0))
                    p.y = (startY + dy).toInt().coerceIn(0, (dm.heightPixels - p.height).coerceAtLeast(0))
                    try { wm?.updateViewLayout(v, p) } catch (_: Exception) { }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (!moved) restoreFromBubble() else persistBubblePos()
                    true
                }
                else -> false
            }
        }
    }

    private fun removeBubble() {
        val b = bubble ?: return
        try { wm?.removeView(b) } catch (_: Exception) { }
        bubble = null
        bubbleParams = null
    }

    /* ---------------- 状态胶囊（处理中 / 有新消息） ---------------- */

    /**
     * 收起成小胶囊。翻译 / AI 总结这类「需要看干净屏幕」的操作先叫它，
     * 用户就不会被浮窗遮住，处理完再在胶囊右上角冒红点提醒。
     */
    fun minimizeToCapsule(text: String) = runOnMain {
        if (minimized) { minimized = false; removeBubble() }
        capsuleMode = true
        hideWebView()
        showCapsuleInternal(text, "busy")
    }

    fun restoreFromCapsule() = runOnMain {
        if (!capsuleMode) return@runOnMain
        capsuleMode = false
        hideCapsuleInternal()
        showWebView()
    }

    /** 从 JS 更新胶囊文案 / 状态。state: busy | done | idle */
    fun updateCapsule(text: String, state: String) = runOnMain {
        if (!capsuleMode) return@runOnMain
        applyCapsule(text, state)
        if (state == "done") vibrateShort()
    }

    /** 当前是不是已经收成了胶囊（JS 用来决定要不要亮红点）。 */
    fun isCapsuleMode(): Boolean = capsuleMode

    private fun showCapsuleInternal(text: String, state: String) = runOnMain {
        if (capsule == null) {
            val built = buildCapsule() ?: return@runOnMain
            capsule = built.first
            attachDrag(built.first, built.second) { restoreFromCapsuleWithNotify() }
            capsuleParams = built.second
            try { wm?.addView(built.first, built.second) } catch (_: Exception) {
                capsule = null; capsuleParams = null; return@runOnMain
            }
        } else {
            capsuleParams?.let { p ->
                try { wm?.updateViewLayout(capsule!!, p) } catch (_: Exception) { }
            }
        }
        applyCapsule(text, state)
    }

    private fun applyCapsule(text: String, state: String) {
        capsuleText?.text = if (text.isBlank()) "正在处理…" else text
        val busy = state == "busy"
        capsuleSpinner?.visibility = if (busy) View.VISIBLE else View.GONE
        if (busy) {
            capsuleSpinner?.start()
            startCapsuleDots()
        } else {
            capsuleSpinner?.stop()
            stopCapsuleDots()
        }
        capsuleDot?.visibility = if (state == "done") View.VISIBLE else View.GONE
    }

    private fun hideCapsuleInternal() = runOnMain {
        val c = capsule ?: return@runOnMain
        capsuleSpinner?.stop()
        try { wm?.removeView(c) } catch (_: Exception) { }
        capsule = null
        capsuleParams = null
        capsuleText = null
        capsuleSpinner = null
        capsuleDot = null
        capsuleDots = null
        stopCapsuleDots()
    }

    private fun startCapsuleDots() {
        main.removeCallbacks(capsuleDotsTick)
        capsuleDotsPhase = 0
        capsuleDotsTick.run()
    }

    private fun stopCapsuleDots() {
        main.removeCallbacks(capsuleDotsTick)
        capsuleDots?.text = ""
    }

    /** 点胶囊 → 展开浮窗，并告诉 JS 把结果展示出来。 */
    private fun restoreFromCapsuleWithNotify() {
        restoreFromCapsule()
        js("window.__capsuleClick&&window.__capsuleClick()")
    }

    /** 构建胶囊：圆角粉底 + 头像/转圈 + 文案，右上角留一个红点位。 */
    private fun buildCapsule(): Pair<View, WindowManager.LayoutParams>? {
        val dm = resources.displayMetrics
        val d = dm.density
        fun dp(v: Int) = (v * d).toInt()

        val root = android.widget.FrameLayout(this)

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(7), dp(6), dp(14), dp(6))
            background = GradientDrawable().apply {
                cornerRadius = dp(20).toFloat()
                setColor(0xF7FFF0F5.toInt())
                setStroke(dp(1), 0x66FF9A9E)
            }
            elevation = dp(8).toFloat()
        }

        val iconBox = android.widget.FrameLayout(this)
        val disc = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setOval(0, 0, view.width, view.height)
                }
            }
            bubbleBmp?.let { setImageBitmap(it) } ?: run {
                try { setImageResource(android.R.drawable.sym_def_app_icon) } catch (_: Exception) { }
            }
        }
        iconBox.addView(disc, android.widget.FrameLayout.LayoutParams(dp(24), dp(24)))

        val ring = Ring(dp(24)).apply { visibility = View.VISIBLE }
        iconBox.addView(ring, android.widget.FrameLayout.LayoutParams(dp(24), dp(24)))
        capsuleSpinner = ring
        bar.addView(iconBox, LinearLayout.LayoutParams(dp(24), dp(24)))

        val label = TextView(this).apply {
            setTextColor(0xFF7A4358.toInt())
            textSize = 12f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            text = "正在处理…"
        }
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        lp.leftMargin = dp(8)
        bar.addView(label, lp)
        capsuleText = label

        val dots = TextView(this).apply {
            setTextColor(0xFFD6336C.toInt())
            textSize = 13f
            // 点数变化时不能让 TextView 换行，否则胶囊会在第三个点出现时变高。
            // 固定单行、固定宽高，并关闭字体额外留白，让加载动画只改变内容而不改变胶囊尺寸。
            setSingleLine(true)
            maxLines = 1
            setHorizontallyScrolling(true)
            gravity = Gravity.CENTER
            includeFontPadding = false
            minWidth = dp(18)
            text = "·"
        }
        bar.addView(dots, LinearLayout.LayoutParams(dp(18), dp(18)))
        capsuleDots = dots

        root.addView(bar, android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
        ))

        val dot = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFE8365D.toInt())
                setStroke(dp(1), 0xFFFFFFFF.toInt())
            }
            visibility = View.GONE
        }
        val dotLp = android.widget.FrameLayout.LayoutParams(dp(11), dp(11))
        dotLp.gravity = Gravity.TOP or Gravity.END
        dotLp.topMargin = dp(1)
        dotLp.rightMargin = dp(1)
        root.addView(dot, dotLp)
        capsuleDot = dot

        val width = min((210 * d).toInt(), dm.widthPixels - (24 * d).toInt())
            .coerceAtLeast((110 * d).toInt())
        val p = WindowManager.LayoutParams(
            width,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (dm.widthPixels - width - (10 * d).toInt()).coerceAtLeast(0)
            y = (dm.heightPixels * 0.74).toInt()
        }
        return root to p
    }

    /** 通用拖动 + 单击（胶囊、覆盖层等复用）。 */
    private fun attachDrag(v: View, p: WindowManager.LayoutParams, onClick: () -> Unit) {
        val dm = resources.displayMetrics
        var downX = 0f; var downY = 0f
        var startX = 0; var startY = 0
        var moved = false
        v.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.rawX; downY = ev.rawY
                    startX = p.x; startY = p.y; moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX
                    val dy = ev.rawY - downY
                    if (abs(dx) > 10 || abs(dy) > 10) moved = true
                    val vw = if (v.width > 0) v.width else p.width
                    val vh = if (v.height > 0) v.height else (40 * dm.density).toInt()
                    p.x = (startX + dx).toInt().coerceIn(0, (dm.widthPixels - vw).coerceAtLeast(0))
                    p.y = (startY + dy).toInt().coerceIn(0, (dm.heightPixels - vh).coerceAtLeast(0))
                    try { wm?.updateViewLayout(v, p) } catch (_: Exception) { }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!moved) onClick(); true }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    /** 胶囊上的转圈（自己画，不依赖任何库）。 */
    private inner class Ring(sizePx: Int) : View(this) {
        private val stroke = (sizePx / 8f).coerceAtLeast(2f)
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = stroke
            strokeCap = Paint.Cap.ROUND
            color = 0xFFD6336C.toInt()
        }
        private var angle = 0f
        private val tick = object : Runnable {
            override fun run() {
                angle = (angle + 14f) % 360f
                invalidate()
                postDelayed(this, 33)
            }
        }
        fun start() { removeCallbacks(tick); post(tick) }
        fun stop() { removeCallbacks(tick) }
        override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val r = min(width, height) / 2f - stroke
            if (r <= 0f) return
            val box = RectF(width / 2f - r, height / 2f - r, width / 2f + r, height / 2f + r)
            canvas.drawArc(box, angle, 265f, false, paint)
        }
    }

    private fun vibrateShort() {
        try {
            val v = getSystemService(VIBRATOR_SERVICE) as android.os.Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(android.os.VibrationEffect.createOneShot(35, 60))
            } else {
                @Suppress("DEPRECATION") v.vibrate(35L)
            }
        } catch (_: Exception) { }
    }

    private fun js(code: String) {
        try { webView?.evaluateJavascript(code, null) } catch (_: Exception) { }
    }

    /* ---------------- 屏幕翻译：原位覆盖 ---------------- */

    /**
     * 把译文直接贴在原文位置上。
     * json: {mode:'translated'|'bilingual', items:[{x,y,w,h,t}]}，坐标是屏幕物理像素。
     */
    fun showTranslateOverlay(json: String) = runOnMain {
        removeTranslateOverlay()
        val dm = resources.displayMetrics
        val d = dm.density
        fun dp(v: Int) = (v * d).toInt()

        val mode: String
        val items: JSONArray
        try {
            val o = JSONObject(json)
            mode = o.optString("mode", "translated")
            items = o.optJSONArray("items") ?: JSONArray()
        } catch (_: Exception) {
            return@runOnMain
        }
        if (items.length() == 0) return@runOnMain

        val root = android.widget.FrameLayout(this)
        root.isClickable = false
        root.isFocusable = false

        val bilingual = mode == "bilingual"

        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: continue
            val x = it.optInt("x"); val y = it.optInt("y")
            val w = it.optInt("w"); val h = it.optInt("h")
            val t = it.optString("t", "")
            if (w <= 0 || h <= 0 || t.isBlank()) continue

            if (bilingual) {
                // 双语：原文保留不动，只给它加一条粉色下划线做标记，
                // 译文做成小牌子贴在下面（原文仍然看得见）。
                val line = View(this).apply { setBackgroundColor(0xD9D6336C.toInt()) }
                val lineLp = android.widget.FrameLayout.LayoutParams(w, dp(2).coerceAtLeast(1))
                lineLp.leftMargin = x
                lineLp.topMargin = (y + h - dp(2)).coerceAtLeast(0)
                lineLp.gravity = Gravity.TOP or Gravity.START
                root.addView(line, lineLp)

                val chip = TextView(this).apply {
                    text = t
                    setTextColor(0xFFD6336C.toInt())
                    textSize = ((h / d) * 0.62f).coerceIn(8f, 14f)
                    background = GradientDrawable().apply {
                        cornerRadius = dp(4).toFloat()
                        setColor(0xF2FFF5F8.toInt())
                    }
                    setPadding(dp(3), dp(1), dp(3), dp(1))
                    maxLines = 3
                    ellipsize = TextUtils.TruncateAt.END
                }
                val chipW = min((w * 1.6f).toInt() + dp(8), dm.widthPixels - x - dp(4))
                    .coerceAtLeast(dp(40))
                val chipLp = android.widget.FrameLayout.LayoutParams(
                    chipW, android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
                )
                chipLp.leftMargin = x
                chipLp.topMargin = y + h + dp(1)
                chipLp.gravity = Gravity.TOP or Gravity.START
                root.addView(chip, chipLp)
            } else {
                // 仅译文：用近乎不透明的暖白底把原文盖掉，换成粉色译文。
                val tv = TextView(this).apply {
                    text = t
                    setTextColor(0xFFD6336C.toInt())
                    textSize = ((h / d) * 0.70f).coerceIn(9f, 20f)
                    background = GradientDrawable().apply {
                        cornerRadius = dp(3).toFloat()
                        setColor(0xF7FFF0F5.toInt())
                    }
                    setPadding(dp(2), dp(1), dp(2), dp(1))
                    maxLines = 3
                    ellipsize = TextUtils.TruncateAt.END
                    gravity = Gravity.CENTER_VERTICAL
                }
                val lp = android.widget.FrameLayout.LayoutParams(w, h)
                lp.leftMargin = x
                lp.topMargin = y
                lp.gravity = Gravity.TOP or Gravity.START
                root.addView(tv, lp)
            }
        }

        val p = WindowManager.LayoutParams(
            dm.widthPixels, dm.heightPixels, overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0; y = 0
        }
        transOverlay = root
        transOverlayParams = p
        try { wm?.addView(root, p) } catch (_: Exception) {
            transOverlay = null; transOverlayParams = null; return@runOnMain
        }
        addTranslateChip()
    }

    /** 覆盖层是「穿透」的（不挡你滑动），所以单独给一个能点的「还原」。 */
    private fun addTranslateChip() {
        val dm = resources.displayMetrics
        val d = dm.density
        fun dp(v: Int) = (v * d).toInt()
        val chip = TextView(this).apply {
            text = "还原屏幕"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(8))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                colors = intArrayOf(0xFFD6336C.toInt(), 0xFFFF9A9E.toInt())
                orientation = GradientDrawable.Orientation.LEFT_RIGHT
                gradientType = GradientDrawable.LINEAR_GRADIENT
            }
            elevation = dp(6).toFloat()
        }
        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(48)
        }
        chip.setOnClickListener { hideTranslateOverlayWithNotify() }
        attachDrag(chip, p) { hideTranslateOverlayWithNotify() }
        transChip = chip
        transChipParams = p
        try { wm?.addView(chip, p) } catch (_: Exception) { transChip = null; transChipParams = null }
    }

    fun hideTranslateOverlay() = runOnMain { hideTranslateOverlayWithNotify() }

    private fun hideTranslateOverlayWithNotify() {
        removeTranslateOverlay()
        js("window.__transOverlayClosed&&window.__transOverlayClosed()")
    }

    private fun removeTranslateOverlay() {
        transOverlay?.let { try { wm?.removeView(it) } catch (_: Exception) { } }
        transChip?.let { try { wm?.removeView(it) } catch (_: Exception) { } }
        transOverlay = null
        transOverlayParams = null
        transChip = null
        transChipParams = null
    }

    /* ---------------- 迷你播放器悬浮窗 ---------------- */

    /**
     * 独立于聊天窗的系统级小播放条：缩成小球之后依然看得见、拖得动。
     * 现在多了上一首 / 下一首，以及一行歌词（歌词由 JS 算好送过来，
     * 原生不解析 LRC —— 免得两边各存一份歌词对不上）。
     */
    fun showMiniPlayer(name: String, artist: String, playing: Boolean) = runOnMain {
        val bar = miniBar ?: buildMiniBar().also { miniBar = it }
        miniName?.text = if (name.isBlank()) "正在播放" else name
        miniArtist?.text = if (artist.isBlank()) "—" else artist
        miniArtist?.visibility = if (miniLyric?.text.isNullOrBlank()) View.VISIBLE else View.GONE
        miniPlay?.text = if (playing) "❚❚" else "▶"
        if (!miniVisible) {
            addMiniBar(bar)
        } else {
            val p = miniParams
            if (p != null) try { wm?.updateViewLayout(bar, p) } catch (_: Exception) { }
        }
    }

    /** 迷你播放条上那一行歌词（没有歌词时传空串，会自动退回显示歌手）。 */
    fun setMiniLyric(text: String) = runOnMain {
        miniLyricText = text
        val el = miniLyric ?: return@runOnMain
        // 同一句不用反复刷，减少无谓的重绘
        if (el.text.toString() == text) return@runOnMain
        el.text = text
        el.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
        miniArtist?.visibility = if (text.isBlank()) View.VISIBLE else View.GONE
    }

    /** 迷你播放条上的播放方式图标（🔁 / 🔂 / 🔀）。 */
    fun setMiniPlayMode(icon: String) = runOnMain {
        val el = miniMode ?: return@runOnMain
        if (el.text.toString() == icon) return@runOnMain
        el.text = icon
    }

    fun hideMiniPlayer() = runOnMain {
        val bar = miniBar ?: return@runOnMain
        try { wm?.removeView(bar) } catch (_: Exception) { }
        miniName = null
        miniArtist = null
        miniLyric = null
        miniPlay = null
        miniMode = null
        miniPrev = null
        miniNext = null
        miniDisc = null
        miniInfo = null
        miniClose = null
        miniCollapsed = false
        miniExpandedWidth = 0
        miniBar = null
        miniParams = null
        miniVisible = false
    }

    /** 按当前收起状态隐藏 / 显示除音符以外的部分，并同步窗口宽度。 */
    private fun applyMiniCollapsed() {
        val bar = miniBar ?: return
        val vis = if (miniCollapsed) View.GONE else View.VISIBLE
        miniInfo?.visibility = vis
        miniPrev?.visibility = vis
        miniMode?.visibility = vis
        miniPlay?.visibility = vis
        miniNext?.visibility = vis
        miniClose?.visibility = vis
        val p = miniParams ?: return
        p.width = if (miniCollapsed) WindowManager.LayoutParams.WRAP_CONTENT else miniExpandedWidth
        try { wm?.updateViewLayout(bar, p) } catch (_: Exception) { }
    }

    /** 点音符图标：在「完整播放条」和「只有音符的小方框」之间切换。 */
    private fun toggleMiniCollapse() {
        miniCollapsed = !miniCollapsed
        applyMiniCollapsed()
    }

    private fun buildMiniBar(): LinearLayout {
        val dm = resources.displayMetrics
        val d = dm.density
        fun dp(v: Int) = (v * d).toInt()

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(7), dp(6), dp(7))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(0xF7FFF0F5.toInt())
                setStroke(dp(1), 0x40FF9A9E)
            }
            elevation = dp(8).toFloat()
        }

        val disc = TextView(this).apply {
            text = "♪"
            gravity = Gravity.CENTER
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 15f
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                colors = intArrayOf(0xFFFF9A9E.toInt(), 0xFFFECFEF.toInt())
                gradientType = GradientDrawable.LINEAR_GRADIENT
                orientation = GradientDrawable.Orientation.TL_BR
            }
        }
        bar.addView(disc, LinearLayout.LayoutParams(dp(30), dp(30)))

        val info = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val name = TextView(this).apply {
            setTextColor(0xFF4A2C3A.toInt())
            textSize = 12f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            text = "未播放"
        }
        val artist = TextView(this).apply {
            setTextColor(0xFFA87B8E.toInt())
            textSize = 10f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            text = "—"
            visibility = if (miniLyricText.isBlank()) View.VISIBLE else View.GONE
        }
        val lyric = TextView(this).apply {
            setTextColor(0xFFD6336C.toInt())
            textSize = 10f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.MARQUEE
            marqueeRepeatLimit = -1
            isSingleLine = true
            isSelected = true          // TextView 跑马灯得先 selected
            text = miniLyricText
            visibility = if (miniLyricText.isBlank()) View.GONE else View.VISIBLE
        }
        info.addView(name)
        info.addView(artist)
        info.addView(lyric)
        val infoLp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        infoLp.leftMargin = dp(8)
        infoLp.rightMargin = dp(4)
        bar.addView(info, infoLp)

        fun circle(txt: String, bg: Int, fg: Int, sz: Int): TextView = TextView(this).apply {
            text = txt
            gravity = Gravity.CENTER
            setTextColor(fg)
            textSize = if (sz >= 32) 12f else 13f
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(bg)
            }
        }

        val prev = circle("⏮", 0x26FF9A9E, 0xFFD6336C.toInt(), 32)
        bar.addView(prev, LinearLayout.LayoutParams(dp(32), dp(32)))

        val mode = TextView(this).apply {
            text = "🔁"
            gravity = Gravity.CENTER
            setTextColor(0xFFD6336C.toInt())
            textSize = 13f
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0x1AFF9A9E)
            }
        }
        val modeLp = LinearLayout.LayoutParams(dp(30), dp(30))
        modeLp.leftMargin = dp(4)
        bar.addView(mode, modeLp)

        val play = circle("▶", 0xFFD6336C.toInt(), 0xFFFFFFFF.toInt(), 32)
        val playLp = LinearLayout.LayoutParams(dp(32), dp(32))
        playLp.leftMargin = dp(4)
        bar.addView(play, playLp)

        val next = circle("⏭", 0x26FF9A9E, 0xFFD6336C.toInt(), 32)
        val nextLp = LinearLayout.LayoutParams(dp(32), dp(32))
        nextLp.leftMargin = dp(4)
        bar.addView(next, nextLp)

        val close = TextView(this).apply {
            text = "×"
            gravity = Gravity.CENTER
            setTextColor(0xFFA87B8E.toInt())
            textSize = 16f
        }
        val closeLp = LinearLayout.LayoutParams(dp(30), dp(30))
        closeLp.leftMargin = dp(2)
        bar.addView(close, closeLp)

        miniName = name
        miniArtist = artist
        miniLyric = lyric
        miniPlay = play
        miniMode = mode
        miniPrev = prev
        miniNext = next
        miniDisc = disc
        miniInfo = info
        miniClose = close
        miniCollapsed = false

        // 这四个按钮直接打本地引擎：息屏、聊天窗收起时也能用
        prev.setOnClickListener { audio?.onAction("prev") }
        next.setOnClickListener { audio?.onAction("next") }
        play.setOnClickListener { audio?.onAction("toggle") }
        // 播放方式由 JS 决定（它才是歌单的主人），这里只负责把意图报上去
        mode.setOnClickListener {
            webView?.evaluateJavascript("window.__miniMode&&window.__miniMode()", null)
        }
        close.setOnClickListener {
            hideMiniPlayer()
            webView?.evaluateJavascript("window.__miniClose&&window.__miniClose()", null)
        }
        return bar
    }

    private fun addMiniBar(bar: View) {
        val dm = resources.displayMetrics
        val d = dm.density
        val width = min((370 * d).toInt(), dm.widthPixels - (24 * d).toInt()).coerceAtLeast((210 * d).toInt())
        val p = WindowManager.LayoutParams(
            width,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = ((dm.widthPixels - width) / 2).coerceAtLeast(0)
            y = (dm.heightPixels - (170 * d).toInt()).coerceAtLeast(0)
        }
        attachMiniTouch(bar, p, dm)
        miniExpandedWidth = width
        miniParams = p
        try {
            wm?.addView(bar, p)
            miniVisible = true
        } catch (_: Exception) {
            miniBar = null
            miniParams = null
            miniVisible = false
        }
    }

    private fun attachMiniTouch(v: View, p: WindowManager.LayoutParams, dm: android.util.DisplayMetrics) {
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        v.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = ev.rawX; downY = ev.rawY
                    startX = p.x; startY = p.y; moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = ev.rawX - downX
                    val dy = ev.rawY - downY
                    if (abs(dx) > 8 || abs(dy) > 8) moved = true
                    val vw = if (v.width > 0) v.width else p.width
                    val vh = if (v.height > 0) v.height else (48 * dm.density).toInt()
                    p.x = (startX + dx).toInt().coerceIn(0, (dm.widthPixels - vw).coerceAtLeast(0))
                    p.y = (startY + dy).toInt().coerceIn(0, (dm.heightPixels - vh).coerceAtLeast(0))
                    try { wm?.updateViewLayout(v, p) } catch (_: Exception) { }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) {
                        val disc = miniDisc
                        val onDisc = disc != null && disc.width > 0 &&
                                ev.x >= disc.left && ev.x <= disc.right &&
                                ev.y >= disc.top && ev.y <= disc.bottom
                        if (onDisc) {
                            // 点音符 → 收起 / 展开旁边的按钮
                            toggleMiniCollapse()
                        } else {
                            // 点播放条其它位置 → 还原窗口并打开音乐页
                            restoreFromBubble()
                            webView?.evaluateJavascript("window.__miniOpen&&window.__miniOpen()", null)
                        }
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    /* ---------------- 头像 ---------------- */
    @Volatile
    private var avatarSeq = 0

    fun setBubbleAvatar(url: String?, fit: String? = null) {
        if (url.isNullOrBlank()) return
        // 只让最后一次请求生效：内置垫底图不会覆盖后到的真实头像
        val seq = ++avatarSeq
        Thread {
            val bmp = loadAvatarBitmap(url, fit ?: "center")
            if (bmp != null && seq == avatarSeq) {
                main.post {
                    bubbleBmp = bmp
                    bubble?.setImageBitmap(bmp)
                }
            }
        }.start()
    }
    private fun loadAvatarBitmap(url: String, fit: String = "center"): Bitmap? {
        return try {
            val raw: Bitmap? = when {
                url.startsWith("data:image") -> {
                    val b64 = url.substringAfter(',', "")
                    val bytes = Base64.decode(b64, Base64.DEFAULT)
                    decodeSampled(bytes)
                }
                url.startsWith("file:///android_asset/") -> {
                    val name = url.removePrefix("file:///android_asset/")
                    val bytes = assets.open(name).use { it.readBytes() }
                    decodeSampled(bytes)
                }
                url.startsWith("http") -> downloadBytes(url)?.let { decodeSampled(it) }
                else -> null
            }
            raw?.let { circularBitmap(it, 180, fit) }
        } catch (t: Throwable) {
            // 注意：大图解码失败是 OutOfMemoryError（Error 而非 Exception），
            // 必须捕 Throwable，否则线程直接死掉、小球永远停在垫底图。
            null
        }
    }

    /**
     * 先只读尺寸算 inSampleSize，再真正解码。
     * 用户填的网图常是 2000px+/3MB 的大图，直接解码要 20MB+ 内存，
     * 在浮窗服务里很容易 OOM；采样后只有几百 KB。
     */
    private fun decodeSampled(bytes: ByteArray, maxDim: Int = 512): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxDim && bounds.outHeight / (sample * 2) >= maxDim) {
            sample *= 2
        }
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        return try {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        } catch (t: Throwable) {
            null
        }
    }

    private fun downloadBytes(url: String): ByteArray? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 12000
                doInput = true
                instanceFollowRedirects = true
                // 部分图床对无 UA/Referer 的请求会直接 403。
                setRequestProperty(
                    "User-Agent",
                    "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 " +
                            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
                )
                try {
                    val u = URL(url)
                    setRequestProperty("Referer", u.protocol + "://" + u.host + "/")
                } catch (_: Exception) { }
                setRequestProperty("Accept", "image/*,*/*;q=0.8")
            }
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.use { it.readBytes() }
        } catch (t: Throwable) {
            null
        } finally {
            try { conn?.disconnect() } catch (_: Exception) { }
        }
    }

    /**
     * 网页端用的是 `border-radius:50%` + `object-fit:cover`，数学上等价于
     * “取以短边为边长的内接正方形，再缩成圆”。这里保持一致，
     * 并支持 fit = top/center/bottom 控制竖向取景位置（人像照脸通常在上部）。
     */
    private fun circularBitmap(src: Bitmap, size: Int, fit: String = "center"): Bitmap {
        val side = min(src.width, src.height)
        val x = (src.width - side) / 2
        val maxY = max(0, src.height - side)
        val y = when (fit) {
            "top" -> 0
            "bottom" -> maxY
            else -> maxY / 2
        }.coerceIn(0, maxY)
        val square = Bitmap.createBitmap(src, x, y, side, side)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val shader = BitmapShader(square, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        // BitmapShader 默认把位图像素 1:1 铺到画布上，不缩放的话只会画出左上角
        // 很小一块（也就是“小球只显示一部分”的真正原因）。补上缩放矩阵后，
        // 效果才等价于网页的 object-fit:cover + border-radius:50%。
        shader.setLocalMatrix(Matrix().apply {
            val k = size.toFloat() / side
            setScale(k, k)
        })
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.shader = shader
        c.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        return out
    }

    /* ---------------- 截屏（无障碍优先，MediaProjection 兜底） ---------------- */
    @Volatile
    private var projResultCode = 0

    @Volatile
    private var projData: Intent? = null

    private var pendingShotCb: ((String?) -> Unit)? = null

    /** JS 入口：结果通过 window.__shotDone(dataUrl|null) 回传。
     *  截之前先把所有悬浮层藏起来，不然拍进去的就是她自己。 */
    fun requestScreenshot() {
        runOnMain {
            captureScreenInternal { data ->
                main.post { deliverShot(data) }
            }
        }
    }

    /**
     * 截一帧之前，把「聊天窗 + 小球 + 胶囊 + 音乐条 + 译文覆盖层」全部藏掉，
     * 抓完立即恢复。返回的 lambda 是恢复函数（幂等）。
     */
    private fun hideOverlaysForShot(): () -> Unit {
        val dm = resources.displayMetrics
        val list = ArrayList<SavedWin>()

        fun stash(v: View?, p: WindowManager.LayoutParams?) {
            if (v == null || p == null || v.parent == null) return
            list.add(SavedWin(v, p, p.x, p.y, p.alpha))
            p.alpha = 0f
            p.x = -dm.widthPixels - 800
            try { wm?.updateViewLayout(v, p) } catch (_: Exception) { }
        }

        stash(webView, params)
        stash(bubble, bubbleParams)
        stash(miniBar, miniParams)
        stash(capsule, capsuleParams)
        stash(transOverlay, transOverlayParams)
        stash(transChip, transChipParams)

        var restored = false
        return {
            if (!restored) {
                restored = true
                for (s in list) {
                    s.p.alpha = s.a
                    s.p.x = s.x
                    s.p.y = s.y
                    try { wm?.updateViewLayout(s.v, s.p) } catch (_: Exception) { }
                }
            }
        }
    }

    /** 允许 PermissionBridge 在原生策略拒绝截屏时结束 JS 等待。 */
    fun deliverScreenshot(dataUrl: String?) = runOnMain { deliverShot(dataUrl) }

    private fun deliverShot(dataUrl: String?) {
        val js = if (dataUrl.isNullOrBlank()) {
            "window.__shotDone&&window.__shotDone(null)"
        } else {
            "window.__shotDone&&window.__shotDone(" + JSONObject.quote(dataUrl) + ")"
        }
        try { webView?.evaluateJavascript(js, null) } catch (_: Exception) { }
    }

    fun onProjectionGranted(code: Int, data: Intent) {
        projResultCode = code
        projData = data
        upgradeForegroundForProjection()
        val cb = pendingShotCb
        pendingShotCb = null
        if (cb != null) main.post { shootHidden({ done -> doProjectionShot(done) }, cb) }
    }

    fun onProjectionDenied() {
        projData = null
        val cb = pendingShotCb
        pendingShotCb = null
        cb?.invoke(null)
    }

    private fun captureScreenInternal(cb: (String?) -> Unit) {
        val svc = EllyAccessibilityService.instance
        if (svc != null && svc.canShot()) {
            shootHidden({ done -> svc.takeScreenShot { d -> done(d) } }) { data ->
                // 无障碍失败（部分系统界面/安全限制）→ 回退到录屏通道
                if (!data.isNullOrBlank()) cb(data) else projectionShot(cb)
            }
            return
        }
        projectionShot(cb)
    }

    /** 藏好悬浮层 → 等一下让合成器真正生效 → 抓一帧 → 立刻恢复。 */
    private fun shootHidden(grab: ((String?) -> Unit) -> Unit, cb: (String?) -> Unit) {
        val restore = hideOverlaysForShot()
        main.postDelayed({
            grab { data ->
                restore()
                cb(data)
            }
        }, SHOT_HIDE_DELAY_MS)
    }

    private fun projectionShot(cb: (String?) -> Unit) {
        if (projData == null) {
            // 还没授权过：拉起授权页，回来再继续
            pendingShotCb = cb
            try {
                startActivity(
                    Intent(this, ScreenCaptureActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (t: Throwable) {
                pendingShotCb = null
                cb(null)
                return
            }
            main.postDelayed({
                if (pendingShotCb === cb) {
                    pendingShotCb = null
                    cb(null)
                }
            }, 60000)
            return
        }
        shootHidden({ done -> doProjectionShot(done) }, cb)
    }

    private fun doProjectionShot(cb: (String?) -> Unit) {
        val data = projData
        val code = projResultCode
        if (data == null) { cb(null); return }

        var projection: MediaProjection? = null
        var virtual: VirtualDisplay? = null
        var reader: ImageReader? = null
        var finished = false

        fun done(result: String?) {
            if (finished) return
            finished = true
            try { virtual?.release() } catch (_: Exception) { }
            try { projection?.stop() } catch (_: Exception) { }
            try { reader?.close() } catch (_: Exception) { }
            main.post { cb(result) }
        }

        try {
            val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = mpm.getMediaProjection(code, data)
            if (projection == null) {
                // Android 14+ 授权是一次性的，复用失败就清掉，下次重新申请
                projData = null
                done(null)
                return
            }
            val dm = resources.displayMetrics
            val w = dm.widthPixels
            val h = dm.heightPixels
            reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
            reader.setOnImageAvailableListener({ r ->
                var bmp: Bitmap? = null
                try {
                    val img = r.acquireLatestImage()
                    if (img != null) {
                        bmp = ScreenShotUtil.imageToBitmap(img)
                        img.close()
                    }
                } catch (t: Throwable) { bmp = null }
                val url = bmp?.let { ScreenShotUtil.toDataUrl(it) }
                try { bmp?.recycle() } catch (_: Throwable) { }
                done(url)
            }, main)
            virtual = projection.createVirtualDisplay(
                "elly-shot", w, h, dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface, null, null
            )
            // 抓帧兜底超时
            main.postDelayed({ done(null) }, 6000)
        } catch (t: Throwable) {
            projData = null
            done(null)
        }
    }

    /* ---------------- 相册回调 ---------------- */
    fun deliverPickedImage(dataUrl: String?) {
        main.post {
            if (dataUrl.isNullOrBlank()) {
                webView?.evaluateJavascript("window.__imgPickFailed&&window.__imgPickFailed()", null)
            } else {
                pendingPickedImage = dataUrl
                webView?.evaluateJavascript("window.__imgPicked&&window.__imgPicked()", null)
            }
        }
    }

    /** 选中的文件以 JSON 字符串回传：{name, mime, size, ok, text} */
    fun deliverPickedFile(json: String?) {
        main.post {
            if (json.isNullOrBlank()) {
                webView?.evaluateJavascript("window.__filePickFailed&&window.__filePickFailed()", null)
            } else {
                pendingPickedFile = json
                webView?.evaluateJavascript("window.__filePicked&&window.__filePicked()", null)
            }
        }
    }

    fun closeFloat() = runOnMain { stopSelf() }

    override fun onDestroy() {
        instance = null
        try { audio?.destroy() } catch (_: Exception) { }
        audio = null
        removeBubble()
        miniBar?.let { bar -> try { wm?.removeView(bar) } catch (_: Exception) { } }
        miniBar = null
        miniParams = null
        miniVisible = false
        capsuleSpinner?.stop()
        capsule?.let { c -> try { wm?.removeView(c) } catch (_: Exception) { } }
        capsule = null
        capsuleParams = null
        capsuleText = null
        capsuleSpinner = null
        capsuleDot = null
        removeTranslateOverlay()
        webView?.let { wv ->
            try { wm?.removeView(wv) } catch (_: Exception) { }
            try { wv.destroy() } catch (_: Exception) { }
        }
        webView = null
        super.onDestroy()
    }
}
