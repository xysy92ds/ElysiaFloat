package com.elly.assistant

import android.content.Context
import android.os.PowerManager
import org.json.JSONObject

/**
 * 会话级唤醒锁（0.12 / E6-004）。
 *
 * 只用于「用户明确启动的长任务」：长跑时让 CPU 别睡。
 * - PARTIAL_WAKE_LOCK：息屏也保持 CPU，屏幕该灭还是灭；
 * - 单次最长 480 分钟，到期自动释放，不做永久占用；
 * - 只持有一把锁，换任务时先释放旧的再拿新的；
 * - 前台服务与通知仍是主要保活手段，这里只是补 CPU 不睡。
 */
object SessionKeepAlive {
    private const val TAG = "ElysiaFloat:Session"
    private const val MAX_MINUTES = 480

    private var lock: PowerManager.WakeLock? = null
    private var taskId: String = ""
    private var expiresAt: Long = 0

    private fun pm(ctx: Context): PowerManager? =
        ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager

    @Synchronized
    fun acquire(ctx: Context, rawTaskId: String, minutes: Int): JSONObject {
        val manager = pm(ctx) ?: return err("WAKE_UNAVAILABLE", "系统不支持唤醒锁")
        val mins = minutes.coerceIn(1, MAX_MINUTES)
        return try {
            releaseInternal()
            val l = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG).apply {
                setReferenceCounted(false)
                acquire(mins * 60_000L)
            }
            lock = l
            taskId = rawTaskId.take(96)
            expiresAt = System.currentTimeMillis() + mins * 60_000L
            JSONObject().put("ok", true).put("minutes", mins).put("expiresAt", expiresAt)
        } catch (e: Exception) { err("WAKE_FAILED", e.message ?: "唤醒锁获取失败") }
    }

    @Synchronized
    fun release(): JSONObject {
        releaseInternal()
        return JSONObject().put("ok", true)
    }

    @Synchronized
    fun state(): JSONObject = JSONObject().apply {
        put("ok", true)
        put("held", lock?.isHeld == true)
        put("taskId", taskId)
        put("expiresAt", expiresAt)
    }

    private fun releaseInternal() {
        try {
            if (lock?.isHeld == true) lock?.release()
        } catch (_: Exception) {}
        lock = null
        taskId = ""
        expiresAt = 0
    }

    private fun err(code: String, message: String) =
        JSONObject().put("ok", false).put("errorCode", code).put("error", message)
}
