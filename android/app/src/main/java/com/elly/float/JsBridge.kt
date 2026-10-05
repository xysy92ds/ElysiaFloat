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
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

class JsBridge(private val ctx: Context, private val webView: WebView) {

    private var tts: TextToSpeech? = null
    private var ttsReady = false

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

    /* ---------- 迷你播放器悬浮窗 ---------- */
    @JavascriptInterface
    fun showMiniPlayer(name: String, artist: String, playing: Boolean) {
        (ctx as? FloatService)?.showMiniPlayer(name, artist, playing)
    }

    @JavascriptInterface
    fun hideMiniPlayer() {
        (ctx as? FloatService)?.hideMiniPlayer()
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

    /* ---------- TTS ---------- */
    @JavascriptInterface
    fun speak(text: String, rate: Float) {
        if (!ttsReady && tts == null) {
            tts = TextToSpeech(ctx) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true
                    tts?.language = Locale.CHINA
                    tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(id: String?) {}
                        override fun onError(id: String?) { notifyTtsDone() }
                        override fun onDone(id: String?) { notifyTtsDone() }
                    })
                    doSpeak(text, rate)
                } else {
                    notifyTtsDone()
                }
            }
        } else if (ttsReady) {
            doSpeak(text, rate)
        }
    }

    private fun doSpeak(text: String, rate: Float) {
        try {
            tts?.setSpeechRate(rate)
            val id = "elly_" + System.currentTimeMillis()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
            } else {
                @Suppress("DEPRECATION") tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null)
            }
        } catch (e: Exception) { notifyTtsDone() }
    }

    private fun notifyTtsDone() {
        Handler(Looper.getMainLooper()).post {
            try { webView.evaluateJavascript("window.__ttsDone&&window.__ttsDone()", null) }
            catch (e: Exception) {}
        }
    }

    @JavascriptInterface
    fun stopSpeak() {
        try { tts?.stop() } catch (e: Exception) {}
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
