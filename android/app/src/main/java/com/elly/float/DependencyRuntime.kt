package com.elly.assistant

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * 插件依赖运行时（0.12 / E5）。
 *
 * 边界：
 * - 只接受 HTTPS；跳转后仍是 HTTPS 才继续；
 * - 下载类必须提供 64 位 SHA-256，校验失败删除临时文件并中止；
 * - 单文件上限 200MB；zip 解压防目录穿越；
 * - 每个插件的依赖只落在 filesDir/plugin-deps/<plugin>/<dep>/，不动系统目录；
 * - APK 只落到 cache/updates 并交给系统安装器，应用内不静默安装；
 * - lockfile 原子写，记录 kind/version/sha256/size/path/installedAt。
 */
object DependencyRuntime {
    private const val MAX_BYTES = 200L * 1024 * 1024
    private const val MAX_REDIRECTS = 5
    private const val CONNECT_TIMEOUT = 15000
    private const val READ_TIMEOUT = 60000
    private const val AUDIT_MAX = 200_000

    private val ID_RE = Regex("[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
    private val SHA_RE = Regex("[a-fA-F0-9]{64}")
    private val KIND_OK = setOf("termux-pkg", "npm", "archive", "binary", "apk")

    private fun base(ctx: Context): File = File(ctx.filesDir, "plugin-deps")
    private fun depDir(ctx: Context, pid: String, did: String): File =
        File(File(base(ctx), safe(pid)), safe(did))
    private fun lockFile(ctx: Context): File = File(base(ctx), "lock.json")
    private fun auditFile(ctx: Context): File = File(base(ctx), "audit.log")
    private fun safe(name: String): String = name.replace(Regex("[^A-Za-z0-9_.-]"), "_").take(80)

    private fun err(code: String, message: String) =
        JSONObject().put("ok", false).put("errorCode", code).put("error", message)

    private fun audit(ctx: Context, event: String, pluginId: String, depId: String) {
        try {
            val f = auditFile(ctx)
            f.parentFile?.mkdirs()
            f.appendText("${System.currentTimeMillis()} $event plugin=$pluginId dep=$depId\n")
            if (f.length() > AUDIT_MAX) {
                val text = f.readText()
                f.writeText(text.takeLast(AUDIT_MAX / 2))
            }
        } catch (_: Exception) {}
    }

    /* ---------------- lockfile ---------------- */

    private fun readLock(ctx: Context): JSONObject {
        return try {
            val f = lockFile(ctx)
            if (!f.exists()) JSONObject() else JSONObject(f.readText())
        } catch (_: Exception) { JSONObject() }
    }

    private fun writeLock(ctx: Context, all: JSONObject) {
        try {
            val f = lockFile(ctx)
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "lock.json.tmp")
            tmp.writeText(all.toString())
            if (!tmp.renameTo(f)) { f.writeText(all.toString()); tmp.delete() }
        } catch (_: Exception) {}
    }

    fun state(ctx: Context, pluginId: String): JSONObject {
        if (!ID_RE.matches(pluginId)) return err("INVALID_PLUGIN", "插件 ID 不合法")
        val all = readLock(ctx)
        val deps = all.optJSONObject(pluginId) ?: JSONObject()
        return JSONObject().put("ok", true).put("deps", deps)
    }

    private fun lockWriteEntry(ctx: Context, pluginId: String, dep: JSONObject, path: String, size: Long) {
        val all = readLock(ctx)
        val plugins = all.optJSONObject(pluginId) ?: JSONObject().also { all.put(pluginId, it) }
        plugins.put(dep.optString("id"), JSONObject().apply {
            put("id", dep.optString("id"))
            put("kind", dep.optString("kind"))
            put("version", dep.optString("version"))
            put("sha256", dep.optString("sha256").lowercase())
            put("size", size)
            put("path", path)
            put("installedAt", System.currentTimeMillis())
        })
        writeLock(ctx, all)
    }

    private fun lockRemoveEntry(ctx: Context, pluginId: String, depId: String) {
        val all = readLock(ctx)
        val plugins = all.optJSONObject(pluginId) ?: return
        plugins.remove(depId)
        if (plugins.length() == 0) all.remove(pluginId)
        writeLock(ctx, all)
    }

    /* ---------------- 安装 ---------------- */

