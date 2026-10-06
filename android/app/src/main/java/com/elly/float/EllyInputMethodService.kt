package com.elly.assistant

import android.inputmethodservice.InputMethodService
import android.view.View
import android.widget.FrameLayout

/**
 * 输入兜底只在用户主动启用并切换到爱莉希雅输入法后生效。
 * 普通输入优先走无障碍 ACTION_SET_TEXT；这个服务不自行修改默认输入法，
 * 避免在没有 Shizuku/root 的情况下偷偷改变用户的系统设置。
 */
class EllyInputMethodService : InputMethodService() {
    companion object {
        @Volatile var instance: EllyInputMethodService? = null
            private set

        fun commit(text: String): Boolean = try {
            instance?.currentInputConnection?.commitText(text, 1) == true
        } catch (_: Exception) { false }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onCreateInputView(): View {
        // 不提供实体键盘 UI；仅使用当前输入连接作为受控兜底通道。
        return FrameLayout(this).apply { minimumHeight = 1 }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }
}
