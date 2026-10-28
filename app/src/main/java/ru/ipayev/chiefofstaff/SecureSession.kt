package ru.ipayev.chiefofstaff

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Owner session and PKCE verifier stay in app-private, Keystore-encrypted storage. */
object SecureSession {
    private const val ALIAS = "nikodim.owner.session.v1"
    private lateinit var context: Context
    private val cookieNames = setOf("__Host-cos-calendar-session", "__Host-cos-pin-session")

    fun initialize(value: Context) { context = value.applicationContext }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun read(): JSONObject = runCatching {
        val value = context.getSharedPreferences("owner_session", Context.MODE_PRIVATE).getString("sealed", null)
            ?: return JSONObject()
        val parts = value.split(":", limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        JSONObject(String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
    }.getOrElse { JSONObject() }

    private fun write(value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        check(context.getSharedPreferences("owner_session", Context.MODE_PRIVATE).edit().putString("sealed", sealed).commit())
    }
    @Synchronized fun cookies(): String {
        val data = read()
        return cookieNames.mapNotNull { name -> data.optString(name).takeIf { it.matches(Regex("[A-Za-z0-9_-]{32,200}")) }?.let { "$name=$it" } }.joinToString("; ")
    }
    @Synchronized fun acceptCookies(values: List<String>) {
        val data = read()
        values.forEach { header ->
            val parts = header.split(";").map { it.trim() }
            val pair = parts.first().split("=", limit = 2)
            if (pair.size == 2 && pair[0] in cookieNames && parts.any { it.equals("Secure", true) } && parts.any { it.equals("HttpOnly", true) }) {
                if (pair[1].isEmpty() || parts.any { it.equals("Max-Age=0", true) }) data.remove(pair[0])
                else if (pair[1].matches(Regex("[A-Za-z0-9_-]{32,200}"))) data.put(pair[0], pair[1])
            }
        }
        write(data)
    }
    @Synchronized fun begin(verifier: String) { write(read().put("verifier", verifier).put("started", System.currentTimeMillis())) }
    @Synchronized fun verifier(): String? {
        val data = read()
        if (System.currentTimeMillis() - data.optLong("started") !in 0..600_000L) return null
        return data.optString("verifier").takeIf { it.matches(Regex("[A-Za-z0-9_-]{32,200}")) }
    }
    @Synchronized fun finishLogin() { write(read().apply { remove("verifier"); remove("started"); remove("__Host-cos-pin-session") }) }
    @Synchronized fun clearPin() { write(read().apply { remove("__Host-cos-pin-session") }) }
    @Synchronized fun clear() { context.getSharedPreferences("owner_session", Context.MODE_PRIVATE).edit().clear().commit() }
}
