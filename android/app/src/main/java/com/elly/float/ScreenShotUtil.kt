package com.elly.assistant

import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * 截图结果的统一出口：压缩成 data URL 交给 JS / 模型。
 * 大图直接 base64 有两点致命伤：
 *   1) base64 体积约 +33%，3000x2000 的截图能到几 MB；
 *   2) 部分接口对单条消息长度有限制。
 * 所以统一缩到宽 <= maxW 再压 JPEG。
 */
object ScreenShotUtil {

    fun toDataUrl(src: Bitmap, maxW: Int = 1080, quality: Int = 80): String? {
        return try {
            val scaled: Bitmap = if (src.width > maxW && src.width > 0) {
                val h = (src.height.toFloat() * maxW / src.width).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(src, maxW, h, true)
            } else src
            val bos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, bos)
            if (scaled !== src) scaled.recycle()
            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        } catch (t: Throwable) {
            null
        }
    }

    /** ImageReader 的 Image 在多数机型上有 row padding，必须按 rowStride 处理，否则图片会错位。 */
    fun imageToBitmap(image: android.media.Image): Bitmap? {
        return try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val raw = Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height,
                Bitmap.Config.ARGB_8888
            )
            raw.copyPixelsFromBuffer(buffer)
            if (rowPadding == 0) {
                raw
            } else {
                val cropped = Bitmap.createBitmap(raw, 0, 0, image.width, image.height)
                raw.recycle()
                cropped
            }
        } catch (t: Throwable) {
            null
        }
    }
}
