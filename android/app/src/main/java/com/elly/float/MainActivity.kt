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
        // 由 TermuxWorker.requestRunCommandPermission 拉起：专门用来申请 RUN_COMMAND 权限。
        // normal 权限只要 Termux 已装，requestPermissions 会立即授予。
        if (intent?.getBooleanExtra("requestRunCommand", false) == true) {
            val perm = "com.termux.permission.RUN_COMMAND"
            if (checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) {
                finish()
                return
            }
            try {
                requestPermissions(arrayOf(perm), TermuxWorker.REQ_RUN_COMMAND)
            } catch (_: Exception) { finish() }
            return
        }
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
        if (requestCode == TermuxWorker.REQ_RUN_COMMAND) {
            // normal 权限申请结果回来后直接关闭 Activity，浮窗服务会重新检测权限状态
            finish()
            return
        }
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
