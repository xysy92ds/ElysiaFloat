package com.elly.assistant

import android.content.Context

/**
 * Runtime 能力抽象。上层只请求能力，不直接接触 Root、Shizuku 或 Termux 句柄。
 * 具体 Android/无障碍后端仍逐步迁移中。
 */
interface CapabilityRuntime {
    val id: String
    fun available(ctx: Context): Boolean
}

class NormalAndroidRuntime : CapabilityRuntime {
    override val id = "android"
    override fun available(ctx: Context) = true
}

class AccessibilityRuntime : CapabilityRuntime {
    override val id = "accessibility"
    override fun available(ctx: Context) = EllyAccessibilityService.instance != null
}

class ShizukuRuntime : CapabilityRuntime {
    override val id = "shizuku"
    override fun available(ctx: Context) = false // 授权执行留到 Shizuku SDK 接入后
}

class RootRuntime : CapabilityRuntime {
    override val id = "root"
    override fun available(ctx: Context) = RootWorker.isRootBinaryAvailable()
}

class TermuxRuntime : CapabilityRuntime {
    override val id = "termux"
    override fun available(ctx: Context) = TermuxWorker.state(ctx).optBoolean("installed", false)
}

object CapabilityRuntimes {
    fun all(): List<CapabilityRuntime> = listOf(
        NormalAndroidRuntime(), AccessibilityRuntime(), ShizukuRuntime(), RootRuntime(), TermuxRuntime()
    )
}
