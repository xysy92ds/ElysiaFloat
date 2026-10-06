package com.elly.assistant

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.hardware.HardwareBuffer
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern

class EllyAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile var instance: EllyAccessibilityService? = null
            private set
        private const val MAX_LEN = 8000
        private const val MAX_NODES = 400
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

    /** 当前主导的外部应用包名，供 Agent native policy 使用。 */
    fun foregroundPackageName(): String = externalRoot()?.packageName?.toString().orEmpty()

    private fun findNode(node: AccessibilityNodeInfo?, query: String): AccessibilityNodeInfo? {
        if (node == null) return null
        val q = query.trim()
        if (q.isNotEmpty() && (node.text?.toString() == q || node.contentDescription?.toString() == q)) return node
        for (i in 0 until node.childCount) {
            val found = findNode(node.getChild(i), q)
            if (found != null) return found
        }
        return null
    }

    private fun center(node: AccessibilityNodeInfo): Pair<Float, Float>? {
        val r = android.graphics.Rect()
        node.getBoundsInScreen(r)
        if (r.isEmpty || r.width() <= 0 || r.height() <= 0) return null
        return Pair((r.left + r.right) / 2f, (r.top + r.bottom) / 2f)
    }

    private fun gesture(path: Path, durationMs: Long): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val latch = CountDownLatch(1)
        var ok = false
        val accepted = try {
            dispatchGesture(
                GestureDescription.Builder()
                    .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1)))
                    .build(),
                object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) { ok = true; latch.countDown() }
                    override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
                },
                null
            )
        } catch (_: Exception) { false }
        if (!accepted) return false
        latch.await(1800, TimeUnit.MILLISECONDS)
        return ok
    }

    fun tap(x: Int, y: Int): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()); lineTo(x + 1f, y + 1f) }
        return gesture(path, 80)
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): Boolean {
        val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
        return gesture(path, durationMs.coerceIn(80, 2000))
    }

    fun clickText(query: String): Boolean {
        val node = findNode(externalRoot(), query) ?: return false
        var target: AccessibilityNodeInfo? = node
        repeat(6) {
            val t = target
            if (t?.isClickable == true && t.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            target = t?.parent
        }
        val p = center(node) ?: return false
        return tap(p.first.toInt(), p.second.toInt())
    }

    fun inputText(text: String): Boolean {
        val root = externalRoot() ?: return false
        fun findFocused(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isEditable && node.isFocused) return node
            for (i in 0 until node.childCount) findFocused(node.getChild(i))?.let { return it }
            return null
        }
        val node = findFocused(root)
        if (node != null) {
            try {
                val before = node.text?.toString()
                val acted = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                }.let { node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, it) }
                // 某些聊天输入框会返回 true 但实际没有改变内容；只有确认成功才结束。
                val after = node.text?.toString()
                if (acted && (text.isEmpty() || after == text || before != after)) return true
            } catch (_: Exception) { }
        }
        // 兜底通道需要用户事先在系统输入法设置中启用并切换到爱莉希雅输入法。
        return EllyInputMethodService.commit(text)
    }

    fun globalAction(name: String): Boolean = when (name.lowercase()) {
        "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
        "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
        "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
        "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
        else -> false
    }

    /**
     * 屏幕翻译（原位覆盖）的命根子：不只拿文字，还要拿**精确坐标**。
     * 无障碍节点树自带 getBoundsInScreen，等于免费得到「文字 + 位置」，
     * 不需要任何 OCR。返回 JSON 数组字符串：[{t,x,y,w,h}, ...]，单位是屏幕物理像素。
     */
    fun dumpScreenNodes(): String {
        val root = externalRoot() ?: return "[]"
        val arr = JSONArray()
        try { collectNodes(root, arr, 0) } catch (_: Exception) { }
        return arr.toString()
    }

    private fun collectNodes(node: AccessibilityNodeInfo?, arr: JSONArray, depth: Int) {
        if (node == null || depth > 40 || arr.length() >= MAX_NODES) return
        val pkg = node.packageName?.toString() ?: ""
        // 自己浮窗里的文字必须排除，否则会把译文再翻一遍（滚雪球）
        if (pkg == applicationContext.packageName) return
        val txt = node.text?.toString()?.trim().orEmpty()
        if (txt.isNotEmpty() && txt.length <= 400) {
            val r = android.graphics.Rect()
            try { node.getBoundsInScreen(r) } catch (_: Exception) { r.setEmpty() }
            if (!r.isEmpty && r.width() > 0 && r.height() > 0) {
                try {
                    arr.put(JSONObject().apply {
                        put("t", txt)
                        put("x", r.left)
                        put("y", r.top)
                        put("w", r.width())
                        put("h", r.height())
                    })
                } catch (_: Exception) { }
            }
        }
        for (i in 0 until node.childCount) collectNodes(node.getChild(i), arr, depth + 1)
    }

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
