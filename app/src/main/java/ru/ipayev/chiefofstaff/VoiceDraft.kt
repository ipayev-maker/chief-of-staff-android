package ru.ipayev.chiefofstaff

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

/** Private local outbox. The same UUID, timestamp and audio survive a network retry. */
data class VoiceDraft(val id: String, val recordedAt: String, val seconds: Int, val applyBody: String? = null) {
    fun file(context: Context) = File(context.filesDir, "voice_$id.m4a")
    fun save(context: Context) = synchronized(lock) {
        val data = JSONObject().put("id", id).put("recordedAt", recordedAt).put("seconds", seconds).put("applyBody", applyBody ?: JSONObject.NULL)
        val prefs = context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE)
        val edit = prefs.edit().putString("draft_$id", data.toString())
        if (decode(prefs.getString("draft", null))?.id == id) edit.remove("draft")
        check(edit.commit())
    }
    fun clear(context: Context) = synchronized(lock) {
        val prefs = context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE)
        val edit = prefs.edit().remove("draft_$id")
        if (decode(prefs.getString("draft", null))?.id == id) edit.remove("draft")
        check(edit.commit())
        file(context).delete()
    }
    companion object {
        private val lock = Any()
        fun create(context: Context) = VoiceDraft(UUID.randomUUID().toString(), Instant.now().toString(), 0).also { it.save(context) }
        fun load(context: Context, id: String): VoiceDraft? = all(context).firstOrNull { it.id == id }
        fun all(context: Context): List<VoiceDraft> = synchronized(lock) {
            val prefs = context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE)
            val drafts = linkedMapOf<String, VoiceDraft>()
            // Read the 0.4.0–0.4.2 slot without discarding an unfinished retry.
            decode(prefs.getString("draft", null))?.let { drafts[it.id] = it }
            prefs.all.filterKeys { it.startsWith("draft_") }.values.forEach { raw ->
                decode(raw as? String)?.let { drafts[it.id] = it }
            }
            drafts.values.sortedByDescending { Instant.parse(it.recordedAt) }
        }
        private fun decode(text: String?): VoiceDraft? = runCatching {
            if (text == null) return null
            val row = JSONObject(text); val id = row.getString("id")
            require(UUID.fromString(id).toString() == id.lowercase())
            Instant.parse(row.getString("recordedAt"))
            require(row.getInt("seconds") in 0..600)
            VoiceDraft(id, row.getString("recordedAt"), row.getInt("seconds"), if (row.isNull("applyBody")) null else row.getString("applyBody"))
        }.getOrNull()
    }
}
