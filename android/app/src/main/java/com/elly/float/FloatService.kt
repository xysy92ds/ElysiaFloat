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

        private const val CHANNEL_ID = "elly_float"
        private const val NOTI_ID = 1
    }

    private var wm: WindowManager? = null
    private var webView: WebView? = null
    private var params: WindowManager.LayoutParams? = null

    private var bubble: ImageView? = null
    private var bubbleBmp: Bitmap? = null
    private var minimized = false
    private var savedFlags = 0
    private var savedRect: IntArray? = null

    /* 迷你播放器（独立系统悬浮窗，缩成小球后依然可见可拖动） */
    private var miniBar: LinearLayout? = null
    private var miniName: TextView? = null
    private var miniArtist: TextView? = null
    private var miniPlay: TextView? = null
    private var miniParams: WindowManager.LayoutParams? = null
    private var miniVisible = false

    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        startForegroundSafe()
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        try {
            setupWebView()
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
        try {
            startForeground(
                NOTI_ID, buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } catch (_: Exception) { }
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
        val w = min((dm.widthPixels * 0.92).toInt(), (400 * dm.density).toInt())
        val h = min((dm.heightPixels * 0.78).toInt(), (660 * dm.density).toInt())

        val p = WindowManager.LayoutParams(
            w, h, overlayType(),
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (dm.widthPixels - w) / 2
            y = (dm.heightPixels - h) / 3
        }
        params = p
        wm?.addView(wv, p)
    }

    fun moveBy(dx: Int, dy: Int) = runOnMain {
        val p = params ?: return@runOnMain
        val wv = webView ?: return@runOnMain
        val dm = resources.displayMetrics
        p.x = (p.x + dx).coerceIn(0, (dm.widthPixels - p.width).coerceAtLeast(0))
        p.y = (p.y + dy).coerceIn(0, (dm.heightPixels - p.height).coerceAtLeast(0))
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
    }

    fun resize(w: Int, h: Int) = runOnMain {
        val p = params ?: return@runOnMain
        applyRect(p.x, p.y, w, h)
    }

    fun windowRectJson(): String {
        val p = params ?: return "{}"
        return try {
            JSONObject().apply {
                put("x", p.x); put("y", p.y); put("w", p.width); put("h", p.height)
            }.toString()
        } catch (e: Exception) { "{}" }
    }

    /** JS 按住边缘缩放时回调，坐标与尺寸均为物理像素。 */
    fun setWindowRect(x: Int, y: Int, w: Int, h: Int) = runOnMain { applyRect(x, y, w, h) }

    private fun applyRect(x: Int, y: Int, w: Int, h: Int) {
        val p = params ?: return
        val wv = webView ?: return
        val dm = resources.displayMetrics
        val sw = dm.widthPixels
        val sh = dm.heightPixels
        val minSize = (190 * dm.density).toInt()
        val nw = w.coerceIn(minSize, max(minSize, sw))
        val nh = h.coerceIn(minSize, max(minSize, sh))
        val nx = x.coerceIn(0, (sw - nw).coerceAtLeast(0))
        val ny = y.coerceIn(0, (sh - nh).coerceAtLeast(0))
        p.width = nw; p.height = nh; p.x = nx; p.y = ny
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
    }

    /* ---------------- 最小化成悬浮小球 ---------------- */
    fun minimizeToBubble() = runOnMain {
        if (minimized) return@runOnMain
        val p = params ?: return@runOnMain
        val wv = webView ?: return@runOnMain
        minimized = true
        // 不 removeView（会丢 surface），改成：移出屏幕 + 全透明 + 不可触摸。
        // 三重保证一定能藏起来，且 WebView 和音乐播放状态都不中断。
        savedFlags = p.flags
        savedRect = intArrayOf(p.x, p.y, p.width, p.height)
        p.alpha = 0f
        p.x = -p.width - 500
        p.flags = p.flags or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
        addBubble()
    }

    fun restoreFromBubble() = runOnMain {
        if (!minimized) return@runOnMain
        minimized = false
        removeBubble()
        val p = params ?: return@runOnMain
        val wv = webView ?: return@runOnMain
        savedRect?.let { p.x = it[0]; p.y = it[1]; p.width = it[2]; p.height = it[3] }
        p.alpha = 1f
        p.flags = savedFlags
        try { wm?.updateViewLayout(wv, p) } catch (_: Exception) { }
        try { wv.requestLayout(); wv.invalidate() } catch (_: Exception) { }
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
            x = dm.widthPixels - size - (10 * dm.density).toInt()
            y = (dm.heightPixels * 0.60).toInt()
        }
        attachBubbleTouch(iv, p, dm)
        bubble = iv
        try { wm?.addView(iv, p) } catch (_: Exception) { bubble = null }
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
                    if (!moved) restoreFromBubble()
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
    }

    /* ---------------- 迷你播放器悬浮窗 ---------------- */
    fun showMiniPlayer(name: String, artist: String, playing: Boolean) = runOnMain {
        val bar = miniBar ?: buildMiniBar().also { miniBar = it }
        miniName?.text = if (name.isBlank()) "正在播放" else name
        miniArtist?.text = if (artist.isBlank()) "—" else artist
        miniPlay?.text = if (playing) "❚❚" else "▶"
        if (!miniVisible) {
            addMiniBar(bar)
        } else {
            val p = miniParams
            if (p != null) try { wm?.updateViewLayout(bar, p) } catch (_: Exception) { }
        }
    }

    fun hideMiniPlayer() = runOnMain {
        val bar = miniBar ?: return@runOnMain
        try { wm?.removeView(bar) } catch (_: Exception) { }
        miniBar = null
        miniParams = null
        miniVisible = false
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
        }
        info.addView(name)
        info.addView(artist)
        val infoLp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        infoLp.leftMargin = dp(8)
        infoLp.rightMargin = dp(4)
        bar.addView(info, infoLp)

        val play = TextView(this).apply {
            text = "▶"
            gravity = Gravity.CENTER
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 12f
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFD6336C.toInt())
            }
        }
        bar.addView(play, LinearLayout.LayoutParams(dp(32), dp(32)))

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
        miniPlay = play

        play.setOnClickListener {
            webView?.evaluateJavascript("window.__miniToggle&&window.__miniToggle()", null)
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
        val width = min((280 * d).toInt(), dm.widthPixels - (32 * d).toInt()).coerceAtLeast((160 * d).toInt())
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
                        // 点一下播放条 → 还原窗口并打开音乐页
                        restoreFromBubble()
                        webView?.evaluateJavascript("window.__miniOpen&&window.__miniOpen()", null)
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

    /** JS 入口：结果通过 window.__shotDone(dataUrl|null) 回传 */
    fun requestScreenshot() {
        captureScreenInternal { data ->
            main.post { deliverShot(data) }
        }
    }

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
        if (cb != null) main.post { doProjectionShot(cb) }
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
            svc.takeScreenShot { data ->
                // 无障碍失败（部分系统界面/安全限制）→ 回退到录屏通道
                if (!data.isNullOrBlank()) cb(data) else projectionShot(cb)
            }
            return
        }
        projectionShot(cb)
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
        doProjectionShot(cb)
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
        removeBubble()
        miniBar?.let { bar -> try { wm?.removeView(bar) } catch (_: Exception) { } }
        miniBar = null
        miniParams = null
        miniVisible = false
        webView?.let { wv ->
            try { wm?.removeView(wv) } catch (_: Exception) { }
            try { wv.destroy() } catch (_: Exception) { }
        }
        webView = null
        super.onDestroy()
    }
}
