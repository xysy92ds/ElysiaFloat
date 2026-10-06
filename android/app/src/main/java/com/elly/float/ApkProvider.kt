package com.elly.assistant

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * 极小的文件 ContentProvider，只服务于「把下载好的更新包交给系统安装器」。
 *
 * 为什么不用 androidx.core 的 FileProvider：
 * 本项目刻意保持零第三方依赖（见 BUILD_NOTES.md），而 FileProvider 属于 AAR。
 * 这里只需要暴露 cache/updates 目录下的只读文件，自己实现反而更可控：
 * 只允许读取该目录、只允许读取单个文件名（自动剥掉路径分隔符，杜绝目录穿越）。
 */
class ApkProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "application/vnd.android.package-archive"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val raw = uri.lastPathSegment ?: throw FileNotFoundException("缺少文件名")
        // File(name).name 会把 "../" 之类的路径部分剥掉，避免越出 updates 目录
        val safe = File(raw).name
        val dir = File(requireNotNull(context).cacheDir, "updates")
        val file = File(dir, safe)
        if (!file.exists() || !file.isFile) throw FileNotFoundException(safe)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?
    ): Cursor? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(
        uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?
    ): Int = 0
}
