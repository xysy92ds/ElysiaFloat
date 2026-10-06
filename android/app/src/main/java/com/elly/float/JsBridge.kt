package com.elly.assistant

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class JsBridge(private val ctx: Context, private val webView: WebView) {

    private val audio get() = (ctx as? FloatService)?.audio()

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

    @JavascriptInterface
    fun clearAll() {
        try {
            ctx.getSharedPreferences("elly", Context.MODE_PRIVATE).edit().clear().apply()
        } catch (e: Exception) {}
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
            try {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = method.uppercase()
                    connectTimeout = timeout.coerceAtLeast(1000)
                    readTimeout = timeout.coerceAtLeast(1000)
                    useCaches = true
                    doInput = true
                }
                try {
                    val hj = JSONObject(headersJson)
                    hj.keys().forEach { k -> conn.setRequestProperty(k, hj.getString(k)) }
                } catch (_: Exception) { }
                if (method.uppercase() == "POST" || method.uppercase() == "PUT") {
                    conn.doOutput = true
                    if (body.isNotEmpty() && conn.getRequestProperty("Content-Type") == null) {
                        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    }
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                code = conn.responseCode
                val stream = if (code >= 400) conn.errorStream else conn.inputStream
                text = stream?.use { input ->
                    BufferedReader(InputStreamReader(input, Charsets.UTF_8)).use { it.readText() }
                } ?: ""
                ok = code in 200..299
                conn.disconnect()
            } catch (e: Exception) {
                ok = false
                err = e.message ?: "网络错误"
            }
            val js = "window.__gmCb&&window.__gmCb(${JSONObject.quote(id)},$ok,$code,${JSONObject.quote(text)},${JSONObject.quote(err)})"
            Handler(Looper.getMainLooper()).post {
                try { webView.evaluateJavascript(js, null) } catch (e: Exception) {}
            }
        }.start()
    }
}
