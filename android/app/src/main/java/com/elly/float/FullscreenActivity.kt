package com.elly.assistant

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * 全屏 Activity：把 FloatService 的 WebView 迁移进来承载，让用户像用普通 App 一样交互。
 *
 * 关键点：
 * - WebView 是同一个实例，聊天/任务/音乐等状态全部天然保留；
 * - JsBridge / PermissionBridge 仍然绑在 FloatService 上，所有原生能力不变；
 * - 退出时把 WebView 还给 Service 重新挂回悬浮窗。
 */
class FullscreenActivity : Activity() {

    companion object {
        @Volatile var current: FullscreenActivity? = null
            private set
    }

    private var container: FrameLayout? = null
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this

        // 沉浸式：状态栏与导航栏都隐藏，内容铺到整个屏幕
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let { ctrl ->
                ctrl.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                ctrl.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }

        container = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        setContentView(container)

        // 从 Service 拿到 WebView 并挂进来
        val svc = FloatService.instance
        val wv = svc?.getWebViewForFullscreen()
        if (wv == null) {
            // 服务没了，直接退出
            finish()
            return
        }
        webView = wv
        (wv.parent as? android.view.ViewGroup)?.removeView(wv)
        container?.addView(wv, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
    }

    /**
     * 系统返回键：
     * 1. 先交给网页的 __nativeBack 处理视图切换（设置→聊天等）；
     * 2. 如果已经在聊天页（__nativeBack 返回 false），则退出全屏回到悬浮窗。
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            val wv = webView
            if (wv != null) {
                var handled = false
                val latch = java.util.concurrent.CountDownLatch(1)
                wv.evaluateJavascript(
                    "(function(){try{return window.__nativeBack&&window.__nativeBack()===true}catch(e){return false}})()"
                ) { result ->
                    handled = result == "true"
                    latch.countDown()
                }
                try { latch.await(300, java.util.concurrent.TimeUnit.MILLISECONDS) } catch (_: Exception) {}
                if (handled) return true
            }
            // 已经在聊天页：退出全屏
            exitFullscreen()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun exitFullscreen() {
        FloatService.instance?.returnWebViewFromFullscreen()
        finish()
    }

    override fun onDestroy() {
        // Activity 被系统销毁时也要把 WebView 还回去，避免丢失状态
        val wv = webView
        if (wv != null) {
            (wv.parent as? android.view.ViewGroup)?.removeView(wv)
            FloatService.instance?.returnWebViewFromFullscreen()
            webView = null
        }
        if (current === this) current = null
        super.onDestroy()
    }
}