    fun install(ctx: Context, pluginId: String, depJson: String): JSONObject {
        val dep = try { JSONObject(depJson) } catch (_: Exception) {
            return err("INVALID_DEP", "依赖声明格式无效")
        }
        val did = dep.optString("id")
        val kind = dep.optString("kind")
        if (!ID_RE.matches(pluginId)) return err("INVALID_PLUGIN", "插件 ID 不合法")
        if (!ID_RE.matches(did)) return err("INVALID_DEP", "依赖 ID 不合法")
        if (!KIND_OK.contains(kind)) return err("DEP_KIND", "不支持的依赖类型：$kind")

        val source = dep.optString("source")
        val sha = dep.optString("sha256").lowercase()
        if (!SHA_RE.matches(sha)) return err("DEP_NO_HASH", "下载类依赖必须提供 SHA-256")
        if (!isHttps(source)) return err("DEP_NOT_HTTPS", "下载类依赖必须使用 HTTPS")

        return try {
            audit(ctx, "install_start", pluginId, did)
            val tmpDir = File(ctx.cacheDir, "dep-tmp")
            if (!tmpDir.isDirectory && !tmpDir.mkdirs()) return err("TMP_FAILED", "无法创建临时目录")
            val tmp = File(tmpDir, safe(pluginId) + "-" + safe(did) + ".part")
            val got = download(source, tmp)
            if (!got.optBoolean("ok", false)) return got
            if (got.optLong("size") > MAX_BYTES) { tmp.delete(); return err("DEP_TOO_LARGE", "依赖超过 200MB 上限") }
            if (got.optString("sha256").lowercase() != sha) {
                tmp.delete()
                audit(ctx, "install_hash_fail", pluginId, did)
                return err("DEP_HASH_MISMATCH", "SHA-256 校验失败，已删除临时文件")
            }

            if (kind == "apk") {
                val updates = File(ctx.cacheDir, "updates")
                if (!updates.isDirectory && !updates.mkdirs()) { tmp.delete(); return err("APK_DIR_FAILED", "无法创建更新目录") }
                val fileName = "dep-" + safe(pluginId) + "-" + safe(did) + "-" + safe(dep.optString("version")) + ".apk"
                val out = File(updates, fileName)
                if (!tmp.renameTo(out)) { tmp.copyTo(out, true); tmp.delete() }
                lockWriteEntry(ctx, pluginId, dep, out.absolutePath, out.length())
                audit(ctx, "install_apk_ready", pluginId, did)
                return JSONObject().put("ok", true).put("depId", did)
                    .put("needsUserInstall", true).put("fileName", fileName)
            }

            val dir = depDir(ctx, pluginId, did)
            if (!dir.isDirectory && !dir.mkdirs()) { tmp.delete(); return err("DEP_DIR_FAILED", "无法创建依赖目录") }
            when (kind) {
                "binary" -> {
                    val binDir = File(dir, "bin")
                    if (!binDir.isDirectory && !binDir.mkdirs()) { tmp.delete(); return err("DEP_DIR_FAILED", "无法创建 bin 目录") }
                    val binName = safe(dep.optString("bin").ifBlank { did })
                    val out = File(binDir, binName)
                    if (!tmp.renameTo(out)) { tmp.copyTo(out, true); tmp.delete() }
                    out.setExecutable(true, false)
                }
                "archive" -> {
                    val filesDir = File(dir, "files")
                    if (!filesDir.isDirectory && !filesDir.mkdirs()) { tmp.delete(); return err("DEP_DIR_FAILED", "无法创建解压目录") }
                    val r = unzip(tmp, filesDir)
                    tmp.delete()
                    if (!r.optBoolean("ok", false)) return r
                }
                else -> { tmp.delete(); return err("DEP_KIND", "该类型不走下载安装") }
            }
            lockWriteEntry(ctx, pluginId, dep, dir.absolutePath, got.optLong("size"))
            audit(ctx, "install_ok", pluginId, did)
            JSONObject().put("ok", true).put("depId", did).put("installed", true)
        } catch (e: Exception) {
            audit(ctx, "install_error", pluginId, did)
            err("DEP_INSTALL_FAILED", e.message ?: "依赖安装失败")
        }
    }

    /** Termux / npm 安装完成后由 JS 调用，只写 lockfile，不下载。 */
    fun record(ctx: Context, pluginId: String, depJson: String): JSONObject {
        val dep = try { JSONObject(depJson) } catch (_: Exception) { return err("INVALID_DEP", "依赖声明格式无效") }
        val did = dep.optString("id")
        if (!ID_RE.matches(pluginId) || !ID_RE.matches(did)) return err("INVALID_DEP", "依赖 ID 不合法")
        lockWriteEntry(ctx, pluginId, dep, "", dep.optLong("size"))
        audit(ctx, "record_ok", pluginId, did)
        return JSONObject().put("ok", true).put("depId", did)
    }

    fun remove(ctx: Context, pluginId: String, depId: String): JSONObject {
        if (!ID_RE.matches(pluginId) || !ID_RE.matches(depId)) return err("INVALID_DEP", "依赖 ID 不合法")
        val dir = depDir(ctx, pluginId, depId)
        return try {
            if (dir.exists() && !dir.deleteRecursively()) return err("DEP_REMOVE_FAILED", "无法删除依赖目录")
            lockRemoveEntry(ctx, pluginId, depId)
            audit(ctx, "remove_ok", pluginId, depId)
            JSONObject().put("ok", true)
        } catch (e: Exception) { err("DEP_REMOVE_FAILED", e.message ?: "删除失败") }
    }

