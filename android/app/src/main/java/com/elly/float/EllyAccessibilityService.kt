package com.elly.assistant

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.hardware.HardwareBuffer
import android.os.Build
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.regex.Pattern

class EllyAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile var instance: EllyAccessibilityService? = null
            private set
        private const val MAX_LEN = 8000
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    /**
     * 浮窗本身是可交互窗口，rootInActiveWindow 很可能因此返回自己的 WebView。
     * 优先选择当前活动的其它窗口，否则“读屏”会读到空内容而不是浏览器。
     */
    private fun externalRoot(): AccessibilityNodeInfo? {
        val active = try { rootInActiveWindow } catch (_: Exception) { null }
        if (active != null && active.packageName?.toString() != applicationContext.packageName) return active
        if (Build.VERSION.SDK_INT >= 21) {
            try {
                val candidates = windows
                    .filter { it.root?.packageName?.toString() != applicationContext.packageName }
                    .sortedWith(compareByDescending<android.view.accessibility.AccessibilityWindowInfo> {
                        it.isActive
                    }.thenByDescending { it.isFocused })
                for (window in candidates) {
                    window.root?.let { return it }
                }
            } catch (_: Exception) { }
        }
        return null
    }

    /**
     * 无障碍自带截屏（Android 11 / API 30+），**不需要录屏授权**。
     * 失败或低版本返回 null，由调用方回退到 MediaProjection。
     */
    fun takeScreenShot(cb: (String?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            cb(null)
            return
        }
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    var bmp: Bitmap? = null
                    try {
                        val hb = screenshot.hardwareBuffer
                        val wrapped = Bitmap.wrapHardwareBuffer(hb, screenshot.colorSpace)
                        bmp = wrapped?.copy(Bitmap.Config.ARGB_8888, false)
                        wrapped?.recycle()
                        hb.close()
                    } catch (t: Throwable) {
                        bmp = null
                    }
                    val dataUrl = bmp?.let { ScreenShotUtil.toDataUrl(it) }
                    try { bmp?.recycle() } catch (_: Throwable) { }
                    cb(dataUrl)
                }

                override fun onFailure(errorCode: Int) {
                    cb(null)
                }
            })
        } catch (t: Throwable) {
            cb(null)
        }
    }

    /** 当前设备能不能用无障碍截屏 */
    fun canShot(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    /** 抓取浏览器等其它窗口的可见文本 */
    fun dumpScreenText(): String {
        val root = externalRoot() ?: return ""
        val sb = StringBuilder()
        try { collectText(root, sb, 0) } catch (_: Exception) { }
        return if (sb.length > MAX_LEN) sb.substring(0, MAX_LEN) + "\n...（已截断）"
        else sb.toString().trim()
    }

    private fun collectText(node: AccessibilityNodeInfo?, sb: StringBuilder, depth: Int) {
        if (node == null || depth > 40 || sb.length > MAX_LEN) return
        val pkg = node.packageName?.toString() ?: ""
        if (pkg == applicationContext.packageName) return
        val txt = node.text?.toString()?.trim().orEmpty()
        if (txt.length >= 2) {
            if (sb.isNotEmpty() && !sb.endsWith(txt)) sb.append('\n')
            sb.append(txt)
        }
        for (i in 0 until node.childCount) collectText(node.getChild(i), sb, depth + 1)
    }

    /** 尝试从浏览器地址栏拿 URL */
    fun guessBrowserUrl(): String {
        val root = externalRoot() ?: return ""
        val p = Pattern.compile("^(https?://|www\\.)[\\w\\-./?=&%#:@+~]+$")
        return findUrl(root, p, 0) ?: ""
    }

    private fun findUrl(node: AccessibilityNodeInfo?, p: Pattern, d: Int): String? {
        if (node == null || d > 40) return null
        val t = node.text?.toString()?.trim().orEmpty()
        val vid = node.viewIdResourceName?.lowercase().orEmpty()
        if ((vid.contains("url") || vid.contains("omnibox") || vid.contains("address"))
            && p.matcher(t).matches()) return t
        for (i in 0 until node.childCount) {
            findUrl(node.getChild(i), p, d + 1)?.let { return it }
        }
        if (p.matcher(t).matches()) return t
        return null
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }
}
