package com.elly.assistant

import android.content.Context
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * 受控 Root Worker：只接受固定 operation，不接受 shell 字符串。
 * 当前提供状态/诊断级操作，文件和系统修改操作不在白名单内。
 */
object RootWorker {
    private val operations = setOf("id", "getprop", "task_files", "list_processes", "kill_process")

    fun isRootBinaryAvailable(): Boolean = try {
        val p = Runtime.getRuntime().exec(arrayOf("sh", "-c", "command -v su"))
        p.waitFor() == 0
    } catch (_: Exception) { false }

    fun run(ctx: Context, operation: String, taskId: String, extra: JSONObject = JSONObject()): JSONObject {
        if (operation !in operations) return error("ROOT_OPERATION_DENIED", "Root 操作不在白名单中")
        if (!isRootBinaryAvailable()) return error("ROOT_UNAVAILABLE", "未检测到 su")
        val command = when (operation) {
            "id" -> "id"
            "getprop" -> "getprop"
            "task_files" -> {
                val dir = TaskWorkspace.taskDir(taskId) ?: return error("INVALID_TASK", "任务工作区无效")
                "find " + shellQuote(dir.absolutePath) + " -maxdepth 2 -type f -print"
            }
            "list_processes" -> "ps -A -o PID,NAME"
            "kill_process" -> {
                val pid = extra.optInt("pid", 0)
                if (pid <= 0) return error("INVALID_PID", "kill_process 需要有效 pid 参数")
                "kill -TERM " + pid
            }
            else -> return error("ROOT_OPERATION_DENIED", "Root 操作不在白名单中")
        }
        return try {
            val p = Runtime.getRuntime().exec(arrayOf("su", "-c", command))
            val finished = p.waitFor(15, TimeUnit.SECONDS)
            if (!finished) { p.destroyForcibly(); return error("ROOT_TIMEOUT", "Root 操作超时") }
            val out = BufferedReader(InputStreamReader(p.inputStream)).use { it.readText().take(20000) }
            val err = BufferedReader(InputStreamReader(p.errorStream)).use { it.readText().take(4000) }
            JSONObject().put("ok", p.exitValue() == 0).put("operation", operation)
                .put("exitCode", p.exitValue()).put("stdout", out).put("stderr", err)
        } catch (e: Exception) { error("ROOT_EXEC_FAILED", e.message ?: "Root 操作失败") }
    }

    private fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"
    private fun error(code: String, message: String) = JSONObject().put("ok", false).put("errorCode", code).put("error", message)
}
