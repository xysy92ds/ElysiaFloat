package com.elly.assistant

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle

/**
 * 仅用来向系统申请「录屏/截屏」授权（MediaProjection）。
 * 这是 Android 11 以下、或无障碍截屏不可用时的兜底通道。
 *
 * 注意：Android 14+ 起每次授权只能用一次，所以每次截图都可能回到这里。
 * 这里不做任何界面，拿到 resultCode + data 就交给 FloatService 并立刻关闭。
 */
class ScreenCaptureActivity : Activity() {

    companion object {
        const val REQ_CODE = 0x5C01
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CODE)
        } catch (t: Throwable) {
            finish()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_CODE) {
            if (resultCode == RESULT_OK && data != null) {
                FloatService.instance?.onProjectionGranted(resultCode, data)
            } else {
                FloatService.instance?.onProjectionDenied()
            }
        }
        finish()
    }
}
