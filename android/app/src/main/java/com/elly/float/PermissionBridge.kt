package com.elly.assistant

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONObject

class PermissionBridge(private val ctx: Context) {

    /* ---------- 悬浮窗 ---------- */
    @JavascriptInterface
    fun hasOverlay(): Boolean = try { Settings.canDrawOverlays(ctx) } catch (e: Exception) { false }

    @JavascriptInterface
    fun requestOverlay() {
        try {
            ctx.startActivity(Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${ctx.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            try {
                ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e2: Exception) {}
        }
    }

    /* ---------- 无障碍 ---------- */
    @JavascriptInterface
    fun hasAccessibility(): Boolean = EllyAccessibilityService.instance != null

    @JavascriptInterface
    fun requestAccessibility() {
        try {
            ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {}
    }

    /* ---------- 通知 ---------- */
    @JavascriptInterface
    fun hasNotification(): Boolean {
        if (Build.VERSION.SDK_INT < 33) return true
        return ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    @JavascriptInterface
    fun requestNotification() {
        if (Build.VERSION.SDK_INT < 33) return
        val act = MainActivity.current
        if (act != null) {
            act.runOnUiThread {
                try {
                    act.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
                } catch (_: Exception) { }
            }
            return
        }
        // 启动页通常已经 finish；重新打开它，才能由 Activity 发起运行时权限请求。
        try {
            ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { }
    }

    /* ---------- 电池优化 ---------- */
    @JavascriptInterface
    fun isIgnoringBattery(): Boolean = try {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (e: Exception) { false }

    @JavascriptInterface
    fun requestIgnoreBattery() {
        try {
            ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:${ctx.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            try {
                ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e2: Exception) {}
        }
    }

    /* ---------- 引导标记 ---------- */
    @JavascriptInterface
    fun isGuideDone(): Boolean = try {
        ctx.getSharedPreferences("elly", Context.MODE_PRIVATE).getBoolean("guide_done", false)
    } catch (e: Exception) { false }
    @JavascriptInterface
    fun setGuideDone() {
        try {
            ctx.getSharedPreferences("elly", Context.MODE_PRIVATE)
                .edit().putBoolean("guide_done", true).apply()
        } catch (e: Exception) {}
    }

    /* ---------- 读屏 ---------- */
    @JavascriptInterface
    fun getScreenText(): String = try {
        EllyAccessibilityService.instance?.dumpScreenText() ?: ""
    } catch (e: Exception) { "" }

    @JavascriptInterface
    fun getBrowserUrl(): String = try {
        EllyAccessibilityService.instance?.guessBrowserUrl() ?: ""
    } catch (e: Exception) { "" }

    /**
     * 「文字 + 坐标」一次性拿走，屏幕翻译原位覆盖就靠它。
     * 返回 JSON 数组：[{t,x,y,w,h}]，单位屏幕物理像素；拿不到返回 []。
     */
    @JavascriptInterface
    fun getScreenNodes(): String = try {
        EllyAccessibilityService.instance?.dumpScreenNodes() ?: "[]"
    } catch (e: Exception) { "[]" }

    /** 屏幕物理像素尺寸（覆盖层定位用）。 */
    @JavascriptInterface
    fun getScreenSize(): String = try {
        val dm = ctx.resources.displayMetrics
        org.json.JSONObject().apply {
            put("w", dm.widthPixels)
            put("h", dm.heightPixels)
            put("density", dm.density.toDouble())
        }.toString()
    } catch (e: Exception) { "{}" }

    /* ---------- 截屏 ---------- */
    @JavascriptInterface
    fun canScreenshot(): Boolean = try {
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && EllyAccessibilityService.instance != null) ||
                FloatService.instance != null
    } catch (e: Exception) { false }

    /** 截屏结果通过 window.__shotDone(dataUrl|null) 异步回传 */
    @JavascriptInterface
    fun captureScreen() {
        try { FloatService.instance?.requestScreenshot() } catch (e: Exception) { }
    }

    /* ---------- 通知渠道（Android 8+ 特有） ---------- */
    /**
     * 注意：Android 8 起，用户关了「爱莉希雅浮窗」这个通知渠道的话，
     * 前台服务会被系统直接杀掉 —— 浮窗消失、息屏断掉都可能是这个原因。
     * 而 hasNotification() 在 8~12 上恒为 true，发现不了这种情况，
     * 所以单独开一个检查项。
     */
    @JavascriptInterface
    fun isNotificationChannelOn(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // 浮窗前台服务这条；以及音乐媒体通知那条（没建过 = 还没用过 = 视为没关）
            val ids = arrayOf(FloatService.CHANNEL_ID, AudioEngine.CHANNEL_MUSIC)
            ids.all { id ->
                val ch = nm.getNotificationChannel(id) ?: return@all true
                ch.importance != NotificationManager.IMPORTANCE_NONE
            }
        } catch (e: Exception) { true }
    }

    @JavascriptInterface
    fun requestNotificationChannel() {
        try {
            // 直接进 App 的通知设置页（而不是单个渠道）：
            // 引导里查的是「浮窗」和「正在播放」两条，哪一条被关了都能在这一页看到
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:${ctx.packageName}"))
            }
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            try {
                ctx.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e2: Exception) { }
        }
    }

    /* ---------- 环境信息（低版本排错用） ---------- */
    @JavascriptInterface
    fun getEnvInfo(): String = try {
        val dm = ctx.resources.displayMetrics
        val pm = ctx.packageManager
        var wvPkg = "-"
        var wvVer = "-"
        try {
            val info: android.content.pm.PackageInfo? = if (Build.VERSION.SDK_INT >= 26) {
                android.webkit.WebView.getCurrentWebViewPackage()
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo("com.google.android.webview", 0)
            }
            if (info != null) {
                wvPkg = info.packageName
                wvVer = info.versionName ?: "-"
            }
        } catch (e: Exception) { }

        var appVer = "-"
        try {
            @Suppress("DEPRECATION")
            appVer = pm.getPackageInfo(ctx.packageName, 0).versionName ?: "-"
        } catch (e: Exception) { }

        JSONObject().apply {
            put("sdk", Build.VERSION.SDK_INT)
            put("release", Build.VERSION.RELEASE ?: "-")
            put("brand", Build.BRAND ?: "-")
            put("model", Build.MODEL ?: "-")
            put("webviewPkg", wvPkg)
            put("webviewVer", wvVer)
            put("appVer", appVer)
            put("density", dm.density.toDouble())
            put("densityDpi", dm.densityDpi)
            put("screenW", dm.widthPixels)
            put("screenH", dm.heightPixels)
        }.toString()
    } catch (e: Exception) { "{}" }

    /* ---------- 窗口移动 / 缩放 ---------- */
    @JavascriptInterface
    fun moveWindow(dx: Int, dy: Int) {
        (ctx as? FloatService)?.moveBy(dx, dy)
    }

    /** 直接给绝对坐标（拖左/上边缘时用）。返回实际生效的矩形 JSON。 */
    @JavascriptInterface
    fun moveWindowTo(x: Int, y: Int): String =
        (ctx as? FloatService)?.moveWindowTo(x, y) ?: "{}"

    @JavascriptInterface
    fun resizeWindow(w: Int, h: Int) {
        (ctx as? FloatService)?.resize(w, h)
    }

    @JavascriptInterface
    fun getWindowRect(): String {
        return (ctx as? FloatService)?.windowRectJson() ?: "{}"
    }

    /** 返回实际生效的矩形 —— JS 靠它校正缩放比，面板与窗口就不会脱节。 */
    @JavascriptInterface
    fun setWindowRect(x: Int, y: Int, w: Int, h: Int): String =
        (ctx as? FloatService)?.setWindowRect(x, y, w, h) ?: "{}"

    /** 原生侧的尺寸上下限（物理像素），JS 自己算清楚就不会白跑一趟。 */
    @JavascriptInterface
    fun getWindowLimits(): String =
        (ctx as? FloatService)?.windowLimitsJson() ?: "{}"
}
