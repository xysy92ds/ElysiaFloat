package com.elly.assistant

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Termux Worker：通过 Termux RUN_COMMAND 执行结构化任务。
 *
 * 关键能力：
 * - run_id 追踪每个任务
 * - 输出重定向到日志文件，可随时读取
 * - PID 追踪，支持取消
 * - 长跑任务（服务器、bot 等）不超时中断
 *
 * 安全边界：
 * - 只允许白名单执行器，不接受任意 shell 字符串
 * - 工作目录限制在任务工作区内
 * - 每个任务生成 wrapper 脚本，不直接拼接用户输入到 shell
 */
object TermuxWorker {
    private const val PREFS = "elly_termux_worker"
    private const val TOKEN = "sessionToken"
    private const val JOBS_DIR = ".termux-jobs"
    private const val FIXED_JOBS_DIR = "deps-jobs"
    private const val LOG_MAX_BYTES = 200_000L
    private const val AUDIT_MAX_BYTES = 200_000
    private val RUN_ID_RE = Regex("[A-Za-z0-9_-]{1,96}")
    private val PKG_NAME_RE = Regex("[A-Za-z0-9@][A-Za-z0-9@/._+-]{0,119}")
    private val VERSION_RE = Regex("[A-Za-z0-9][A-Za-z0-9._+-]{0,63}")
    private const val PKG_PATH = "/data/data/com.termux/files/usr/bin/pkg"
    private const val NPM_PATH = "/data/data/com.termux/files/usr/bin/npm"

    private val allowedExecutors = setOf("python", "node", "git", "rg", "ffmpeg", "java", "bash")
    private val executablePaths = mapOf(
        "python" to "/data/data/com.termux/files/usr/bin/python",
        "node" to "/data/data/com.termux/files/usr/bin/node",
        "git" to "/data/data/com.termux/files/usr/bin/git",
        "rg" to "/data/data/com.termux/files/usr/bin/rg",
        "ffmpeg" to "/data/data/com.termux/files/usr/bin/ffmpeg",
        "java" to "/data/data/com.termux/files/usr/bin/java",
        "bash" to "/data/data/com.termux/files/usr/bin/bash"
    )
    private const val BASH_PATH = "/data/data/com.termux/files/usr/bin/bash"

    fun state(ctx: Context): JSONObject = JSONObject().apply {
        put("installed", try { ctx.packageManager.getPackageInfo("com.termux", 0); true } catch (_: Exception) { false })
        put("connected", false)
        put("authenticated", false)
        put("protocolVersion", 2)
        put("endpoint", "local-authenticated-rpc")
        put("executors", JSONArray().apply { allowedExecutors.forEach { put(it) } })
    }

    fun createSession(ctx: Context): JSONObject {
        val token = UUID.randomUUID().toString().replace("-", "")
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply()
        return JSONObject().put("ok", true).put("protocolVersion", 2).put("token", token)
    }

    fun validateJob(job: JSONObject): JSONObject {
        val executor = job.optString("executor", "")
        val args = job.optJSONArray("args") ?: JSONArray()
        val cwd = job.optString("cwd", "")
        val taskId = job.optString("taskId", "")
        if (!allowedExecutors.contains(executor)) return error("EXECUTOR_NOT_ALLOWED", "未允许的执行器：$executor")
        if (taskId.isBlank() || TaskWorkspace.taskDir(taskId) == null) return error("INVALID_TASK", "必须绑定有效任务")
        if (cwd.contains("..") || cwd.startsWith("/")) return error("INVALID_WORKDIR", "工作目录必须是当前任务工作区内的相对路径")
        for (i in 0 until args.length()) {
            val a = args.optString(i)
            if (a.contains("\u0000")) return error("INVALID_ARGUMENT", "参数包含非法字符")
        }
        return JSONObject().put("ok", true).put("jobId", job.optString("jobId", UUID.randomUUID().toString()))
    }

