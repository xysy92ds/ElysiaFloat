package com.elly.assistant

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files

/** G7-4：符号链接防护。工作区/公共存储的写入与删除都不跨符号链接。 */
object SymlinkGuard {
    /**
     * 目标自身或它的任一层父目录是符号链接 → true。
     * 只用 canonical/absolute 比较容易漏掉「链接指向内部」这种情况，所以显式判断。
     */
    fun hasSymlink(file: File): Boolean {
        return try {
            var cur: File? = file
            var depth = 0
            while (cur != null && depth < 64) {
                if (Files.isSymbolicLink(cur.toPath())) return true
                cur = cur.parentFile
                depth++
            }
            false
        } catch (_: Exception) { false }
    }

    /** 目标本身是否符号链接（删除时不跟随） */
    fun isLink(file: File): Boolean = try {
        Files.isSymbolicLink(file.toPath())
    } catch (_: Exception) { false }
}

/**
 * G7-4：原子写入。
 * 先写同目录下的临时文件，fsync 后 rename 覆盖，避免写一半断电留下损坏文件。
 */
object AtomicWrite {
    fun write(target: File, bytes: ByteArray) {
        val dir = target.parentFile ?: throw IllegalStateException("目标没有父目录")
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建目录")
        val tmp = File(dir, "." + target.name + ".tmp-" + System.nanoTime())
        try {
            FileOutputStream(tmp, false).use { out ->
                out.write(bytes)
                out.flush()
                try { out.fd.sync() } catch (_: Exception) { }
            }
            if (target.exists() && !target.delete()) {
                throw IllegalStateException("无法覆盖原文件")
            }
            if (!tmp.renameTo(target)) {
                // rename 失败时兜底：复制内容后删除临时文件
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}

/**
 * G7-4：受控递归删除。
 *  · 不跟随符号链接（链接本身删掉即可，绝不进入链接目标）
 *  · 限制节点数量与深度，防止误删超大目录时失控
 */
object SafeDelete {
    private const val MAX_NODES = 20_000
    private const val MAX_DEPTH = 32

    /** 返回是否全部删除成功；节点数或深度超限时返回 false，不做进一步删除。 */
    fun deleteTree(root: File): Boolean {
        val left = intArrayOf(MAX_NODES)
        return walk(root, 0, left)
    }

    private fun walk(file: File, depth: Int, left: IntArray): Boolean {
        if (depth > MAX_DEPTH) return false
        if (left[0]-- <= 0) return false
        // 符号链接只删链接本身，绝不进入目标
        if (SymlinkGuard.isLink(file)) return !file.exists() || file.delete()
        if (!file.isDirectory) return file.delete()
        val children = file.listFiles()
        if (children == null) return file.delete()
        for (c in children) {
            if (!walk(c, depth + 1, left)) return false
        }
        return file.delete()
    }
}
