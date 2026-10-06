package com.elly.assistant

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Agent 的 native 能力门。JS、prompt 和模型都不能替代这里的检查。
 * L1/L2/L3 是用户开关；L3 另外要求安全开关和白名单。
 */
object AgentPolicy {
    private const val PREFS = "elly_agent"
    const val KEY_AGENT = "agentEnabled"
    const val KEY_L1 = "agentL1"
    const val KEY_L2 = "agentL2"
    const val KEY_L3 = "agentL3"
    const val KEY_SAFETY = "agentSafety"
    const val KEY_AUTO_SHOT = "agentAutoShot"
    const val KEY_ON_DEMAND = "agentOnDemand"
    const val KEY_ALLOW_ALL = "agentAllowAll"
    private const val KEY_WHITE = "agentWhitelist"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun flag(ctx: Context, key: String, default: Boolean = false): Boolean =
        prefs(ctx).getBoolean(key, default)

    fun setFlag(ctx: Context, key: String, value: Boolean) {
        prefs(ctx).edit().putBoolean(key, value).apply()
    }

    fun whitelist(ctx: Context): Set<String> = try {
        prefs(ctx).getStringSet(KEY_WHITE, emptySet())?.toSet() ?: emptySet()
    } catch (_: Exception) { emptySet() }

    fun setWhitelist(ctx: Context, values: Set<String>) {
        prefs(ctx).edit().putStringSet(KEY_WHITE, values.toSet()).apply()
    }

    fun allowAll(ctx: Context): Boolean = flag(ctx, KEY_ALLOW_ALL)

    fun setAllowAll(ctx: Context, enabled: Boolean) = setFlag(ctx, KEY_ALLOW_ALL, enabled)

    fun isWhitelisted(ctx: Context, packageName: String): Boolean {
        if (packageName.isBlank() || packageName == ctx.packageName) return false
        return allowAll(ctx) || whitelist(ctx).contains(packageName)
    }

    fun currentPackage(): String = try {
        EllyAccessibilityService.instance?.foregroundPackageName().orEmpty()
    } catch (_: Exception) { "" }

    /** 只检查 Agent 能力开关，不绑定某个前台应用。用于工作区等不属于某个目标 App 的本地能力。 */
    fun checkAgentOnly(ctx: Context, level: String): String? {
        if (!flag(ctx, KEY_AGENT)) return "Agent 未开启"
        val levelOk = when (level) {
            "L1" -> flag(ctx, KEY_L1, true)
            "L2" -> flag(ctx, KEY_L2, true)
            "L3" -> flag(ctx, KEY_L3)
            else -> false
        }
        if (!levelOk) return "$level 能力未开启"
        if (level == "L3" && !flag(ctx, KEY_SAFETY)) return "请先打开安全开关"
        return null
    }

    /** 返回 null 表示允许，否则返回用户可见的拒绝原因。 */
    fun check(ctx: Context, level: String, targetPackage: String = currentPackage()): String? {
        if (!flag(ctx, KEY_AGENT)) return "Agent 未开启"
        val levelOk = when (level) {
            "L1" -> flag(ctx, KEY_L1, true)
            "L2" -> flag(ctx, KEY_L2, true)
            "L3" -> flag(ctx, KEY_L3)
            else -> false
        }
        if (!levelOk) return "$level 能力未开启"
        if (level == "L3" && !flag(ctx, KEY_SAFETY)) return "请先打开安全开关"
        if (!isWhitelisted(ctx, targetPackage)) {
            return if (targetPackage.isBlank()) "无法确认当前前台应用"
            else "当前应用 [$targetPackage] 不在白名单中"
        }
        return null
    }

    fun stateJson(ctx: Context): String = try {
        JSONObject().apply {
            put("agentEnabled", flag(ctx, KEY_AGENT))
            put("l1", flag(ctx, KEY_L1, true))
            put("l2", flag(ctx, KEY_L2, true))
            put("l3", flag(ctx, KEY_L3))
            put("safety", flag(ctx, KEY_SAFETY))
            put("autoShot", flag(ctx, KEY_AUTO_SHOT))
            put("onDemand", flag(ctx, KEY_ON_DEMAND, true))
            put("allowAll", allowAll(ctx))
            put("foregroundPackage", currentPackage())
            put("whitelist", JSONArray(whitelist(ctx).toList()))
        }.toString()
    } catch (_: Exception) { "{}" }
}
