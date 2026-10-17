package com.elly.assistant

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Termux Worker 协议骨架。
 * 当前阶段只负责结构化任务、权限边界和状态，不执行任意 shell。
 * 后续接入 Termux 时必须复用这个协议，而不是把用户文本拼接成 sh -c。
 */
object TermuxWorker {
    private const val PREFS = "elly_termux_worker"
    private const val TOKEN = "sessionToken"
    private val allowedExecutors = setOf("python", "node", "git", "rg", "ffmpeg")
    private val executablePaths = mapOf(
        "python" to "/data/data/com.termux/files/usr/bin/python",
        "node" to "/data/data/com.termux/files/usr/bin/node",
        "git" to "/data/data/com.termux/files/usr/bin/git",
        "rg" to "/data/data/com.termux/files/usr/bin/rg",
        "ffmpeg" to "/data/data/com.termux/files/usr/bin/ffmpeg"
    )

    fun state(ctx: Context): JSONObject = JSONObject().apply {
        put("installed", try { ctx.packageManager.getPackageInfo("com.termux", 0); true } catch (_: Exception) { false })
        put("connected", false)
        put("authenticated", false)
        put("protocolVersion", 1)
        put("endpoint", "local-authenticated-rpc")
    }

    fun createSession(ctx: Context): JSONObject {
        val token = UUID.randomUUID().toString().replace("-", "")
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply()
        return JSONObject().put("ok", true).put("protocolVersion", 1).put("token", token)
    }

    fun validateJob(job: JSONObject): JSONObject {
        val executor = job.optString("executor", "")
        val args = job.optJSONArray("args") ?: JSONArray()
        val cwd = job.optString("cwd", "")
        val taskId = job.optString("taskId", "")
        val timeout = job.optLong("timeoutMs", 60000L)
        if (!allowedExecutors.contains(executor)) return error("EXECUTOR_NOT_ALLOWED", "未允许的执行器：$executor")
        if (taskId.isBlank() || TaskWorkspace.taskDir(taskId) == null) return error("INVALID_TASK", "必须绑定有效任务")
        if (cwd.isBlank() || cwd.contains("..") || cwd.startsWith("/")) return error("INVALID_WORKDIR", "工作目录必须是当前任务工作区内的相对路径")
        if (timeout !in 1000..600000) return error("INVALID_TIMEOUT", "超时必须在 1 秒到 10 分钟之间")
        for (i in 0 until args.length()) {
            if (args.optString(i).contains("\u0000")) return error("INVALID_ARGUMENT", "参数包含非法字符")
        }
        return JSONObject().put("ok", true).put("jobId", job.optString("jobId", UUID.randomUUID().toString()))
    }

    /** Dispatches a structured command through Termux RUN_COMMAND; no shell string is accepted. */
    fun dispatch(ctx: Context, job: JSONObject): JSONObject {
        val checked = validateJob(job)
        if (!checked.optBoolean("ok", false)) return checked
        val executor = job.optString("executor")
        val taskId = job.optString("taskId")
        val taskDir = TaskWorkspace.taskDir(taskId) ?: return error("INVALID_TASK", "任务工作区不存在")
        val rel = job.optString("cwd").trim().ifBlank { "working" }
        val cwd = try { File(taskDir, rel).canonicalFile } catch (_: Exception) { return error("INVALID_WORKDIR", "工作目录无效") }
        val root = taskDir.canonicalFile
        if (cwd.path != root.path && !cwd.path.startsWith(root.path + File.separator)) return error("WORKDIR_ESCAPE", "工作目录越界")
        if (!cwd.isDirectory && !cwd.mkdirs()) return error("WORKDIR_MISSING", "工作目录不存在")
        return try {
            val args = job.optJSONArray("args") ?: JSONArray()
            val list = ArrayList<String>()
            for (i in 0 until args.length()) list.add(args.optString(i))
            val intent = Intent("com.termux.RUN_COMMAND").setPackage("com.termux")
                .putExtra("com.termux.RUN_COMMAND_PATH", executablePaths[executor])
                .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", list.toTypedArray())
                .putExtra("com.termux.RUN_COMMAND_WORKDIR", cwd.absolutePath)
                .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            ctx.startService(intent)
            JSONObject().put("ok", true).put("jobId", job.optString("jobId")).put("dispatched", true).put("workdir", cwd.absolutePath)
        } catch (e: Exception) { error("DISPATCH_FAILED", e.message ?: "Termux 启动失败") }
    }

    fun error(code: String, message: String) = JSONObject().put("ok", false).put("errorCode", code).put("error", message)
}
