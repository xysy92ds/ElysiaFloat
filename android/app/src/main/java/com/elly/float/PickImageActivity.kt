package com.elly.assistant

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max

/**
 * 浮窗 Service 自身不能 startActivityForResult，因此用这个轻量 Activity
 * 打开系统相册，把选中的图片压成 data URI 后回传给 FloatService，
 * 再由网页端做拖动 / 缩放裁剪。
 */
class PickImageActivity : Activity() {

    companion object {
        private const val REQ_PICK = 4301
        private const val MAX_SIDE = 1280
        private const val MAX_TEXT = 200_000

        const val EXTRA_MODE = "pick_mode"
        const val MODE_IMAGE = "image"
        const val MODE_FILE = "file"

        private val TEXT_EXT = listOf(
            ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".xml", ".yml", ".yaml",
            ".ini", ".conf", ".cfg", ".html", ".htm", ".css", ".js", ".ts", ".jsx", ".tsx",
            ".py", ".kt", ".java", ".c", ".h", ".cpp", ".go", ".rs", ".sh", ".bat", ".sql",
            ".srt", ".vtt", ".properties", ".toml", ".gradle", ".env"
        )
    }

    private var fileMode = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) return
        fileMode = intent?.getStringExtra(EXTRA_MODE) == MODE_FILE
        try {
            val pick = if (fileMode) {
                // ACTION_OPEN_DOCUMENT 能选任意类型，而且拿得到真实文件名和大小
                Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    type = "*/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
            } else {
                Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "image/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
            }
            startActivityForResult(
                Intent.createChooser(pick, if (fileMode) "选择文件" else "选择图片"),
                REQ_PICK
            )
        } catch (e: Exception) {
            deliver(null)
            finish()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PICK) return
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) {
            finish()
            return
        }
        Thread {
            val payload = if (fileMode) readFile(uri) else readImage(uri)
            runOnUiThread {
                deliver(payload)
                finish()
            }
        }.start()
    }

    private fun deliver(payload: String?) {
        val svc = FloatService.instance ?: return
        if (fileMode) svc.deliverPickedFile(payload) else svc.deliverPickedImage(payload)
    }

    /* ---------- 文件：能读出正文就读，读不了只回文件名 ---------- */

    private fun readFile(uri: Uri): String? {
        return try {
            val name = queryColumn(uri, OpenableColumns.DISPLAY_NAME) ?: "未命名文件"
            val sizeStr = queryColumn(uri, OpenableColumns.SIZE)
            val mime = contentResolver.getType(uri) ?: ""
            val obj = JSONObject()
            obj.put("name", name)
            obj.put("mime", mime)
            obj.put("size", sizeStr?.toLongOrNull() ?: 0L)
            val text = if (isTextLike(name, mime)) readText(uri) else null
            obj.put("ok", text != null)
            obj.put("text", text ?: "")
            obj.toString()
        } catch (e: Exception) {
            null
        }
    }

    private fun isTextLike(name: String, mime: String): Boolean {
        val m = mime.lowercase()
        if (m.startsWith("text/")) return true
        if (m.contains("json") || m.contains("xml") ||
            m.contains("javascript") || m.contains("yaml")
        ) return true
        val n = name.lowercase()
        return TEXT_EXT.any { n.endsWith(it) }
    }

    private fun readText(uri: Uri): String? {
        return try {
            contentResolver.openInputStream(uri)?.use { input ->
                val buf = ByteArray(MAX_TEXT)
                var total = 0
                while (total < MAX_TEXT) {
                    val n = input.read(buf, total, MAX_TEXT - total)
                    if (n <= 0) break
                    total += n
                }
                val more = input.read() >= 0
                val s = String(buf, 0, total, Charsets.UTF_8)
                if (more) s + "\n\n…（文件太长，只读了前面大约 " + (total / 1000) + "KB）" else s
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun queryColumn(uri: Uri, col: String): String? {
        return try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(col)
                if (i >= 0 && c.moveToFirst()) c.getString(i) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun readImage(uri: Uri): String? {
        return try {
            var bmp = decode(uri) ?: return null
            bmp = rotateByExif(bmp, uri)
            bmp = scaleDown(bmp, MAX_SIDE)
            val bos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 92, bos)
            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    private fun decode(uri: Uri): Bitmap? {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
        var sample = 1
        var w = opts.outWidth
        var h = opts.outHeight
        while (w / (sample * 2) >= MAX_SIDE || h / (sample * 2) >= MAX_SIDE) sample *= 2
        val opts2 = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts2) }
    }

    private fun rotateByExif(bmp: Bitmap, uri: Uri): Bitmap {
        val orientation = try {
            contentResolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL
                )
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            else -> return bmp
        }
        return try {
            Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        } catch (e: Exception) {
            bmp
        }
    }

    private fun scaleDown(bmp: Bitmap, maxSide: Int): Bitmap {
        val side = max(bmp.width, bmp.height)
        if (side <= maxSide) return bmp
        val ratio = maxSide.toFloat() / side
        val w = max(1, (bmp.width * ratio).toInt())
        val h = max(1, (bmp.height * ratio).toInt())
        return try {
            Bitmap.createScaledBitmap(bmp, w, h, true)
        } catch (e: Exception) {
            bmp
        }
    }
}
