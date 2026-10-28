package ru.ipayev.chiefofstaff

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

/** Private local outbox. The same UUID, timestamp and audio survive a network retry. */
data class VoiceDraft(val id: String, val recordedAt: String, val seconds: Int, val applyBody: String? = null) {
    fun file(context: Context) = File(context.filesDir, "voice_$id.m4a")
    fun save(context: Context) {
        val data = JSONObject().put("id", id).put("recordedAt", recordedAt).put("seconds", seconds).put("applyBody", applyBody ?: JSONObject.NULL)
        check(context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).edit().putString("draft", data.toString()).commit())
    }
    fun clear(context: Context) {
        file(context).delete()
        context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).edit().clear().commit()
    }
    companion object {
        fun create(context: Context) = VoiceDraft(UUID.randomUUID().toString(), Instant.now().toString(), 0).also { it.save(context) }
        fun load(context: Context): VoiceDraft? = runCatching {
            val text = context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).getString("draft", null) ?: return null
            val row = JSONObject(text); val id = row.getString("id"); UUID.fromString(id)
            VoiceDraft(id, row.getString("recordedAt"), row.getInt("seconds"), if (row.isNull("applyBody")) null else row.getString("applyBody"))
        }.getOrNull()
    }
}