    fun verify(ctx: Context, pluginId: String, depId: String): JSONObject {
        val entry = state(ctx, pluginId).optJSONObject("deps")?.optJSONObject(depId)
            ?: return JSONObject().put("ok", true).put("verified", false).put("reason", "未安装")
        val sha = entry.optString("sha256")
        val path = entry.optString("path")
        if (path.isBlank()) {
            // Termux/npm：由包管理器负责完整性，这里只确认记录还在。
            return JSONObject().put("ok", true).put("verified", true).put("reason", "由包管理器校验")
        }
        val f = File(path)
        if (!f.exists()) return JSONObject().put("ok", true).put("verified", false).put("reason", "文件已不存在")
        if (sha.isBlank()) return JSONObject().put("ok", true).put("verified", true)
        if (f.isDirectory) {
            // archive 记录的是目录：抽查 files 下是否存在内容。
            val has = (f.listFiles()?.isNotEmpty() == true)
            return JSONObject().put("ok", true).put("verified", has).put("reason", if (has) "" else "解压目录为空")
        }
        val got = hashFile(f)
        val ok = got.equals(sha, ignoreCase = true)
        return JSONObject().put("ok", true).put("verified", ok).put("reason", if (ok) "" else "SHA-256 不一致")
    }

    /** 只启动系统安装器；应用内不静默安装。 */
    fun installApk(ctx: Context, fileName: String): JSONObject {
        val safeName = File(fileName).name
        val f = File(File(ctx.cacheDir, "updates"), safeName)
        if (!f.exists() || !f.isFile) return err("APK_NOT_FOUND", "APK 文件不存在")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
            try {
                ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {}
            return err("APK_PERMISSION", "需要允许安装未知来源应用后重试")
        }
        return try {
            val uri = Uri.parse("content://${ctx.packageName}.fileprovider/$safeName")
            ctx.startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            })
            JSONObject().put("ok", true)
        } catch (e: Exception) { err("APK_INSTALL_FAILED", e.message ?: "无法启动系统安装器") }
    }

    /* ---------------- 下载与解压 ---------------- */

    private fun isHttps(u: String): Boolean = try {
        val url = URL(u)
        url.protocol.equals("https", ignoreCase = true) && url.host.isNotBlank()
    } catch (_: Exception) { false }

    private fun openFollow(start: String): Pair<HttpURLConnection, String>? {
        var current = start
        repeat(MAX_REDIRECTS) {
            if (!isHttps(current)) return null
            val c = (URL(current).openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT
                readTimeout = READ_TIMEOUT
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "ElysiaFloat/0.12")
            }
            when (val code = c.responseCode) {
                in 200..299 -> return c to current
                in 301..308 -> {
                    val loc = c.getHeaderField("Location") ?: return null
                    current = URL(URL(current), loc).toString()
                    c.disconnect()
                }
                else -> { c.disconnect(); return null }
            }
        }
        return null
    }

    private fun download(url: String, out: File): JSONObject {
        val pair = openFollow(url) ?: return err("DEP_DOWNLOAD_FAILED", "下载失败（只允许 HTTPS）")
        val conn = pair.first
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        try {
            val input: InputStream = conn.inputStream
            FileOutputStream(out).use { fos ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > MAX_BYTES) return err("DEP_TOO_LARGE", "依赖超过 200MB 上限")
                    digest.update(buf, 0, n)
                    fos.write(buf, 0, n)
                }
            }
        } catch (e: Exception) {
            out.delete()
            return err("DEP_DOWNLOAD_FAILED", e.message ?: "下载中断")
        } finally {
            try { conn.disconnect() } catch (_: Exception) {}
        }
        return JSONObject().put("ok", true).put("size", total)
            .put("sha256", digest.digest().joinToString("") { "%02x".format(it) })
    }

    private fun hashFile(f: File): String = try {
        val digest = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                digest.update(buf, 0, n)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    } catch (_: Exception) { "" }

    private fun unzip(zip: File, dest: File): JSONObject {
        val root = dest.canonicalFile
        try {
            ZipInputStream(zip.inputStream()).use { zin ->
                while (true) {
                    val entry = zin.nextEntry ?: break
                    val target = File(root, entry.name).canonicalFile
                    if (target.path != root.path && !target.path.startsWith(root.path + File.separator)) {
                        return err("DEP_ZIP_SLIP", "压缩包包含越界路径，已拒绝")
                    }
                    if (entry.isDirectory) {
                        if (!target.isDirectory && !target.mkdirs()) return err("DEP_UNZIP_FAILED", "无法创建目录")
                    } else {
                        target.parentFile?.mkdirs()
                        FileOutputStream(target).use { fos ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = zin.read(buf)
                                if (n <= 0) break
                                fos.write(buf, 0, n)
                            }
                        }
                    }
                    zin.closeEntry()
                }
            }
            return JSONObject().put("ok", true)
        } catch (e: Exception) { return err("DEP_UNZIP_FAILED", e.message ?: "解压失败") }
    }
}
