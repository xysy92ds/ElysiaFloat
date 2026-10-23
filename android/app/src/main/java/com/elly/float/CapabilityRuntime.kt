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
    /** 检测 Shizuku 应用是否安装且服务进程正在运行。实际命令执行需接入 Shizuku SDK。 */
    override fun available(ctx: Context): Boolean {
        val installed = try {
            ctx.packageManager.getPackageInfo("rikka.shizuku", 0)
            true
        } catch (_: Exception) {
            try { ctx.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0); true } catch (_: Exception) { false }
        }
        if (!installed) return false
        // 检查 shizuku 服务进程是否在运行
        return try {
            val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", "ps -A 2>/dev/null | grep -i shizuku"))
            val out = java.io.BufferedReader(java.io.InputStreamReader(p.inputStream)).use { it.readText() }
            p.waitFor()
            out.contains("shizuku", ignoreCase = true)
        } catch (_: Exception) { false }
    }
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
