package com.elly.assistant

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets

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

    /* ---------- Agent 状态、白名单与行为能力 ---------- */
    @JavascriptInterface
    fun getAgentState(): String = AgentPolicy.stateJson(ctx)

    @JavascriptInterface
    fun getForegroundPackage(): String = AgentPolicy.currentPackage()

    @JavascriptInterface
    fun setAgentFlag(key: String, value: Boolean): String {
        val allowed = setOf(
            AgentPolicy.KEY_AGENT, AgentPolicy.KEY_L1, AgentPolicy.KEY_L2,
            AgentPolicy.KEY_L3, AgentPolicy.KEY_SAFETY,
            AgentPolicy.KEY_AUTO_SHOT, AgentPolicy.KEY_ON_DEMAND
        )
        if (key !in allowed) return AgentPolicy.stateJson(ctx)
        AgentPolicy.setFlag(ctx, key, value)
        return AgentPolicy.stateJson(ctx)
    }

    @JavascriptInterface
    fun setAgentAllowAll(value: Boolean): String {
        AgentPolicy.setAllowAll(ctx, value)
        return AgentPolicy.stateJson(ctx)
    }

    @JavascriptInterface
    fun getAgentWhitelist(): String = try {
        JSONArray().apply { AgentPolicy.whitelist(ctx).sorted().forEach { put(it) } }.toString()
    } catch (_: Exception) { "[]" }

    /** 只返回真正有桌面启动入口的应用；设置页和 AI 都使用同一份设备实况。 */
    private data class AgentApp(val packageName: String, val label: String, val launchable: Boolean = true)

    private fun launchableApps(): List<AgentApp> {
        val pm = ctx.packageManager
        val own = ctx.packageName
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val infos = try { pm.queryIntentActivities(intent, PackageManager.MATCH_ALL) } catch (_: Exception) { emptyList() }
        val seen = HashSet<String>()
        return infos.mapNotNull { ri ->
            val ai = ri.activityInfo?.applicationInfo ?: return@mapNotNull null
            val pkg = ai.packageName ?: return@mapNotNull null
            if (pkg == own || !seen.add(pkg)) return@mapNotNull null
            val raw = try { ai.loadLabel(pm).toString().trim() } catch (_: Exception) { "" }
            AgentApp(pkg, raw.ifBlank { pkg })
        }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
    }

    private fun appJson(app: AgentApp, selected: Boolean = false): JSONObject = JSONObject().apply {
        put("package", app.packageName)
        put("label", app.label)
        put("selected", selected)
        put("launchable", app.launchable)
    }

    /** 按包名、精确名称或唯一的部分名称解析应用，不改变白名单本身。 */
    @JavascriptInterface
    fun findAgentApps(query: String): String = try {
        if (AgentPolicy.checkAgentOnly(ctx, "L1") != null) "[]"
        else {
            val q = query.trim()
            val all = launchableApps()
            val matches = if (q.isBlank()) all.take(100) else {
                val exactPkg = all.filter { it.packageName.equals(q, true) }
                val exactName = all.filter { it.label.equals(q, true) }
                val part = all.filter { it.packageName.contains(q, true) || it.label.contains(q, true) }
                (exactPkg + exactName + part).distinctBy { it.packageName }.take(50)
            }
            JSONArray().apply { matches.forEach { put(appJson(it, AgentPolicy.isWhitelisted(ctx, it.packageName))) } }.toString()
        }
    } catch (_: Exception) { "[]" }

    @JavascriptInterface
    fun addAgentWhitelist(packageName: String): String {
        val pkg = packageName.trim()
        if (pkg.isBlank() || pkg == ctx.packageName) return AgentPolicy.stateJson(ctx)
        return try {
            ctx.packageManager.getApplicationInfo(pkg, 0)
            AgentPolicy.setWhitelist(ctx, AgentPolicy.whitelist(ctx) + pkg)
            AgentPolicy.stateJson(ctx)
        } catch (_: Exception) { AgentPolicy.stateJson(ctx) }
    }

    @JavascriptInterface
    fun removeAgentWhitelist(packageName: String): String {
        AgentPolicy.setWhitelist(ctx, AgentPolicy.whitelist(ctx) - packageName.trim())
        return AgentPolicy.stateJson(ctx)
    }

    @JavascriptInterface
    fun listAgentApps(): String = try {
        JSONArray().apply {
            launchableApps().take(500).forEach { app ->
                put(appJson(app, AgentPolicy.isWhitelisted(ctx, app.packageName)))
            }
        }.toString()
    } catch (_: Exception) { "[]" }

    private fun agentResult(level: String, ok: Boolean, error: String = ""): String =
        JSONObject().apply { put("ok", ok); put("level", level); if (!ok) put("error", error) }.toString()

    @JavascriptInterface
    fun agentTap(x: Int, y: Int): String {
        val denied = AgentPolicy.check(ctx, "L3")
        if (denied != null) return agentResult("L3", false, denied)
        val ok = EllyAccessibilityService.instance?.tap(x, y) == true
        return agentResult("L3", ok, if (ok) "" else "点击未完成")
    }

    @JavascriptInterface
    fun agentClickText(text: String): String {
        val denied = AgentPolicy.check(ctx, "L3")
        if (denied != null) return agentResult("L3", false, denied)
        val ok = EllyAccessibilityService.instance?.clickText(text) == true
        return agentResult("L3", ok, if (ok) "" else "找不到可点击的文字")
    }

    @JavascriptInterface
    fun agentSwipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): String {
        val denied = AgentPolicy.check(ctx, "L3")
        if (denied != null) return agentResult("L3", false, denied)
        val ok = EllyAccessibilityService.instance?.swipe(x1, y1, x2, y2, durationMs) == true
        return agentResult("L3", ok, if (ok) "" else "滑动未完成")
    }

    @JavascriptInterface
    fun agentInputText(text: String): String {
        val denied = AgentPolicy.check(ctx, "L3")
        if (denied != null) return agentResult("L3", false, denied)
        val ok = EllyAccessibilityService.instance?.inputText(text) == true
        return agentResult("L3", ok, if (ok) "" else "无障碍输入失败；请启用并切换到爱莉希雅输入法后重试")
    }

    @JavascriptInterface
    fun isElysiaImeEnabled(): Boolean = try {
        val imm = ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
        imm.enabledInputMethodList.any { it.packageName == ctx.packageName }
    } catch (_: Exception) { false }

    @JavascriptInterface
    fun requestElysiaImeSettings() {
        try {
            ctx.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { }
    }

    @JavascriptInterface
    fun agentKey(name: String): String {
        val denied = AgentPolicy.check(ctx, "L3")
        if (denied != null) return agentResult("L3", false, denied)
        val ok = EllyAccessibilityService.instance?.globalAction(name) == true
        return agentResult("L3", ok, if (ok) "" else "不支持的系统按键或执行失败")
    }

    @JavascriptInterface
    fun agentLaunch(appOrPackage: String): String {
        val input = appOrPackage.trim()
        if (input.isBlank()) return agentResult("L3", false, "缺少应用名称或包名")
        val all = launchableApps()
        val packageExact = all.filter { it.packageName.equals(input, true) }
        val labelExact = all.filter { it.label.equals(input, true) }
        val candidates = when {
            packageExact.size == 1 -> packageExact
            labelExact.isNotEmpty() -> labelExact
            else -> all.filter { it.packageName.contains(input, true) || it.label.contains(input, true) }
        }
        if (candidates.isEmpty()) return agentResult("L3", false, "设备上没有找到可启动的应用：$input")
        if (candidates.size > 1) {
            val names = candidates.take(5).joinToString("、") { "${it.label}（${it.packageName}）" }
            return agentResult("L3", false, "找到多个匹配应用，请改用包名：$names")
        }
        val app = candidates.first()
        val denied = AgentPolicy.check(ctx, "L3", app.packageName)
        if (denied != null) return agentResult("L3", false, denied + "；目标应用：${app.label}（${app.packageName}）")
        return try {
            val intent = ctx.packageManager.getLaunchIntentForPackage(app.packageName)
                ?: return agentResult("L3", false, "目标应用没有可启动的入口：${app.label}")
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            JSONObject().apply {
                put("ok", true); put("level", "L3"); put("package", app.packageName); put("label", app.label)
            }.toString()
        } catch (e: Exception) { agentResult("L3", false, e.message ?: "启动失败：${app.label}") }
    }

    /* ---------- 读屏 ---------- */
    @JavascriptInterface
    fun getScreenText(): String = try {
        if (AgentPolicy.check(ctx, "L1") != null) ""
        else EllyAccessibilityService.instance?.dumpScreenText() ?: ""
    } catch (e: Exception) { "" }

    @JavascriptInterface
    fun getBrowserUrl(): String = try {
        if (AgentPolicy.check(ctx, "L1") != null) ""
        else EllyAccessibilityService.instance?.guessBrowserUrl() ?: ""
    } catch (e: Exception) { "" }

    /**
     * 「文字 + 坐标」一次性拿走，屏幕翻译原位覆盖就靠它。
     * 返回 JSON 数组：[{t,x,y,w,h}]，单位屏幕物理像素；拿不到返回 []。
     */
    @JavascriptInterface
    fun getScreenNodes(): String = try {
        if (AgentPolicy.check(ctx, "L1") != null) "[]"
        else EllyAccessibilityService.instance?.dumpScreenNodes() ?: "[]"
    } catch (e: Exception) { "[]" }

    /** 屏幕物理像素尺寸（覆盖层定位用）。 */
    @JavascriptInterface
    fun getScreenSize(): String = try {
        val dm = ctx.resources.displayMetrics
        org.json.JSONObject().apply {
            put("w", dm.widthPixels)
            put("h", dm.heightPixels)
            put("density", dm.density.toDouble())
        }.toString()
    } catch (e: Exception) { "{}" }

    /* ---------- 截屏 ---------- */
    @JavascriptInterface
    fun canScreenshot(): Boolean = try {
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && EllyAccessibilityService.instance != null) ||
                FloatService.instance != null
    } catch (e: Exception) { false }

    /** 截屏结果通过 window.__shotDone(dataUrl|null) 异步回传 */
    @JavascriptInterface
    fun captureScreen() {
        try {
            if (AgentPolicy.check(ctx, "L2") != null) {
                FloatService.instance?.deliverScreenshot(null)
                return
            }
            FloatService.instance?.requestScreenshot()
        } catch (e: Exception) {
            FloatService.instance?.deliverScreenshot(null)
        }
    }

    /* ---------- 文件访问与用户工作区 ---------- */
    @JavascriptInterface
    fun hasAllFilesAccess(): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else ctx.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    } catch (_: Exception) { false }

    @JavascriptInterface
    fun requestAllFilesAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            val act = MainActivity.current
            if (act != null && ctx.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                act.runOnUiThread {
                    try { act.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1002) } catch (_: Exception) { }
                }
                return
            }
        }
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                    .setData(Uri.parse("package:${ctx.packageName}"))
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:${ctx.packageName}"))
            }
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            try { ctx.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
        }
    }

    private fun workspaceRoot(): File = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
        "ElysiaFloat/workspace"
    )

    private fun workspaceFile(relative: String, allowRoot: Boolean = false): File? {
        val raw = relative.trim().replace('\\', '/')
        if (!allowRoot && raw.isBlank()) return null
        if (raw.startsWith("/") || raw.contains(":") || raw.split('/').any { it == ".." }) return null
        val root = workspaceRoot()
        val rootCanonical = try { root.canonicalFile } catch (_: Exception) { return null }
        val candidate = try { File(rootCanonical, raw).canonicalFile } catch (_: Exception) { return null }
        val base = rootCanonical.path + File.separator
        if (candidate.path != rootCanonical.path && !candidate.path.startsWith(base)) return null
        return candidate
    }

    private fun workspaceDenied(level: String = "L1"): String? {
        if (!hasAllFilesAccess()) return "请先开启允许管理所有文件"
        if (!workspaceRoot().isDirectory) return "请先创建 ElysiaFloat 工作区"
        return AgentPolicy.checkAgentOnly(ctx, level)
    }

    @JavascriptInterface
    fun workspaceState(): String = try {
        val root = workspaceRoot()
        JSONObject().apply {
            put("ok", true)
            put("permission", hasAllFilesAccess())
            put("created", root.isDirectory)
            put("name", "ElysiaFloat/workspace")
            put("path", root.absolutePath)
            put("items", if (root.isDirectory) root.listFiles()?.size ?: 0 else 0)
        }.toString()
    } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "无法读取工作区状态").toString() }

    @JavascriptInterface
    fun createWorkspace(): String {
        if (!hasAllFilesAccess()) return JSONObject().put("ok", false).put("error", "请先开启允许管理所有文件").toString()
        return try {
            val root = workspaceRoot()
            if (!root.exists() && !root.mkdirs()) throw Exception("工作区目录创建失败")
            val readme = File(root, "README.md")
            if (!readme.exists()) {
                readme.writeText("# ElysiaFloat 工作区\n\n这里是爱莉希雅被允许读写的目录。\n", Charsets.UTF_8)
            }
            workspaceState()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "工作区创建失败").toString() }
    }

    @JavascriptInterface
    fun agentWorkspaceList(relative: String): String {
        val denied = workspaceDenied("L3")
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val dir = workspaceFile(relative, true) ?: return JSONObject().put("ok", false).put("error", "工作区路径不合法").toString()
        if (!dir.isDirectory) return JSONObject().put("ok", false).put("error", "目录不存在").toString()
        return try {
            val arr = JSONArray()
            dir.listFiles()?.sortedWith(compareBy<File> { !it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })?.take(200)?.forEach {
                arr.put(JSONObject().apply { put("name", it.name); put("directory", it.isDirectory); put("size", if (it.isFile) it.length() else 0L); put("modified", it.lastModified()) })
            }
            JSONObject().put("ok", true).put("relative", relative.trim()).put("items", arr).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "读取目录失败").toString() }
    }

    @JavascriptInterface
    fun agentWorkspaceRead(relative: String, maxChars: Int): String {
        val denied = workspaceDenied("L3")
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val file = workspaceFile(relative) ?: return JSONObject().put("ok", false).put("error", "工作区路径不合法").toString()
        if (!file.isFile) return JSONObject().put("ok", false).put("error", "文件不存在").toString()
        return try {
            val limit = maxChars.coerceIn(1, 500_000)
            val cap = limit * 4
            val bytes = FileInputStream(file).use { input ->
                val buf = ByteArray(cap)
                var total = 0
                while (total < cap) {
                    val n = input.read(buf, total, cap - total)
                    if (n <= 0) break
                    total += n
                }
                buf.copyOf(total)
            }
            val text = String(bytes, StandardCharsets.UTF_8)
            JSONObject().put("ok", true).put("relative", relative.trim()).put("name", file.name)
                .put("text", if (text.length > limit) text.substring(0, limit) + "\n…（已截断）" else text).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "读取文件失败").toString() }
    }

    @JavascriptInterface
    fun agentWorkspaceWrite(relative: String, text: String, overwrite: Boolean): String {
        val denied = workspaceDenied("L3")
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val file = workspaceFile(relative) ?: return JSONObject().put("ok", false).put("error", "工作区路径不合法").toString()
        if (file.exists() && !overwrite) return JSONObject().put("ok", false).put("error", "文件已存在，需明确允许覆盖").toString()
        if (text.length > 500_000) return JSONObject().put("ok", false).put("error", "单个文件不能超过 500KB").toString()
        return try {
            file.parentFile?.mkdirs()
            FileOutputStream(file, false).use { it.write(text.toByteArray(StandardCharsets.UTF_8)) }
            JSONObject().put("ok", true).put("relative", relative.trim()).put("bytes", file.length()).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "写入文件失败").toString() }
    }

    @JavascriptInterface
    fun agentWorkspaceMkdir(relative: String): String {
        val denied = workspaceDenied("L3")
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val dir = workspaceFile(relative) ?: return JSONObject().put("ok", false).put("error", "工作区路径不合法").toString()
        return try {
            JSONObject().put("ok", dir.isDirectory || dir.mkdirs()).put("relative", relative.trim())
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "创建目录失败") }.toString()
    }

    /* ---------- 公共存储文件访问 ---------- */
    private fun externalPublicFile(path: String, allowRoot: Boolean = false): File? {
        val raw = path.trim().replace('\\', '/')
        if (!allowRoot && raw.isBlank()) return null
        val root = try { Environment.getExternalStorageDirectory().canonicalFile } catch (_: Exception) { return null }
        if (raw.split('/').any { it == ".." }) return null
        val candidate = try {
            if (raw.startsWith("/")) File(raw).canonicalFile else File(root, raw).canonicalFile
        } catch (_: Exception) { return null }
        val base = root.path + File.separator
        if (candidate.path != root.path && !candidate.path.startsWith(base)) return null
        return candidate
    }

    private fun externalReadDenied(): String? {
        if (!hasAllFilesAccess()) return "请先开启允许管理所有文件"
        return AgentPolicy.checkAgentOnly(ctx, "L3")
    }

    private fun externalWriteDenied(): String? = externalReadDenied()

    @JavascriptInterface
    fun agentExternalList(path: String): String {
        val denied = externalReadDenied()
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val dir = externalPublicFile(path, true) ?: return JSONObject().put("ok", false).put("error", "外部文件路径不合法").toString()
        if (!dir.isDirectory) return JSONObject().put("ok", false).put("error", "目录不存在").toString()
        return try {
            val arr = JSONArray()
            dir.listFiles()?.sortedWith(compareBy<File> { !it.isDirectory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })?.take(200)?.forEach {
                arr.put(JSONObject().apply { put("name", it.name); put("directory", it.isDirectory); put("size", if (it.isFile) it.length() else 0L); put("modified", it.lastModified()) })
            }
            JSONObject().put("ok", true).put("path", dir.absolutePath).put("items", arr).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "读取外部目录失败").toString() }
    }

    @JavascriptInterface
    fun agentExternalRead(path: String, maxChars: Int): String {
        val denied = externalReadDenied()
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val file = externalPublicFile(path) ?: return JSONObject().put("ok", false).put("error", "外部文件路径不合法").toString()
        if (!file.isFile) return JSONObject().put("ok", false).put("error", "文件不存在").toString()
        return try {
            val limit = maxChars.coerceIn(1, 500_000)
            val cap = limit * 4
            val bytes = FileInputStream(file).use { input ->
                val buf = ByteArray(cap)
                var total = 0
                while (total < cap) {
                    val n = input.read(buf, total, cap - total)
                    if (n <= 0) break
                    total += n
                }
                buf.copyOf(total)
            }
            val text = String(bytes, StandardCharsets.UTF_8)
            JSONObject().put("ok", true).put("path", file.absolutePath).put("name", file.name)
                .put("text", if (text.length > limit) text.substring(0, limit) + "\n…（已截断）" else text).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "读取外部文件失败").toString() }
    }

    @JavascriptInterface
    fun agentExternalWrite(path: String, text: String, overwrite: Boolean): String {
        val denied = externalWriteDenied()
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val file = externalPublicFile(path) ?: return JSONObject().put("ok", false).put("error", "外部文件路径不合法").toString()
        if (file.isDirectory) return JSONObject().put("ok", false).put("error", "目标是目录").toString()
        if (file.exists() && !overwrite) return JSONObject().put("ok", false).put("error", "文件已存在，需明确允许覆盖").toString()
        if (text.length > 500_000) return JSONObject().put("ok", false).put("error", "单个文本文件不能超过 500KB").toString()
        return try {
            file.parentFile?.mkdirs()
            FileOutputStream(file, false).use { it.write(text.toByteArray(StandardCharsets.UTF_8)) }
            JSONObject().put("ok", true).put("path", file.absolutePath).put("bytes", file.length()).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "写入外部文件失败").toString() }
    }

    @JavascriptInterface
    fun agentExternalMkdir(path: String): String {
        val denied = externalWriteDenied()
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val dir = externalPublicFile(path) ?: return JSONObject().put("ok", false).put("error", "外部文件路径不合法").toString()
        return try {
            JSONObject().put("ok", dir.isDirectory || dir.mkdirs()).put("path", dir.absolutePath)
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "创建外部目录失败") }.toString()
    }

    @JavascriptInterface
    fun agentExternalCopy(source: String, destination: String, overwrite: Boolean): String {
        val denied = externalWriteDenied()
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val from = externalPublicFile(source) ?: return JSONObject().put("ok", false).put("error", "源文件路径不合法").toString()
        val to = externalPublicFile(destination) ?: return JSONObject().put("ok", false).put("error", "目标文件路径不合法").toString()
        if (!from.isFile) return JSONObject().put("ok", false).put("error", "源文件不存在").toString()
        if (to.isDirectory) return JSONObject().put("ok", false).put("error", "目标路径是目录，请提供目标文件名").toString()
        if (from.path == to.path) return JSONObject().put("ok", false).put("error", "源文件和目标文件相同").toString()
        if (to.exists() && !overwrite) return JSONObject().put("ok", false).put("error", "目标文件已存在，需明确允许覆盖").toString()
        if (from.length() > 100L * 1024L * 1024L) return JSONObject().put("ok", false).put("error", "单次复制不能超过 100MB").toString()
        return try {
            to.parentFile?.mkdirs()
            FileInputStream(from).use { input -> FileOutputStream(to, false).use { output -> input.copyTo(output) } }
            JSONObject().put("ok", true).put("source", from.absolutePath).put("path", to.absolutePath).put("bytes", to.length()).toString()
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "复制文件失败").toString() }
    }

    @JavascriptInterface
    fun agentExternalDelete(path: String, recursive: Boolean): String {
        val denied = externalWriteDenied()
        if (denied != null) return JSONObject().put("ok", false).put("error", denied).toString()
        val file = externalPublicFile(path) ?: return JSONObject().put("ok", false).put("error", "外部文件路径不合法").toString()
        if (!file.exists()) return JSONObject().put("ok", false).put("error", "文件或目录不存在").toString()
        return try {
            val deleted = if (recursive && file.isDirectory) file.deleteRecursively() else file.delete()
            JSONObject().put("ok", deleted).put("path", file.absolutePath)
                .put("error", if (deleted) JSONObject.NULL else "删除失败，非空目录需要 recursive=true")
        } catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: "删除外部文件失败") }.toString()
    }

    /* ---------- 通知渠道（Android 8+ 特有） ---------- */
    /**
     * 注意：Android 8 起，用户关了「爱莉希雅浮窗」这个通知渠道的话，
     * 前台服务会被系统直接杀掉 —— 浮窗消失、息屏断掉都可能是这个原因。
     * 而 hasNotification() 在 8~12 上恒为 true，发现不了这种情况，
     * 所以单独开一个检查项。
     */
    @JavascriptInterface
    fun isNotificationChannelOn(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // 浮窗前台服务这条；以及音乐媒体通知那条（没建过 = 还没用过 = 视为没关）
            val ids = arrayOf(FloatService.CHANNEL_ID, AudioEngine.CHANNEL_MUSIC)
            ids.all { id ->
                val ch = nm.getNotificationChannel(id) ?: return@all true
                ch.importance != NotificationManager.IMPORTANCE_NONE
            }
        } catch (e: Exception) { true }
    }

    @JavascriptInterface
    fun requestNotificationChannel() {
        try {
            // 直接进 App 的通知设置页（而不是单个渠道）：
            // 引导里查的是「浮窗」和「正在播放」两条，哪一条被关了都能在这一页看到
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:${ctx.packageName}"))
            }
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            try {
                ctx.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e2: Exception) { }
        }
    }

    /* ---------- 环境信息（低版本排错用） ---------- */
    @JavascriptInterface
    fun getEnvInfo(): String = try {
        val dm = ctx.resources.displayMetrics
        val pm = ctx.packageManager
        var wvPkg = "-"
        var wvVer = "-"
        try {
            val info: android.content.pm.PackageInfo? = if (Build.VERSION.SDK_INT >= 26) {
                android.webkit.WebView.getCurrentWebViewPackage()
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo("com.google.android.webview", 0)
            }
            if (info != null) {
                wvPkg = info.packageName
                wvVer = info.versionName ?: "-"
            }
        } catch (e: Exception) { }

        var appVer = "-"
        try {
            @Suppress("DEPRECATION")
            appVer = pm.getPackageInfo(ctx.packageName, 0).versionName ?: "-"
        } catch (e: Exception) { }

        JSONObject().apply {
            put("sdk", Build.VERSION.SDK_INT)
            put("release", Build.VERSION.RELEASE ?: "-")
            put("brand", Build.BRAND ?: "-")
            put("model", Build.MODEL ?: "-")
            put("webviewPkg", wvPkg)
            put("webviewVer", wvVer)
            put("appVer", appVer)
            put("density", dm.density.toDouble())
            put("densityDpi", dm.densityDpi)
            put("screenW", dm.widthPixels)
            put("screenH", dm.heightPixels)
        }.toString()
    } catch (e: Exception) { "{}" }

    /* ---------- 窗口移动 / 缩放 ---------- */
    @JavascriptInterface
    fun moveWindow(dx: Int, dy: Int) {
        (ctx as? FloatService)?.moveBy(dx, dy)
    }

    /** 直接给绝对坐标（拖左/上边缘时用）。返回实际生效的矩形 JSON。 */
    @JavascriptInterface
    fun moveWindowTo(x: Int, y: Int): String =
        (ctx as? FloatService)?.moveWindowTo(x, y) ?: "{}"

    @JavascriptInterface
    fun resizeWindow(w: Int, h: Int) {
        (ctx as? FloatService)?.resize(w, h)
    }

    @JavascriptInterface
    fun getWindowRect(): String {
        return (ctx as? FloatService)?.windowRectJson() ?: "{}"
    }

    /** 返回实际生效的矩形 —— JS 靠它校正缩放比，面板与窗口就不会脱节。 */
    @JavascriptInterface
    fun setWindowRect(x: Int, y: Int, w: Int, h: Int): String =
        (ctx as? FloatService)?.setWindowRect(x, y, w, h) ?: "{}"

    /** 原生侧的尺寸上下限（物理像素），JS 自己算清楚就不会白跑一趟。 */
    @JavascriptInterface
    fun getWindowLimits(): String =
        (ctx as? FloatService)?.windowLimitsJson() ?: "{}"
}
