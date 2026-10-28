package com.elly.assistant

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 本地密钥仓：AndroidKeyStore 生成 AES-256-GCM 主密钥，密文存独立 SharedPreferences。
 *
 * 设计约束（0.9 / E2-004）：
 * - 明文 Key 不落盘；密文与 iv 一起 base64 保存，每条一个 pref。
 * - Keystore 不可用或解密失败时返回空，绝不回退到明文存储。
 * - 只按名称存取，不提供遍历导出明文之外的能力。
 */
class SecretsVault(private val ctx: Context) {

    private val prefs get() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun masterKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun put(name: String, value: String): Boolean {
        if (name.isBlank()) return false
        return try {
            synchronized(LOCK) {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, masterKey())
                val iv = cipher.iv
                val body = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                val packed = ByteArray(iv.size + body.size)
                System.arraycopy(iv, 0, packed, 0, iv.size)
                System.arraycopy(body, 0, packed, iv.size, body.size)
                prefs.edit().putString(name, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()
            }
        } catch (_: Exception) { false }
    }

    fun get(name: String, def: String?): String? {
        val packed = try { prefs.getString(name, null) } catch (_: Exception) { null } ?: return def
        return try {
            synchronized(LOCK) {
                val bytes = Base64.decode(packed, Base64.NO_WRAP)
                if (bytes.size <= IV_BYTES) return def
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    masterKey(),
                    GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES)
                )
                String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
            }
        } catch (_: Exception) { def }
    }

    fun has(name: String): Boolean = try { prefs.contains(name) } catch (_: Exception) { false }

    fun delete(name: String): Boolean = try {
        prefs.edit().remove(name).commit()
    } catch (_: Exception) { false }

    /** 只返回名称列表，供设置页显示“已保存哪些 Key”，不返回任何明文。 */
    fun list(): String = try {
        JSONArray().apply {
            prefs.all.keys.sorted().forEach { put(it) }
        }.toString()
    } catch (_: Exception) { "[]" }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "elly_secrets_v1"
        private const val PREFS = "elly_secrets"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private val LOCK = Any()
    }
}
