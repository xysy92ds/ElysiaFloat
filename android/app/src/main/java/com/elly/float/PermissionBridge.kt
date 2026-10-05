package com.elly.assistant

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface

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

    /* ---------- 窗口移动 / 缩放 ---------- */
    @JavascriptInterface
    fun moveWindow(dx: Int, dy: Int) {
        (ctx as? FloatService)?.moveBy(dx, dy)
    }

    @JavascriptInterface
    fun resizeWindow(w: Int, h: Int) {
        (ctx as? FloatService)?.resize(w, h)
    }

    @JavascriptInterface
    fun getWindowRect(): String {
        return (ctx as? FloatService)?.windowRectJson() ?: "{}"
    }

    @JavascriptInterface
    fun setWindowRect(x: Int, y: Int, w: Int, h: Int) {
        (ctx as? FloatService)?.setWindowRect(x, y, w, h)
    }
}
