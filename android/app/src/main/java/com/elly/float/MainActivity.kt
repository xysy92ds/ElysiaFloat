package com.elly.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.app.Activity

class MainActivity : Activity() {

    companion object {
        @Volatile var current: MainActivity? = null
            private set
    }

    private var notificationRequestSent = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        checkAndStart()
    }

    override fun onResume() {
        super.onResume()
        // 从系统设置页返回后重新检查；通知权限也必须由 Activity 发起。
        checkAndStart()
    }

    private fun checkAndStart() {
        // 如果浮窗已经在运行（例如当前只是缩成了小球），直接还原，无需重复启动。
        val running = FloatService.instance
        if (running != null) {
            running.restoreFromBubble()
            finish()
            return
        }
        if (!Settings.canDrawOverlays(this)) {
            try {
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            } catch (_: Exception) { }
            return
        }

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED && !notificationRequestSent) {
            notificationRequestSent = true
            try {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
            } catch (_: Exception) { }
            return
        }

        startFloatService()
        // 浮窗服务接管 UI，避免留下一个透明 Activity 占用返回栈。
        finish()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1001 && Settings.canDrawOverlays(this)) {
            startFloatService()
            finish()
        }
    }

    private fun startFloatService() {
        try {
            val i = Intent(this, FloatService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i)
            } else {
                startService(i)
            }
        } catch (_: Exception) { }
    }

    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }
}
