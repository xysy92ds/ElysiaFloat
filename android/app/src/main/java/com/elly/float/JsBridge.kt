package com.elly.assistant

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min

class JsBridge(private val ctx: Context, private val webView: WebView) {

    private val audio get() = (ctx as? FloatService)?.audio()
    private val activeRequests = ConcurrentHashMap<String, HttpURLConnection>()

    /* ---------- 存储 ---------- */
    @JavascriptInterface
    fun getValue(key: String, def: String?): String? {
        return try {
            ctx.getSharedPreferences("elly", Context.MODE_PRIVATE).getString(key, def)
        } catch (e: Exception) { def }
    }

    @JavascriptInterface
    fun setValue(key: String, value: String) {
        try {
            ctx.getSharedPreferences("elly", Context.MODE_PRIVATE)
                .edit().putString(key, value).apply()
        } catch (e: Exception) {}
    }

    /* ---------- 音乐离线缓存 ---------- */
    /**
     * 优先使用用户可见的公共 Music/ElysiaFloat/cache；没有公共存储权限时回退到
     * App 私有目录。缓存文件本身不保存临时签名 URL，只保存音频和本地索引。
     */
    private fun musicCacheDir(): File {
        val publicDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "ElysiaFloat/cache")
        val publicAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager() else true
        return if (publicAllowed && (publicDir.exists() || publicDir.mkdirs())) publicDir
        else File(ctx.filesDir, "music-cache").apply { mkdirs() }
    }
    private fun musicCacheKey(id: String): String = MessageDigest.getInstance("SHA-256")
        .digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(32)
    private fun audioHeader(bytes: ByteArray): Boolean {
        if (bytes.size >= 3 && bytes[0] == 'I'.code.toByte() && bytes[1] == 'D'.code.toByte() && bytes[2] == '3'.code.toByte()) return true
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && (bytes[1].toInt() and 0xE0) == 0xE0) return true
        if (bytes.size >= 4 && bytes[0] == 'O'.code.toByte() && bytes[1] == 'g'.code.toByte() && bytes[2] == 'g'.code.toByte() && bytes[3] == 'S'.code.toByte()) return true
        if (bytes.size >= 4 && bytes[0] == 'f'.code.toByte() && bytes[1] == 'L'.code.toByte() && bytes[2] == 'a'.code.toByte() && bytes[3] == 'C'.code.toByte()) return true
        return false
    }
    private fun followMusicUrl(start: String): Pair<HttpURLConnection, String> {
        var current = start
        repeat(6) {
            val u = URL(current)
            if (u.protocol != "http" && u.protocol != "https") throw IllegalStateException("音频地址协议不受支持")
            val c = (u.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000; readTimeout = 90000; instanceFollowRedirects = false
                setRequestProperty("User-Agent", "ElysiaFloat/0.6")
                setRequestProperty("Accept", "audio/*,application/octet-stream;q=0.8,*/*;q=0.1")
            }
            val code = c.responseCode
            if (code in 200..299) return c to current
            if (code in 301..308) {
                val location = c.getHeaderField("Location") ?: throw IllegalStateException("HTTP $code 且没有 Location")
                current = URL(u, location).toString()
                c.disconnect()
            } else {
                c.disconnect()
                throw IllegalStateException("HTTP $code")
            }
        }
        throw IllegalStateException("音频重定向次数过多")
    }

    @JavascriptInterface
    fun getCachedMusic(id: String): String {
        return try {
            val f = File(musicCacheDir(), musicCacheKey(id) + ".mp3")
            if (f.isFile && f.length() > 0) f.absolutePath else ""
        } catch (_: Exception) { "" }
    }

    @JavascriptInterface
    fun deleteCachedMusic(id: String): Boolean = try {
        File(musicCacheDir(), musicCacheKey(id) + ".mp3").let { !it.exists() || it.delete() }
    } catch (_: Exception) { false }

    @JavascriptInterface
    fun getMusicCacheInfo(): String = try {
        val dir = musicCacheDir()
        val files = dir.listFiles()?.filter { it.isFile && it.extension.lowercase() in setOf("mp3", "m4a", "ogg", "flac") } ?: emptyList()
        JSONObject().apply {
            put("path", dir.absolutePath)
            put("visible", dir.absolutePath.contains("/Music/ElysiaFloat/"))
            put("count", files.size)
            put("bytes", files.sumOf { it.length() })
        }.toString()
    } catch (e: Exception) { JSONObject().put("path", "").put("count", 0).put("bytes", 0).put("error", e.message ?: "无法读取缓存状态").toString() }

    private fun postMusicCacheProgress(id: String, pct: Int) {
        val js = "window.__musicCacheProgress&&window.__musicCacheProgress(${JSONObject.quote(id)},$pct)"
        Handler(Looper.getMainLooper()).post { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} }
    }

    @JavascriptInterface
    fun cacheMusic(id: String, url: String, name: String, artist: String) {
        Thread {
            var err = ""
            var ok = false
            var path = ""
            var conn: HttpURLConnection? = null
            try {
                val pair = followMusicUrl(url)
                conn = pair.first
                val contentType = (conn!!.contentType ?: "").lowercase()
                val expected = conn!!.contentLengthLong
                val target = File(musicCacheDir(), musicCacheKey(id) + ".mp3")
                val temp = File(target.parentFile, target.name + ".part")
                var total = 0L
                var header = ByteArray(0)
                BufferedInputStream(conn!!.inputStream).use { input -> FileOutputStream(temp).use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        if (header.size < 4096) header += buf.copyOf(min(n, 4096 - header.size))
                        total += n
                        if (expected > 0) postMusicCacheProgress(id, ((total * 100L) / expected).toInt().coerceIn(0, 99))
                        if (total > 150L * 1024L * 1024L) throw IllegalStateException("单曲缓存不能超过 150MB")
                        output.write(buf, 0, n)
                    }
                } }
                if (total < 4096 || (!contentType.contains("audio") && !audioHeader(header))) {
                    temp.delete()
                    throw IllegalStateException("下载结果不是可识别的音频文件（Content-Type: ${contentType.ifBlank { "未知" }}）")
                }
                if (!temp.renameTo(target)) throw IllegalStateException("缓存文件保存失败")
                ok = true; path = target.absolutePath
            } catch (e: Exception) { err = e.message ?: "下载缓存失败" }
            finally { try { conn?.disconnect() } catch (_: Exception) {} }
            val js = "window.__musicCacheCb&&window.__musicCacheCb(${JSONObject.quote(id)},$ok,${JSONObject.quote(path)},${JSONObject.quote(err)})"
            Handler(Looper.getMainLooper()).post { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} }
        }.start()
    }

    @JavascriptInterface
    fun clearMusicCache(): Int = try {
        musicCacheDir().listFiles()?.count { it.delete() } ?: 0
    } catch (_: Exception) { 0 }

    @JavascriptInterface
    fun clearAll() {
        try {
            ctx.getSharedPreferences("elly", Context.MODE_PRIVATE).edit().clear().apply()
        } catch (e: Exception) {}
    }

    /** 为远程插件清单做内容完整性校验；只返回 SHA-256，不保存输入内容。 */
    @JavascriptInterface
    fun sha256(value: String): String {
        return try {
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
        } catch (_: Exception) { "" }
    }

    /* ---------- 窗口 ---------- */
    @JavascriptInterface
    fun closeFloat() {
        (ctx as? FloatService)?.closeFloat()
    }

    @JavascriptInterface
    fun minimizeToBubble() {
        (ctx as? FloatService)?.minimizeToBubble()
    }

    @JavascriptInterface
    fun restoreFloat() {
        (ctx as? FloatService)?.restoreFromBubble()
    }

    /* ---------- 状态胶囊（收起成小窗 / 红点提醒） ---------- */

    /** 收起成小胶囊并进入「处理中」。翻译 / AI 总结前调用。 */
    @JavascriptInterface
    fun toCapsule(text: String) {
        (ctx as? FloatService)?.minimizeToCapsule(text)
    }

    @JavascriptInterface
    fun capsuleState(text: String, state: String) {
        (ctx as? FloatService)?.updateCapsule(text, state)
    }

    /** 处理完了：如果确实处于胶囊状态就亮红点，返回 true；否则（窗口本来就是开的）不打扰。 */
    @JavascriptInterface
    fun capsuleDone(text: String): Boolean {
        val s = ctx as? FloatService ?: return false
        if (!s.isCapsuleMode()) return false
        s.updateCapsule(text, "done")
        return true
    }

    @JavascriptInterface
    fun capsuleHide() {
        (ctx as? FloatService)?.restoreFromCapsule()
    }

    /* ---------- 屏幕翻译：原位覆盖 ---------- */
    @JavascriptInterface
    fun showTranslateOverlay(json: String) {
        (ctx as? FloatService)?.showTranslateOverlay(json)
    }

    @JavascriptInterface
    fun hideTranslateOverlay() {
        (ctx as? FloatService)?.hideTranslateOverlay()
    }

    /* ---------- 迷你播放器悬浮窗 ---------- */
    @JavascriptInterface
    fun showMiniPlayer(name: String, artist: String, playing: Boolean) {
        (ctx as? FloatService)?.showMiniPlayer(name, artist, playing)
    }

    @JavascriptInterface
    fun hideMiniPlayer() {
        (ctx as? FloatService)?.hideMiniPlayer()
    }

    /** 迷你播放条上那一行歌词，由 JS 解析 LRC 后送过来。 */
    @JavascriptInterface
    fun setMiniLyric(text: String) {
        (ctx as? FloatService)?.setMiniLyric(text)
    }

    /** 迷你播放条上的播放方式图标。 */
    @JavascriptInterface
    fun setMiniPlayMode(icon: String) {
        (ctx as? FloatService)?.setMiniPlayMode(icon)
    }

    /* ---------- 音乐播放（原生引擎） ----------
     * 以前音乐是 WebView 里的 <audio> 放的，浮窗没有 Activity，WebView 一直
     * 「不可见」，Chromium 既不申请唤醒锁、息屏还会挂起渲染进程，
     * 所以给了电池白名单也照样断。现在全部交给原生 MediaPlayer。 */

    @JavascriptInterface
    fun mpLoad(url: String, name: String, artist: String) {
        audio?.load(url, name, artist)
    }

    @JavascriptInterface
    fun mpPlay() { audio?.play() }

    @JavascriptInterface
    fun mpPause() { audio?.pause() }

    @JavascriptInterface
    fun mpToggle() { audio?.toggle() }

    @JavascriptInterface
    fun mpSeek(ms: Int) { audio?.seekTo(ms) }

    @JavascriptInterface
    fun mpStop() { audio?.stop() }

    /** 主动查询播放器状态，息屏回来 / 重进音乐页时对账用。 */
    @JavascriptInterface
    fun mpState(): String = audio?.stateJson() ?: "{}"

    /* ---------- TTS ---------- */

    /** 系统语音引擎（旧接口，保留兼容）。 */
    @JavascriptInterface
    fun speak(text: String, rate: Float) {
        audio?.speakSystem(text, rate)
    }

    /**
     * 自建语音：JS 拼好 OpenAI 兼容的 /audio/speech 请求，原生负责下载 + 播放。
     * 走的是和音乐同一条原生通道，所以息屏也能出声。
     */
    @JavascriptInterface
    fun ttsAi(url: String, headersJson: String, bodyJson: String) {
        audio?.speakAi(url, headersJson, bodyJson)
    }

    @JavascriptInterface
    fun ttsStop() {
        audio?.stopSpeech()
        audio?.stopSystem()
    }

    @JavascriptInterface
    fun stopSpeak() {
        audio?.stopSpeech()
        audio?.stopSystem()
    }

    /* ---------- 头像 / 相册 ---------- */
    @JavascriptInterface
    fun setAvatar(url: String, fit: String) {
        try {
            ctx.getSharedPreferences("elly", Context.MODE_PRIVATE)
                .edit().putString("avatar", url).apply()
            (ctx as? FloatService)?.setBubbleAvatar(url, fit)
        } catch (e: Exception) {}
    }

    @JavascriptInterface
    fun pickImage() {
        try {
            ctx.startActivity(Intent(ctx, PickImageActivity::class.java)
                .putExtra(PickImageActivity.EXTRA_MODE, PickImageActivity.MODE_IMAGE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {}
    }

    @JavascriptInterface
    fun pickFile() {
        try {
            ctx.startActivity(Intent(ctx, PickImageActivity::class.java)
                .putExtra(PickImageActivity.EXTRA_MODE, PickImageActivity.MODE_FILE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {}
    }

    @JavascriptInterface
    fun getPickedImage(): String {
        val s = FloatService.pendingPickedImage ?: ""
        FloatService.pendingPickedImage = null
        return s
    }

    @JavascriptInterface
    fun getPickedFile(): String {
        val s = FloatService.pendingPickedFile ?: ""
        FloatService.pendingPickedFile = null
        return s
    }

    /* ---------- 剪贴板 ---------- */
    @JavascriptInterface
    fun getClipboard(): String {
        return try {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
        } catch (e: Exception) { "" }
    }

    @JavascriptInterface
    fun setClipboard(text: String) {
        try {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("elly", text))
        } catch (e: Exception) {}
    }

    /* ---------- 其他 ---------- */
    @JavascriptInterface
    fun openUrl(url: String) {
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {}
    }

    @JavascriptInterface
    fun vibrate(ms: Int) {
        try {
            val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms.toLong(), 80))
            } else {
                @Suppress("DEPRECATION") v.vibrate(ms.toLong())
            }
        } catch (e: Exception) {}
    }

    /* ---------- 应用更新（下载 + 交给系统安装器） ---------- */

    /** 当前是否允许安装未知来源应用。Android 8 以下默认允许。 */
    @JavascriptInterface
    fun canInstall(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return try { ctx.packageManager.canRequestPackageInstalls() } catch (e: Exception) { false }
    }

    /** 跳到「安装未知应用」授权页，用户开启后返回再点一次下载即可。 */
    @JavascriptInterface
    fun requestInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            ctx.startActivity(Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${ctx.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) { }
    }

    /**
     * 后台下载更新包到 cache/updates，完成后拉起系统安装器。
     * 进度通过 window.__dlCb(id, pct, done, err, path) 回抛给网页。
     */
    @JavascriptInterface
    fun downloadAndInstall(id: String, url: String, fileName: String) {
        Thread {
            try {
                val safe = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "update.apk" }
                val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
                val out = File(dir, safe)
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = true
                    connectTimeout = 15000
                    readTimeout = 30000
                    setRequestProperty("User-Agent", "ElysiaFloat-Updater")
                }
                conn.connect()
                val total = conn.contentLengthLong
                conn.inputStream.use { input ->
                    FileOutputStream(out).use { fos ->
                        val buf = ByteArray(8192)
                        var read: Int
                        var done = 0L
                        var last = -1
                        while (input.read(buf).also { read = it } > 0) {
                            fos.write(buf, 0, read)
                            done += read
                            if (total > 0) {
                                val pct = ((done * 100) / total).toInt()
                                if (pct != last) { last = pct; postDl(id, pct, false, "", "") }
                            }
                        }
                    }
                }
                conn.disconnect()
                Handler(Looper.getMainLooper()).post { installApk(id, out) }
            } catch (e: Exception) {
                postDl(id, 0, true, e.message ?: "下载失败", "")
            }
        }.start()
    }

    private fun postDl(id: String, pct: Int, done: Boolean, err: String, path: String) {
        val js = "window.__dlCb&&window.__dlCb(${JSONObject.quote(id)},$pct,$done,${JSONObject.quote(err)},${JSONObject.quote(path)})"
        Handler(Looper.getMainLooper()).post {
            try { webView.evaluateJavascript(js, null) } catch (e: Exception) { }
        }
    }

    private fun installApk(id: String, file: File) {
        try {
            val uri = Uri.parse("content://${ctx.packageName}.fileprovider/${Uri.encode(file.name)}")
            val i = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            ctx.startActivity(i)
            postDl(id, 100, true, "", file.absolutePath)
        } catch (e: Exception) {
            postDl(id, 0, true, "安装启动失败：" + (e.message ?: ""), file.absolutePath)
        }
    }

    /* ---------- 网络请求 ---------- */
    @JavascriptInterface
    fun request(id: String, method: String, url: String, headersJson: String, body: String, timeout: Int) {
        Thread {
            var ok = false
            var code = 0
            var text = ""
            var err = ""
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = method.uppercase()
                    connectTimeout = timeout.coerceAtLeast(1000)
                    readTimeout = timeout.coerceAtLeast(1000)
                    useCaches = true
                    doInput = true
                }
                activeRequests[id] = conn!!
                try {
                    val hj = JSONObject(headersJson)
                    hj.keys().forEach { k -> conn!!.setRequestProperty(k, hj.getString(k)) }
                } catch (_: Exception) { }
                if (method.uppercase() == "POST" || method.uppercase() == "PUT") {
                    conn!!.doOutput = true
                    if (body.isNotEmpty() && conn!!.getRequestProperty("Content-Type") == null) {
                        conn!!.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    }
                    conn!!.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                code = conn!!.responseCode
                val stream = if (code >= 400) conn!!.errorStream else conn!!.inputStream
                text = stream?.use { input -> BufferedReader(InputStreamReader(input, Charsets.UTF_8)).use { it.readText() } } ?: ""
                ok = code in 200..299
            } catch (e: Exception) {
                ok = false
                err = e.message ?: "网络错误"
            } finally {
                activeRequests.remove(id)
                try { conn?.disconnect() } catch (_: Exception) { }
            }
            val js = "window.__gmCb&&window.__gmCb(${JSONObject.quote(id)},$ok,$code,${JSONObject.quote(text)},${JSONObject.quote(err)})"
            Handler(Looper.getMainLooper()).post { try { webView.evaluateJavascript(js, null) } catch (e: Exception) {} }
        }.start()
    }

    /**
     * 统一请求（G3）。相比 request() 多了：手动跟随跳数上限、协议校验、
     * 响应大小上限、归一错误码、最终 URL 回传。
     * optsJson: { maxBytes, maxRedirect, cacheable, allowHttp }
     */
    @JavascriptInterface
    fun requestEx(id: String, method: String, url: String, headersJson: String, body: String, timeout: Int, optsJson: String) {
        Thread {
            var ok = false
            var code = 0
            var text = ""
            var err = ""
            var errorCode = ""
            var finalUrl = url
            var bytes = 0
            var contentType = ""
            var maxBytes = 8 * 1024 * 1024
            var maxRedirect = 5
            var cacheable = false
            var allowHttp = true
            var sameHost = false
            try {
                val o = JSONObject(optsJson.ifEmpty { "{}" })
                if (o.has("maxBytes")) maxBytes = o.optInt("maxBytes", maxBytes).coerceIn(1024, 512 * 1024 * 1024)
                if (o.has("maxRedirect")) maxRedirect = o.optInt("maxRedirect", maxRedirect).coerceIn(0, 10)
                cacheable = o.optBoolean("cacheable", false)
                allowHttp = o.optBoolean("allowHttp", true)
                sameHost = o.optBoolean("sameHost", false)
            } catch (_: Exception) { }

            try {
                val reqHeaders = JSONObject()
                try {
                    val hj = JSONObject(headersJson.ifEmpty { "{}" })
                    hj.keys().forEach { k -> reqHeaders.put(k, hj.getString(k)) }
                } catch (_: Exception) { }
                val verb = method.uppercase()
                var current = url
                var hops = 0
                while (true) {
                    if (!allowHttp && current.startsWith("http://", ignoreCase = true)) {
                        errorCode = "REDIRECT_ERROR"; err = "不允许明文 http 地址"; code = 0; break
                    }
                    val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                        requestMethod = verb
                        connectTimeout = timeout.coerceAtLeast(1000)
                        readTimeout = timeout.coerceAtLeast(1000)
                        useCaches = cacheable
                        instanceFollowRedirects = false
                        doInput = true
                    }
                    activeRequests[id] = conn
                    reqHeaders.keys().forEach { k -> try { conn.setRequestProperty(k, reqHeaders.getString(k)) } catch (_: Exception) { } }
                    if (verb == "POST" || verb == "PUT") {
                        conn.doOutput = true
                        if (body.isNotEmpty() && conn.getRequestProperty("Content-Type") == null) {
                            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        }
                        try { conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) } } catch (_: Exception) { }
                    }
                    val rc = conn.responseCode
                    code = rc
                    finalUrl = current
                    contentType = conn.contentType ?: ""
                    if (rc in 300..399) {
                        val loc = conn.getHeaderField("Location")
                        try { conn.disconnect() } catch (_: Exception) { }
                        activeRequests.remove(id)
                        if (loc.isNullOrBlank()) { errorCode = "REDIRECT_ERROR"; err = "重定向缺少 Location"; break }
                        if (hops >= maxRedirect) { errorCode = "REDIRECT_ERROR"; err = "超过最大重定向次数 $maxRedirect"; break }
                        val next = try { URL(URL(current), loc).toString() } catch (_: Exception) { loc }
                        if (sameHost) {
                            val a = try { URL(url).host } catch (_: Exception) { "" }
                            val b = try { URL(next).host } catch (_: Exception) { "" }
                            if (a.isNullOrBlank() || b.isNullOrBlank() || !a.equals(b, ignoreCase = true)) {
                                errorCode = "REDIRECT_ERROR"; err = "跨域跳转被拒绝（Agent L2 未开启）"; break
                            }
                        }
                        current = next
                        hops++
                        continue
                    }
                    val stream = if (rc >= 400) conn.errorStream else conn.inputStream
                    val read = readCapped(stream, maxBytes)
                    if (read.second) {
                        errorCode = "TOO_LARGE"; err = "响应超过 ${maxBytes / 1024}KB"
                        try { conn.disconnect() } catch (_: Exception) { }
                        break
                    }
                    text = read.first
                    bytes = text.toByteArray(Charsets.UTF_8).size
                    ok = rc in 200..299
                    if (!ok) {
                        errorCode = when (rc) {
                            401, 403 -> "AUTH_ERROR"
                            429 -> "RATE_LIMITED"
                            else -> "HTTP_ERROR"
                        }
                        err = if (text.isBlank()) "HTTP $rc"
                        else {
                            val body = text.trim().take(500)
                            if (body.isEmpty()) "HTTP $rc" else "HTTP $rc：$body"
                        }
                    }
                    try { conn.disconnect() } catch (_: Exception) { }
                    activeRequests.remove(id)
                    break
                }
            } catch (e: java.net.SocketTimeoutException) {
                errorCode = "TIMEOUT"; err = e.message ?: "请求超时"
            } catch (e: Exception) {
                if (errorCode.isEmpty()) { errorCode = "NETWORK_ERROR"; err = e.message ?: "网络错误" }
            } finally {
                activeRequests.remove(id)
            }
            val meta = JSONObject()
            try {
                meta.put("errorCode", errorCode)
                meta.put("bytes", bytes)
                meta.put("finalUrl", finalUrl)
                meta.put("contentType", contentType)
            } catch (_: Exception) { }
            val js = "window.__gmCb&&window.__gmCb(${JSONObject.quote(id)},$ok,$code,${JSONObject.quote(text)},${JSONObject.quote(err)},${JSONObject.quote(meta.toString())})"
            Handler(Looper.getMainLooper()).post { try { webView.evaluateJavascript(js, null) } catch (_: Exception) {} }
        }.start()
    }

    /** 按字节上限读取；超限返回 ("", true)，不再把巨型响应塞进 WebView。 */
    private fun readCapped(stream: java.io.InputStream?, maxBytes: Int): Pair<String, Boolean> {
        if (stream == null) return "" to false
        return try {
            stream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(8192)
                var total = 0
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > maxBytes) return "" to true
                    out.write(buf, 0, n)
                }
                String(out.toByteArray(), Charsets.UTF_8) to false
            }
        } catch (e: Exception) {
            "" to false
        }
    }

    @JavascriptInterface
    fun cancelRequest(id: String) {
        val conn = activeRequests.remove(id) ?: return
        try { conn.disconnect() } catch (_: Exception) { }
    }
}
