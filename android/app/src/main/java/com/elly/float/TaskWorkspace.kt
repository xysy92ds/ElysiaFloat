package com.elly.assistant

import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** Per-task workspace filesystem helpers. All paths remain below Documents/ElysiaFloat/workspace. */
object TaskWorkspace {
    private val taskIdRegex = Regex("[A-Za-z0-9_.-]{3,96}")

    fun root(): File = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
        "ElysiaFloat/workspace"
    )

    fun taskDir(taskId: String): File? {
        val id = taskId.trim()
        if (!taskIdRegex.matches(id)) return null
        val root = try { root().canonicalFile } catch (_: Exception) { return null }
        val task = try { File(root, "tasks/$id").canonicalFile } catch (_: Exception) { return null }
        val base = root.path + File.separator
        if (!task.path.startsWith(base) || task.parentFile?.name != "tasks") return null
        return task
    }

    fun create(taskId: String, title: String, goal: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        return try {
            listOf("input", "working", "output", "logs", "snapshots").forEach {
                val child = File(dir, it)
                if (!child.exists() && !child.mkdirs()) throw IllegalStateException("无法创建 $it")
            }
            val manifest = JSONObject().apply {
                put("schemaVersion", 1)
                put("id", taskId)
                put("title", title.take(200))
                put("goal", goal.take(4000))
                put("status", "new")
                put("createdAt", System.currentTimeMillis())
                put("updatedAt", System.currentTimeMillis())
                put("workspace", "tasks/$taskId")
                put("permissions", JSONObject().apply {
                    put("readFiles", true); put("writeFiles", false)
                    put("deleteFiles", false); put("network", false)
                    put("deviceControl", false); put("termux", false)
                })
            }
            File(dir, "task.json").writeText(manifest.toString(2), StandardCharsets.UTF_8)
            state(taskId).put("ok", true)
        } catch (e: Exception) { error("CREATE_FAILED", e.message ?: "任务工作区创建失败") }
    }

    fun state(taskId: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        val dirs = JSONArray()
        listOf("input", "working", "output", "logs", "snapshots").forEach { if (File(dir, it).isDirectory) dirs.put(it) }
        return JSONObject().apply {
            put("ok", true); put("taskId", taskId); put("created", dir.isDirectory)
            put("path", dir.absolutePath); put("relative", "tasks/$taskId")
            put("directories", dirs); put("manifest", File(dir, "task.json").isFile)
        }
    }

    fun delete(taskId: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        return try {
            val deleted = !dir.exists() || dir.deleteRecursively()
            JSONObject().put("ok", deleted).put("taskId", taskId)
        } catch (e: Exception) { error("DELETE_FAILED", e.message ?: "任务工作区删除失败") }
    }

    fun update(taskId: String, status: String, phase: String, progress: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        val manifestFile = File(dir, "task.json")
        if (!manifestFile.isFile) return error("MANIFEST_MISSING", "任务清单不存在")
        return try {
            val manifest = JSONObject(manifestFile.readText(StandardCharsets.UTF_8))
            manifest.put("status", status.take(32)).put("phase", phase.take(32)).put("progress", progress.take(500)).put("updatedAt", System.currentTimeMillis())
            manifestFile.writeText(manifest.toString(2), StandardCharsets.UTF_8)
            JSONObject().put("ok", true).put("taskId", taskId).put("status", status)
        } catch (e: Exception) { error("MANIFEST_UPDATE_FAILED", e.message ?: "任务清单更新失败") }
    }

    fun appendLog(taskId: String, eventJson: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        return try {
            val logs = File(dir, "logs").apply { mkdirs() }
            val line = eventJson.take(4000).replace("\n", " ") + "\n"
            val file = File(logs, "events.jsonl")
            if (file.length() > 2L * 1024L * 1024L) file.writeText("", StandardCharsets.UTF_8)
            file.appendText(line, StandardCharsets.UTF_8)
            JSONObject().put("ok", true).put("bytes", file.length())
        } catch (e: Exception) { error("LOG_WRITE_FAILED", e.message ?: "任务日志写入失败") }
    }

    fun importText(taskId: String, name: String, text: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        val safe = File(name.replace('\\', '/')).name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "upload.txt" }
        if (text.toByteArray(StandardCharsets.UTF_8).size > 2 * 1024 * 1024) return error("FILE_TOO_LARGE", "单个上传文本不能超过 2MB")
        return try {
            val input = File(dir, "input").apply { mkdirs() }
            val target = File(input, safe)
            target.writeText(text, StandardCharsets.UTF_8)
            JSONObject().apply {
                put("ok", true); put("taskId", taskId); put("relative", "tasks/$taskId/input/$safe")
                put("name", safe); put("bytes", target.length()); put("sha256", sha256(target.readBytes()))
            }
        } catch (e: Exception) { error("IMPORT_FAILED", e.message ?: "上传文件写入失败") }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }

    /* ---------- P1 收尾：文件索引 / 快照 / 回滚 ---------- */

    /** 相对任务根目录的规范路径；拒绝越界、绝对路径和空路径。 */
    fun resolve(taskId: String, relative: String): File? {
        val dir = taskDir(taskId) ?: return null
        val raw = relative.trim().replace('\\', '/')
        if (raw.isBlank() || raw.startsWith("/")) return null
        if (raw.split('/').any { it.isEmpty() || it == ".." || it == "." }) return null
        val file = try { File(dir, raw).canonicalFile } catch (_: Exception) { return null }
        val base = dir.path + File.separator
        if (!file.path.startsWith(base)) return null
        return file
    }

    private fun rel(taskId: String, file: File): String {
        val dir = taskDir(taskId) ?: return file.name
        return file.absolutePath.removePrefix(dir.absolutePath + File.separator)
    }

    /** 任务文件索引：只返回元数据和摘要，不返回正文。 */
    fun index(taskId: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        if (!dir.isDirectory) return error("TASK_MISSING", "任务目录不存在")
        return try {
            val items = JSONArray()
            var total = 0L
            dir.walkTopDown().filter { it.isFile && it.name != "task.json" }
                .sortedBy { it.absolutePath }
                .take(500)
                .forEach { file ->
                    val size = file.length()
                    total += size
                    items.put(JSONObject().apply {
                        put("relative", rel(taskId, file))
                        put("name", file.name)
                        put("size", size)
                        put("modified", file.lastModified())
                        put("directory", rel(taskId, file).substringBefore('/', ""))
                        put("sha256", if (size <= 1_048_576) runCatching { sha256(file.readBytes()) }.getOrDefault("") else "")
                    })
                }
            JSONObject().apply {
                put("ok", true); put("taskId", taskId); put("count", items.length()); put("totalBytes", total)
                put("path", dir.absolutePath); put("relative", "tasks/$taskId"); put("files", items)
            }
        } catch (e: Exception) { error("INDEX_FAILED", e.message ?: "任务文件索引失败") }
    }

    private fun snapshotIndexFile(dir: File) = File(dir, "snapshots/index.json")

    private fun readSnapshotIndex(dir: File): JSONArray = try {
        val file = snapshotIndexFile(dir)
        if (file.isFile) JSONArray(file.readText(StandardCharsets.UTF_8)) else JSONArray()
    } catch (_: Exception) { JSONArray() }

    /** 写入或删除前保存快照；不存在则记为 none。 */
    fun snapshot(taskId: String, relative: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        val file = resolve(taskId, relative) ?: return error("INVALID_PATH", "任务路径不合法")
        if (!file.isFile) return JSONObject().put("ok", true).put("snapshot", JSONObject.NULL).put("existed", false)
        return try {
            val snapDir = File(dir, "snapshots").apply { mkdirs() }
            val stamp = System.currentTimeMillis()
            val safe = relative.replace("/", "__").replace(Regex("[^A-Za-z0-9._-]"), "_")
            val name = "$stamp-$safe"
            val target = File(snapDir, name)
            file.copyTo(target, overwrite = true)
            val entry = JSONObject().apply {
                put("snapshot", name); put("relative", relative); put("bytes", target.length())
                put("createdAt", stamp); put("sha256", sha256(file.readBytes()))
            }
            val index = readSnapshotIndex(dir).put(entry)
            while (index.length() > 200) index.remove(0)
            snapshotIndexFile(dir).writeText(index.toString(2), StandardCharsets.UTF_8)
            JSONObject().put("ok", true).put("existed", true).put("snapshot", name).put("sha256", entry.optString("sha256"))
        } catch (e: Exception) { error("SNAPSHOT_FAILED", e.message ?: "快照失败") }
    }

    fun listSnapshots(taskId: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        val index = readSnapshotIndex(dir)
        val out = JSONArray()
        for (i in index.length() - 1 downTo 0) out.put(index.getJSONObject(i))
        return JSONObject().put("ok", true).put("taskId", taskId).put("count", out.length()).put("snapshots", out)
    }

    /** 从快照恢复文件；恢复前会对当前文件再做一次快照，避免恢复本身不可回退。 */
    fun restore(taskId: String, snapshotName: String): JSONObject {
        val dir = taskDir(taskId) ?: return error("INVALID_TASK_ID", "任务 ID 不合法")
        if (snapshotName.contains("/") || snapshotName.contains("..")) return error("INVALID_SNAPSHOT", "快照名不合法")
        val index = readSnapshotIndex(dir)
        var entry: JSONObject? = null
        for (i in 0 until index.length()) {
            val item = index.getJSONObject(i)
            if (item.optString("snapshot") == snapshotName) { entry = item; break }
        }
        val found = entry ?: return error("SNAPSHOT_MISSING", "快照不存在")
        val relative = found.optString("relative")
        if (relative.isBlank()) return error("SNAPSHOT_INVALID", "快照缺少原始路径")
        val snap = File(File(dir, "snapshots"), snapshotName)
        if (!snap.isFile) return error("SNAPSHOT_MISSING", "快照文件已丢失")
        val current = snapshot(taskId, relative)
        val target = resolve(taskId, relative) ?: return error("INVALID_PATH", "任务路径不合法")
        return try {
            target.parentFile?.mkdirs()
            snap.copyTo(target, overwrite = true)
            JSONObject().put("ok", true).put("restored", relative).put("backup", current.opt("snapshot"))
                .put("bytes", target.length()).put("sha256", sha256(target.readBytes()))
        } catch (e: Exception) { error("RESTORE_FAILED", e.message ?: "恢复失败") }
    }

    private fun error(code: String, message: String) = JSONObject().put("ok", false).put("errorCode", code).put("error", message)
}
