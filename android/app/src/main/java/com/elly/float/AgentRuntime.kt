package com.elly.assistant

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Agent 能力运行时的统一状态层。
 * 这里只描述“可用能力”，不向 WebView 或插件暴露 Root/Shizuku 的原始句柄。
 */
object AgentRuntime {
    enum class Kind { ANDROID, ACCESSIBILITY, SHIZUKU, ROOT, TERMUX }

    fun state(ctx: Context): JSONObject {
        val access = EllyAccessibilityService.instance != null
        val root = hasRoot()
        val shizukuInstalled = hasPackage(ctx, "rikka.shizuku") || hasPackage(ctx, "moe.shizuku.privileged.api")
        val shizukuRuntime = ShizukuRuntime()
        val shizukuAuthorized = shizukuRuntime.available(ctx)
        val termux = hasPackage(ctx, "com.termux")
        val available = JSONArray().apply {
            put("android")
            if (access) put("accessibility")
            if (shizukuAuthorized) put("shizuku")
            if (root) put("root")
            if (termux) put("termux")
        }
        return JSONObject().apply {
            put("android", true)
            put("accessibility", access)
            put("shizukuInstalled", shizukuInstalled)
            put("shizukuAuthorized", shizukuAuthorized)
            put("rootAvailable", root)
            put("termuxInstalled", termux)
            put("termuxConnected", termux)
            put("apiLevel", Build.VERSION.SDK_INT)
            put("available", available)
        }
    }

    private fun hasPackage(ctx: Context, pkg: String): Boolean = try {
        ctx.packageManager.getPackageInfo(pkg, 0)
        true
    } catch (_: Exception) { false }

    private fun hasRoot(): Boolean = try {
        val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", "command -v su"))
        p.waitFor() == 0
    } catch (_: Exception) { false }
}
