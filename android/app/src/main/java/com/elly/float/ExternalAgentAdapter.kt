package com.elly.assistant

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** 外部 Agent 的统一描述和注册表；具体 DSH 适配器留到后续阶段。 */
object ExternalAgentAdapter {
    private const val PREFS = "elly_external_agents"
    private const val LIST = "registry"

    fun normalize(raw: JSONObject): JSONObject? {
        val id = raw.optString("id", "").trim()
        val name = raw.optString("name", id).trim()
        if (!id.matches(Regex("[A-Za-z0-9_.-]{2,64}")) || name.isBlank()) return null
        val caps = JSONArray()
        val sourceCaps = raw.optJSONArray("capabilities") ?: JSONArray()
        for (i in 0 until sourceCaps.length()) {
            val value = sourceCaps.optString(i, "").trim()
            if (value in setOf("chat", "workspace", "device", "shell")) caps.put(value)
        }
        return JSONObject().apply {
            put("id", id)
            put("name", name.take(80))
            put("version", raw.optString("version", "unknown").take(32))
            put("transport", raw.optString("transport", "termux").take(24))
            put("entry", raw.optString("entry", "").take(200))
            put("capabilities", caps)
            put("enabled", raw.optBoolean("enabled", false))
            put("installed", raw.optBoolean("installed", false))
            put("source", raw.optString("source", "user").take(80))
        }
    }

    fun list(ctx: Context): JSONArray = try {
        JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LIST, "[]"))
    } catch (_: Exception) { JSONArray() }

    fun register(ctx: Context, raw: JSONObject): JSONObject {
        val item = normalize(raw) ?: return JSONObject().put("ok", false).put("errorCode", "INVALID_ADAPTER")
        val list = list(ctx)
        val result = JSONArray()
        for (i in 0 until list.length()) if (list.optJSONObject(i)?.optString("id") != item.optString("id")) result.put(list.getJSONObject(i))
        result.put(item)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(LIST, result.toString()).apply()
        return JSONObject().put("ok", true).put("agent", item)
    }
}
