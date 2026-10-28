package ru.ipayev.chiefofstaff

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAlertDialog
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class, qualifiers = "w412dp-h892dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CaptureSurfaceTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Before fun clearDrafts() {
        context.getSharedPreferences("voice_outbox", Context.MODE_PRIVATE).edit().clear().commit()
        context.filesDir.listFiles()?.filter { it.name.startsWith("voice_") }?.forEach { it.delete() }
    }

    private fun recording(activity: QuickCaptureActivity) {
        QuickCaptureActivity::class.java.getDeclaredMethod("showRecordingControls").apply { isAccessible = true }.invoke(activity)
    }
    private fun descendants(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()

    private fun render(activity: QuickCaptureActivity, name: String, width: Int, height: Int): Bitmap {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        content.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        content.layout(0, 0, width, height)
        descendants(content).forEach { it.animate().cancel(); it.alpha = 1f; it.translationY = 0f }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); canvas.drawColor(Color.rgb(25, 25, 25)); content.draw(canvas)
        val folder = File("build/outputs/capture-previews").apply { mkdirs() }
        File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    @Test @Config(qualifiers = "w320dp-h640dp-mdpi")
    fun recordingFitsSmallScreenAndAudioChangesTheWaveform() {
        val controller = Robolectric.buildActivity(QuickCaptureActivity::class.java).create()
        try {
            val activity = controller.get(); recording(activity)
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
            val quiet = render(activity, "recording-320-silent", 320, 640)
            val controls = descendants(content).filterIsInstance<ImageButton>()
            assertEquals(2, controls.size)
            controls.forEach { assertTrue(it.width >= 48); assertTrue(it.height >= 48) }
            assertTrue(controls[0].right < controls[1].left)
            val wave = descendants(content).filterIsInstance<RecordingWaveView>().single()
            assertTrue(wave.width >= 100)
            listOf(1200, 2400, 8000, 14000, 22000, 32767, 22000, 14000, 8000, 2400, 1200).forEach(wave::setAmplitude)
            val talking = render(activity, "recording-320-speaking", 320, 640)
            assertFalse("Real sound must change the rendered meter", quiet.sameAs(talking))
        } finally { controller.destroy() }
    }

    @Test fun cancelNeedsConfirmationAndSavedRecordingsRemainAccessible() {
        val saved = VoiceDraft.create(context).copy(seconds = 12).also { it.save(context); it.file(context).writeBytes(byteArrayOf(1, 2, 3)) }
        val controller = Robolectric.buildActivity(QuickCaptureActivity::class.java).create()
        try {
            val activity = controller.get(); recording(activity)
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
            render(activity, "recording-412-saved", 412, 892)
            descendants(content).single { it.contentDescription == "Отменить запись" }.performClick()
            val dialog = ShadowAlertDialog.getLatestAlertDialog()
            assertNotNull(dialog)
            assertTrue(saved.file(context).exists())
            dialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).performClick()
            descendants(content).single { it.contentDescription?.startsWith("Сохранённые сообщения:") == true }.performClick()
            assertTrue(descendants(content).filterIsInstance<TextView>().any { it.text.contains("Сохранённые сообщения") })
            assertEquals(saved, VoiceDraft.load(context, saved.id))
            render(activity, "saved-412", 412, 892)
        } finally { controller.destroy() }
    }
}