    /**
     * 派发任务到 Termux。
     * 生成 wrapper 脚本：写 PID → 执行命令 → 重定向输出 → 写退出码。
     * 这样可以实现 run_id 追踪、输出读取、进程取消。
     */
    fun dispatch(ctx: Context, job: JSONObject): JSONObject {
        val checked = validateJob(job)
        if (!checked.optBoolean("ok", false)) return checked
        val runId = checked.optString("jobId")
        if (!RUN_ID_RE.matches(runId)) return error("INVALID_RUN_ID", "任务 id 不合法")
        val timeoutSec = (job.optLong("timeoutMs", 0L) / 1000L).coerceIn(0L, 24L * 3600L)
        val executor = job.optString("executor")
        val taskId = job.optString("taskId")
        val taskDir = TaskWorkspace.taskDir(taskId) ?: return error("INVALID_TASK", "任务工作区不存在")
        val rel = job.optString("cwd").trim().ifBlank { "working" }
        val cwd = try { File(taskDir, rel).canonicalFile } catch (_: Exception) { return error("INVALID_WORKDIR", "工作目录无效") }
        val root = taskDir.canonicalFile
        if (cwd.path != root.path && !cwd.path.startsWith(root.path + File.separator)) return error("WORKDIR_ESCAPE", "工作目录越界")
        if (!cwd.isDirectory && !cwd.mkdirs()) return error("WORKDIR_MISSING", "工作目录不存在")

        val jobsDir = File(taskDir, JOBS_DIR)
        if (!jobsDir.isDirectory && !jobsDir.mkdirs()) return error("JOBS_DIR_FAILED", "无法创建任务目录")

        // 构建实际命令的参数数组（转义后用空格拼接，在 bash 脚本中用 eval-safe 的方式调用）
        val args = job.optJSONArray("args") ?: JSONArray()
        val argList = ArrayList<String>()
        for (i in 0 until args.length()) argList.add(args.optString(i))
        val execPath = executablePaths[executor] ?: return error("EXECUTOR_NOT_FOUND", "执行器路径未配置：$executor")

        // 把参数逐个单引号转义，避免 shell 注入
        val escapedArgs = argList.joinToString(" ") { shellQuote(it) }

        // wrapper 脚本：后台执行 + 信号文件取消 + 输出重定向
        // 注意：App 和 Termux 是不同 UID，App 不能直接 kill Termux 的进程，
        // 所以用信号文件机制：App 创建 .cancel 文件，wrapper 检测到后 kill 子进程。
        val script = """#!/data/data/com.termux/files/usr/bin/bash
PIDFILE="${jobsDir.absolutePath}/$runId.pid"
LOGFILE="${jobsDir.absolutePath}/$runId.log"
EXITFILE="${jobsDir.absolutePath}/$runId.exit"
CANCELFILE="${jobsDir.absolutePath}/$runId.cancel"
TIMEOUT=$timeoutSec
START=${'$'}(date +%s)
rm -f "${'$'}CANCELFILE"
echo ${'$'}${'$'} > "${'$'}PIDFILE"
"$execPath" $escapedArgs > "${'$'}LOGFILE" 2>&1 &
CHILD=${'$'}!
TIMEDOUT=0
# 等待子进程结束，或检测到取消/超时信号
while kill -0 ${'$'}CHILD 2>/dev/null; do
  if [ -f "${'$'}CANCELFILE" ]; then
    kill -TERM ${'$'}CHILD 2>/dev/null
    sleep 2
    kill -KILL ${'$'}CHILD 2>/dev/null
    rm -f "${'$'}CANCELFILE"
    break
  fi
  if [ "${'$'}TIMEOUT" -gt 0 ] && [ ${'$'}(( ${'$'}(date +%s) - START )) -ge "${'$'}TIMEOUT" ]; then
    kill -TERM ${'$'}CHILD 2>/dev/null
    sleep 2
    kill -KILL ${'$'}CHILD 2>/dev/null
    TIMEDOUT=1
    break
  fi
  sleep 1
done
wait ${'$'}CHILD 2>/dev/null
CODE=${'$'}?
if [ "${'$'}TIMEDOUT" = "1" ]; then CODE=124; fi
echo ${'$'}CODE > "${'$'}EXITFILE"
# 日志上限：只保留最后 200KB，长跑任务不能把工作区撑爆
if [ -f "${'$'}LOGFILE" ]; then tail -c 200000 "${'$'}LOGFILE" > "${'$'}LOGFILE.tmp" && mv -f "${'$'}LOGFILE.tmp" "${'$'}LOGFILE"; fi
rm -f "${'$'}PIDFILE"
"""
        val scriptFile = File(jobsDir, "$runId.sh")
        try {
            scriptFile.writeText(script)
            scriptFile.setExecutable(true)
        } catch (e: Exception) { return error("SCRIPT_WRITE_FAILED", e.message ?: "脚本写入失败") }

        return try {
            val intent = Intent("com.termux.RUN_COMMAND").setPackage("com.termux")
                .putExtra("com.termux.RUN_COMMAND_PATH", BASH_PATH)
                .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf(scriptFile.absolutePath))
                .putExtra("com.termux.RUN_COMMAND_WORKDIR", cwd.absolutePath)
                .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            ctx.startService(intent)
            audit(ctx, "dispatch", runId, taskId)
            JSONObject().put("ok", true)
                .put("runId", runId)
                .put("dispatched", true)
                .put("timeoutSec", timeoutSec)
                .put("workdir", cwd.absolutePath)
                .put("logFile", "$JOBS_DIR/$runId.log")
        } catch (e: Exception) { error("DISPATCH_FAILED", e.message ?: "Termux 启动失败") }
    }

    /**
     * 固定模板安装（0.12 / E5）：只接受 termux-pkg 与 npm 两种，不拼接任意 shell。
     * 包名与版本走白名单正则；命令模板写死，用户只能给包名。
     */
    fun runFixed(ctx: Context, reqJson: String): JSONObject {
        val req = try { JSONObject(reqJson) } catch (_: Exception) { return error("INVALID_REQUEST", "请求格式无效") }
        if (req.optString("op") != "install") return error("OP_NOT_ALLOWED", "只支持 install")
        val kind = req.optString("kind")
        val name = req.optString("name")
        val version = req.optString("version")
        if (kind != "termux-pkg" && kind != "npm") return error("KIND_NOT_ALLOWED", "只支持 termux-pkg / npm")
        if (!PKG_NAME_RE.matches(name)) return error("INVALID_PACKAGE", "包名不合法")
        val hasVersion = version.isNotBlank()
        if (hasVersion && !VERSION_RE.matches(version)) return error("INVALID_VERSION", "版本号不合法")

        val runId = UUID.randomUUID().toString().replace("-", "")
        val jobsDir = File(TaskWorkspace.root(), FIXED_JOBS_DIR)
        if (!jobsDir.isDirectory && !jobsDir.mkdirs()) return error("JOBS_DIR_FAILED", "无法创建依赖任务目录")

        val target = if (hasVersion) "$name@$version" else name
        val command = if (kind == "termux-pkg") {
            "${shellQuote(PKG_PATH)} install -y ${shellQuote(name)}"
        } else {
            "${shellQuote(NPM_PATH)} install -g ${shellQuote(target)}"
        }

        val script = """#!/data/data/com.termux/files/usr/bin/bash
PIDFILE="${jobsDir.absolutePath}/$runId.pid"
LOGFILE="${jobsDir.absolutePath}/$runId.log"
EXITFILE="${jobsDir.absolutePath}/$runId.exit"
CANCELFILE="${jobsDir.absolutePath}/$runId.cancel"
TIMEOUT=900
START=${'$'}(date +%s)
rm -f "${'$'}CANCELFILE"
echo ${'$'}${'$'} > "${'$'}PIDFILE"
$command > "${'$'}LOGFILE" 2>&1 &
CHILD=${'$'}!
TIMEDOUT=0
while kill -0 ${'$'}CHILD 2>/dev/null; do
  if [ -f "${'$'}CANCELFILE" ]; then
    kill -TERM ${'$'}CHILD 2>/dev/null; sleep 2; kill -KILL ${'$'}CHILD 2>/dev/null
    rm -f "${'$'}CANCELFILE"; break
  fi
  if [ ${'$'}(( ${'$'}(date +%s) - START )) -ge "${'$'}TIMEOUT" ]; then
    kill -TERM ${'$'}CHILD 2>/dev/null; sleep 2; kill -KILL ${'$'}CHILD 2>/dev/null
    TIMEDOUT=1; break
  fi
  sleep 1
done
wait ${'$'}CHILD 2>/dev/null
CODE=${'$'}?
if [ "${'$'}TIMEDOUT" = "1" ]; then CODE=124; fi
echo ${'$'}CODE > "${'$'}EXITFILE"
if [ -f "${'$'}LOGFILE" ]; then tail -c 200000 "${'$'}LOGFILE" > "${'$'}LOGFILE.tmp" && mv -f "${'$'}LOGFILE.tmp" "${'$'}LOGFILE"; fi
rm -f "${'$'}PIDFILE"
"""
        return try {
            val scriptFile = File(jobsDir, "$runId.sh")
            scriptFile.writeText(script)
            scriptFile.setExecutable(true)
            val intent = Intent("com.termux.RUN_COMMAND").setPackage("com.termux")
                .putExtra("com.termux.RUN_COMMAND_PATH", BASH_PATH)
                .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf(scriptFile.absolutePath))
                .putExtra("com.termux.RUN_COMMAND_WORKDIR", jobsDir.absolutePath)
                .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            ctx.startService(intent)
            audit(ctx, "fixed_dispatch", runId, "$kind:$target")
            JSONObject().put("ok", true).put("runId", runId)
                .put("kind", kind).put("package", target).put("timeoutSec", 900)
        } catch (e: Exception) { error("DISPATCH_FAILED", e.message ?: "Termux 启动失败") }
    }

    /** 查询任务状态：running / done / failed / not_found */
    fun getJobStatus(ctx: Context, runId: String): JSONObject {
        if (!RUN_ID_RE.matches(runId)) return error("INVALID_RUN_ID", "任务 id 不合法")
        val jobsDir = findJobsDirForRun(ctx, runId) ?: return error("JOB_NOT_FOUND", "任务不存在：$runId")
        val pidFile = File(jobsDir, "$runId.pid")
        val exitFile = File(jobsDir, "$runId.exit")
        val logFile = File(jobsDir, "$runId.log")

        val running = pidFile.exists()
        val exitCode = if (exitFile.exists()) exitFile.readText().trim().toIntOrNull() else null
        val output = if (logFile.exists()) logFile.readText().takeLast(8000) else ""

        val status = when {
            running -> "running"
            exitCode == null -> "not_found"
            exitCode == 0 -> "done"
            else -> "failed"
        }
        return JSONObject().put("ok", true)
            .put("runId", runId)
            .put("status", status)
            .put("exitCode", exitCode)
            .put("output", output)
            .put("outputLength", if (logFile.exists()) logFile.length() else 0)
    }

    /** 列出某个任务下的所有 Termux 任务 */
    fun listJobs(ctx: Context, taskId: String): JSONObject {
        val taskDir = TaskWorkspace.taskDir(taskId) ?: return error("INVALID_TASK", "任务工作区不存在")
        val jobsDir = File(taskDir, JOBS_DIR)
        val jobs = JSONArray()
        if (jobsDir.isDirectory) {
            jobsDir.listFiles { f -> f.extension == "sh" }?.forEach { f ->
                val runId = f.nameWithoutExtension
                val pidFile = File(jobsDir, "$runId.pid")
                val exitFile = File(jobsDir, "$runId.exit")
                val status = when {
                    pidFile.exists() -> "running"
                    exitFile.exists() -> if (exitFile.readText().trim() == "0") "done" else "failed"
                    else -> "unknown"
                }
                jobs.put(JSONObject().put("runId", runId).put("status", status))
            }
        }
        return JSONObject().put("ok", true).put("jobs", jobs)
    }

    /** 取消任务：创建信号文件，由 wrapper 脚本检测并 kill 子进程 */
    fun cancelJob(ctx: Context, runId: String): JSONObject {
        if (!RUN_ID_RE.matches(runId)) return error("INVALID_RUN_ID", "任务 id 不合法")
        val jobsDir = findJobsDirForRun(ctx, runId) ?: return error("JOB_NOT_FOUND", "任务不存在：$runId")
        val pidFile = File(jobsDir, "$runId.pid")
        if (!pidFile.exists()) return error("NOT_RUNNING", "任务未在运行：$runId")
        return try {
            // 创建取消信号文件，wrapper 脚本检测到后会终止子进程
            File(jobsDir, "$runId.cancel").writeText("cancel")
            // 等待 wrapper 清理（最多 5 秒）
            var waited = 0
            while (pidFile.exists() && waited < 5000) {
                Thread.sleep(500)
                waited += 500
            }
            val cancelled = !pidFile.exists()
            // 写退出码标记（如果 wrapper 还没来得及写）
            if (cancelled && !File(jobsDir, "$runId.exit").exists()) {
                File(jobsDir, "$runId.exit").writeText("143")
            }
            audit(ctx, "cancel", runId, "cancelled=$cancelled")
            JSONObject().put("ok", cancelled).put("runId", runId).put("cancelled", cancelled)
        } catch (e: Exception) { error("CANCEL_FAILED", e.message ?: "取消失败") }
    }

    /** 读取任务输出（可指定偏移，模拟流式读取） */
    fun readJobOutput(ctx: Context, runId: String, offset: Long = 0): JSONObject {
        if (!RUN_ID_RE.matches(runId)) return error("INVALID_RUN_ID", "任务 id 不合法")
        val jobsDir = findJobsDirForRun(ctx, runId) ?: return error("JOB_NOT_FOUND", "任务不存在：$runId")
        val logFile = File(jobsDir, "$runId.log")
        if (!logFile.exists()) return JSONObject().put("ok", true).put("output", "").put("nextOffset", 0L).put("eof", false)
        val totalLen = logFile.length()
        val start = offset.coerceIn(0, totalLen)
        val content = if (start < totalLen) {
            logFile.inputStream().use { it.skip(start); it.readBytes().toString(Charsets.UTF_8) }.take(8000)
        } else ""
        val nextOffset = (start + content.toByteArray(Charsets.UTF_8).size.toLong()).coerceAtMost(totalLen)
        return JSONObject().put("ok", true)
            .put("output", content)
            .put("nextOffset", nextOffset)
            .put("totalLength", totalLen)
    }

    /** 在所有任务目录 / 固定依赖目录中查找某个 runId 的 jobs 目录 */
    private fun findJobsDirForRun(ctx: Context, runId: String): File? {
        val fixedDir = File(TaskWorkspace.root(), FIXED_JOBS_DIR)
        if (File(fixedDir, "$runId.sh").exists() || File(fixedDir, "$runId.log").exists()) return fixedDir
        val tasksRoot = File(TaskWorkspace.root(), "tasks")
        if (!tasksRoot.isDirectory) return null
        tasksRoot.listFiles()?.forEach { taskDir ->
            val jobsDir = File(taskDir, JOBS_DIR)
            if (File(jobsDir, "$runId.sh").exists() || File(jobsDir, "$runId.log").exists()) return jobsDir
        }
        return null
    }

    private fun audit(ctx: Context, event: String, runId: String, detail: String) {
        try {
            val dir = File(TaskWorkspace.root(), "audit")
            if (!dir.isDirectory && !dir.mkdirs()) return
            val f = File(dir, "termux-audit.log")
            f.appendText("${System.currentTimeMillis()} $event run=$runId $detail\n")
            if (f.length() > AUDIT_MAX_BYTES) f.writeText(f.readText().takeLast(AUDIT_MAX_BYTES / 2))
        } catch (_: Exception) {}
    }

    private fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
    private fun error(code: String, message: String) = JSONObject().put("ok", false).put("errorCode", code).put("error", message)
}
