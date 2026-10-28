package ru.ipayev.chiefofstaff

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class VoiceDraftTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val old = VoiceDraft("00000000-0000-4000-8000-000000000001", "2026-10-28T21:29:22.123456789Z", 12,
        """{"revision":4,"request_id":"same-request","proposal":{"version":1,"changes":[]}}""")

    @Before fun clearTestStorage() {
        context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).edit().clear().commit()
        context.filesDir.listFiles()?.filter { it.name.startsWith("voice_") }?.forEach { it.delete() }
    }

    private fun installLegacyDraft() {
        val data = JSONObject().put("id", old.id).put("recordedAt", old.recordedAt).put("seconds", old.seconds).put("applyBody", old.applyBody)
        context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).edit().putString("draft", data.toString()).commit()
        old.file(context).writeBytes(byteArrayOf(1, 2, 3, 4))
    }

    @Test fun newRecordingKeepsLegacyAudioAndIdenticalRetryPayload() {
        installLegacyDraft()
        val fresh = VoiceDraft.create(context)
        assertNotEquals(old.id, fresh.id)
        assertEquals(2, VoiceDraft.all(context).size)
        assertEquals(old, VoiceDraft.load(context, old.id))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), old.file(context).readBytes())
        assertEquals(0, VoiceDraft.load(context, fresh.id)?.seconds)
    }

    @Test fun updatingOneDraftKeepsOtherDraftsAndMigratesLegacyWithoutDuplicates() {
        installLegacyDraft()
        val fresh = VoiceDraft.create(context)
        val updated = old.copy(seconds = 14)
        updated.save(context)
        assertEquals(updated, VoiceDraft.load(context, old.id))
        assertEquals(fresh, VoiceDraft.load(context, fresh.id))
        assertEquals(2, VoiceDraft.all(context).size)
        assertFalse(context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).contains("draft"))
        assertEquals(old.applyBody, VoiceDraft.load(context, old.id)?.applyBody)
    }

    @Test fun discardingFreshDraftDoesNotDeleteLegacyDraftOrAudio() {
        installLegacyDraft()
        val fresh = VoiceDraft.create(context)
        fresh.file(context).writeBytes(byteArrayOf(5, 6))
        fresh.clear(context)
        assertFalse(fresh.file(context).exists())
        assertEquals(listOf(old), VoiceDraft.all(context))
        assertTrue(old.file(context).exists())
    }

    @Test fun confirmingLegacyDraftDoesNotDeleteFreshDraftOrAudio() {
        installLegacyDraft()
        val fresh = VoiceDraft.create(context).copy(seconds = 6).also { it.save(context) }
        fresh.file(context).writeBytes(byteArrayOf(5, 6))
        old.clear(context)
        assertNull(VoiceDraft.load(context, old.id))
        assertFalse(old.file(context).exists())
        assertEquals(listOf(fresh), VoiceDraft.all(context))
        assertArrayEquals(byteArrayOf(5, 6), fresh.file(context).readBytes())
    }

    private fun field(activity: QuickCaptureActivity, name: String): Any? =
        QuickCaptureActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)

    @Test fun freshWidgetActivityDoesNotSelectAnOldSavedMessage() {
        installLegacyDraft()
        val controller = Robolectric.buildActivity(QuickCaptureActivity::class.java).create()
        try {
            assertNull(field(controller.get(), "draft"))
            assertEquals(true, field(controller.get(), "newRecordingRequested"))
            assertEquals(old, VoiceDraft.load(context, old.id))
        } finally { controller.destroy() }
    }

    @Test fun recreationRestoresOnlyItsOwnDraftNotTheNewestUnrelatedDraft() {
        installLegacyDraft()
        VoiceDraft.create(context)
        val state = Bundle().apply { putString("capture_draft_id", old.id); putBoolean("new_recording_requested", false) }
        val controller = Robolectric.buildActivity(QuickCaptureActivity::class.java).create(state)
        try {
            assertEquals(old, field(controller.get(), "draft"))
            assertEquals(false, field(controller.get(), "newRecordingRequested"))
            controller.newIntent(Intent(context, QuickCaptureActivity::class.java))
            assertEquals(true, field(controller.get(), "newRecordingRequested"))
            assertEquals(2, VoiceDraft.all(context).size)
        } finally { controller.destroy() }
    }
}
