package ru.ipayev.chiefofstaff

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import android.widget.FrameLayout
import android.view.Gravity
import android.view.View
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

/** Records original audio only. All speech recognition runs on the server. */
class QuickCaptureActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private var recorder: MediaRecorder? = null
    private var started = 0L
    private var draft: VoiceDraft? = null
    private var item: JSONObject? = null
    private var busy = false
    private var active = false
    private var resumeAfterLogin = false
    private var initialCheck = false
    private val choices = mutableListOf<Pair<JSONObject, CheckBox>>()
    private val timer = object : Runnable {
        override fun run() {
            if (recorder == null) return
            val seconds = (SystemClock.elapsedRealtime() - started) / 1000
            status.text = "Запись · %d:%02d\nНазовите действие, участника, дату и время.".format(seconds / 60, seconds % 60)
            main.postDelayed(this, 500)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(24), dp(22), dp(24)); background = roundedDrawable(Color.WHITE, dp(20).toFloat()) }
        val sheet = object : ScrollView(this) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val maxHeight = minOf(dp(620), (resources.displayMetrics.heightPixels * 0.82).toInt())
                super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(minOf(View.MeasureSpec.getSize(heightMeasureSpec), maxHeight), View.MeasureSpec.AT_MOST))
            }
        }.apply { addView(root); clipToOutline = true; background = roundedDrawable(Color.WHITE, dp(20).toFloat()) }
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.argb(80, 0, 0, 0)); setPadding(dp(10), dp(10), dp(10), dp(10))
            addView(sheet, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        setContentView(overlay); applySystemInsets(overlay)
        draft = VoiceDraft.load(this)
        base("Голосовое сообщение", "Проверяю вход…")
    }
    override fun onResume() {
        super.onResume(); active = true
        if (!initialCheck || resumeAfterLogin) { initialCheck = true; resumeAfterLogin = false; authorize() }
    }
    override fun onPause() {
        active = false
        if (recorder != null) { stopRecording(); pending("Запись остановлена и сохранена на телефоне.") }
        super.onPause()
    }
    override fun onDestroy() { main.removeCallbacksAndMessages(null); recorder?.release(); recorder = null; io.shutdown(); super.onDestroy() }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) {
            if (resultCode == RESULT_OK) resumeAfterLogin = true
            else { base("Вход не завершён", "Для отправки записи нужен аккаунт владельца и PIN."); button("Войти") { authorize() }; button("Закрыть", false) { finish() } }
        }
    }
    private fun base(title: String, text: String) {
        root.removeAllViews(); choices.clear(); root.addView(label(title, 24f))
        status = label(text, 16f, muted = true); root.addView(status); status.margin(top = dp(14), bottom = dp(20))
    }
    private fun button(text: String, primary: Boolean = true, action: () -> Unit) {
        root.addView((if (primary) primaryButton(text) else secondaryButton(text)).apply { setOnClickListener { if (!busy) action() } })
        root.getChildAt(root.childCount - 1).margin(top = dp(10))
    }
    private fun authorize() {
        work({ ApiClient.requireUnlocked() }) {
            if (!active) { resumeAfterLogin = true; return@work }
            if (draft == null) startRecording() else restore()
        }
    }
    @Suppress("DEPRECATION")
    private fun startRecording() {
        if (!active || recorder != null) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 20); return }
        val next = VoiceDraft.create(this); draft = next; item = null
        val recording = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else MediaRecorder()
        try {
            recording.setAudioSource(MediaRecorder.AudioSource.MIC)
            recording.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recording.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recording.setAudioChannels(1); recording.setAudioSamplingRate(16000); recording.setAudioEncodingBitRate(32000)
            recording.setMaxDuration(600_000); recording.setMaxFileSize(3L * 1024 * 1024)
            recording.setOutputFile(next.file(this).absolutePath)
            recording.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED || what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED) { stopRecording(); pending("Достигнут предел записи. Можно отправить сообщение.") } }
            recording.setOnErrorListener { _, _, _ -> stopRecording(); pending("Запись прервалась. Проверьте сохранённый фрагмент.") }
            recording.prepare(); recording.start(); recorder = recording; started = SystemClock.elapsedRealtime()
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            base("Говорите", "Запись начинается…"); button("Готово — разобрать") { stopRecording(); upload() }
            button("Отменить запись", false) { discard() }
            main.post(timer)
        } catch (_: Exception) {
            recording.release(); recorder = null; next.clear(this); draft = null
            base("Микрофон недоступен", "Закройте другие приложения, использующие микрофон, и повторите.")
            button("Начать запись") { startRecording() }; button("Закрыть", false) { finish() }
        }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 20 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            // Permission callbacks can arrive before onResume. Start only once visible.
            if (active) startRecording() else resumeAfterLogin = true
        }
        else { base("Нужен доступ к микрофону", "Разрешите запись звука в настройках приложения."); button("Настройки") { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }; button("Начать запись", false) { startRecording() } }
    }
    private fun stopRecording() {
        val recording = recorder ?: return; recorder = null
        main.removeCallbacks(timer); window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val seconds = ((SystemClock.elapsedRealtime() - started + 999) / 1000).toInt().coerceIn(1, 600)
        val valid = runCatching { recording.stop() }.isSuccess; recording.release()
        if (valid) { draft = draft?.copy(seconds = seconds); draft?.save(this) }
        else { draft?.clear(this); draft = null }
    }
    private fun pending(message: String = "Запись сохранена на телефоне. Можно отправить её на разбор.") {
        val current = draft
        if (current == null || !current.file(this).exists() || current.seconds == 0) {
            base("Запись не завершена", "Этот фрагмент не удалось сохранить. Запишите сообщение ещё раз.")
            button("Записать заново") { draft?.clear(this); draft = null; startRecording() }; button("Закрыть", false) { finish() }; return
        }
        base("Голосовое сообщение", message)
        button(if (current.applyBody != null) "Проверить сохранение" else "Отправить на разбор") { if (current.applyBody != null) restore() else upload() }
        button("Удалить запись с телефона", false) { discard() }
        button("Закрыть", false) { finish() }
    }
    private fun restore() {
        val current = draft ?: return
        base("Сохранённое сообщение", "Проверяю состояние на сервере…")
        work({ try { ApiClient.inbox(current.id) } catch (e: ApiClient.RequestError) { if (e.status == 404) null else throw e } }) { loaded ->
            if (loaded == null) pending()
            else if (current.applyBody != null && loaded.optString("status") != "applied") {
                item = loaded
                base("Подтверждение не получено", "Запись сохранена. Можно безопасно повторить то же подтверждение.")
                button("Повторить подтверждение") { sendApply(JSONObject(current.applyBody)) }
                button("Обновить карточку", false) { draft = current.copy(applyBody = null); draft?.save(this); showItem(loaded) }
            } else showItem(loaded)
        }
    }
    private fun upload() {
        val current = draft ?: run { pending(); return }
        if (current.seconds == 0) { pending(); return }
        base("Разбираю сообщение", "Отправляю запись. Затем распознаю речь и выделю задачи и встречи.")
        work({ ApiClient.uploadVoice(current, current.file(this)) }) { showItem(it) }
    }
    private fun showItem(value: JSONObject) {
        item = value
        when (value.optString("status")) {
            "applied" -> {
                draft?.clear(this); draft = null
                base("Готово", "Сообщение обработано. Подтверждённые действия сохранены в дашборде.")
                button("Закрыть") { finish() }; button("Ещё сообщение", false) { startRecording() }; return
            }
            "processing" -> {
                base("Сообщение обрабатывается", "Сервер ещё разбирает запись. Повторная отправка не создаст копию.")
                button("Обновить") { restore() }; button("Закрыть", false) { finish() }; return
            }
            "captured", "error" -> {
                pending(if (value.optString("error_code").startsWith("voice_")) "Запись сохранена, но распознавание не завершилось. Повторите отправку позже." else "Запись сохранена, но разбор не завершился. Можно повторить попытку.")
                button("Открыть карточку", false) { openCard() }; return
            }
        }
        val proposal = value.optJSONObject("proposal") ?: JSONObject()
        val transcript = value.optString("transcript").takeIf { it.isNotBlank() && it != "null" } ?: value.optString("source_text")
        base("Проверьте результат", proposal.optString("summary"))
        val questions = proposal.optJSONArray("questions") ?: JSONArray()
        for (i in 0 until questions.length()) root.addView(label(questions.getString(i), 16f).apply { margin(bottom = dp(8)) })
        val changes = proposal.optJSONArray("changes") ?: JSONArray()
        for (i in 0 until changes.length()) {
            val change = changes.getJSONObject(i)
            val kind = when (change.optString("kind")) { "meeting_create" -> "Встреча"; "task_update" -> "Изменить задачу"; "task_create" -> "Задача"; else -> "Изменение проекта" }
            val check = CheckBox(this).apply { text = "$kind: ${change.optString("text")}"; textSize = 17f; isChecked = change.optBoolean("selected", true); setPadding(0, dp(10), 0, dp(6)) }
            root.addView(check); choices.add(change to check)
            val metadata = buildList {
                change.nonempty("project_title")?.let { add("Проект: $it") }
                (change.nonempty("participant_name") ?: change.optJSONObject("participant_suggestion")?.nonempty("name"))?.let { add("Участник: $it") }
                change.nonempty("meeting_date")?.let { add("Встреча: $it ${change.nonempty("meeting_time") ?: "—"}") }
                change.nonempty("deadline")?.let { add("Срок: $it ${change.nonempty("deadline_time") ?: ""}") }
                change.nonempty("planned_on")?.let { add("Сделать: $it ${change.nonempty("planned_time") ?: ""}") }
            }
            if (metadata.isNotEmpty()) root.addView(label(metadata.joinToString("\n"), 15f, muted = true))
        }
        button(if (changes.length() > 0) "Сохранить выбранное" else "Оставить заметкой") { confirm() }
        button("Исправить в карточке", false) { openCard() }
        root.addView(sectionTitle("Расшифровка").apply { margin(top = dp(24), bottom = dp(8)) })
        root.addView(label(transcript, 16f).apply { setTextIsSelectable(true) })
        button("Закрыть и вернуться позже", false) { finish() }
    }
    private fun confirm() {
        val current = item ?: return
        val changes = JSONArray()
        for ((change, check) in choices) changes.put(JSONObject(change.toString()).put("selected", check.isChecked))
        val body = JSONObject().put("revision", current.getInt("revision")).put("request_id", UUID.randomUUID().toString())
            .put("proposal", JSONObject().put("version", 1).put("changes", changes))
        draft = draft?.copy(applyBody = body.toString()); draft?.save(this)
        sendApply(body)
    }
    private fun sendApply(body: JSONObject) {
        val id = draft?.id ?: return
        base("Сохраняю", "Подтверждаю выбранные задачи и встречи…")
        work({ ApiClient.apply(id, body) }) { showItem(it) }
    }
    private fun openCard() { val id = draft?.id ?: return; startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ApiClient.BASE_URL + "/#/inbox/$id"))) }
    private fun discard() {
        AlertDialog.Builder(this).setTitle("Удалить запись с телефона?").setMessage("Если сообщение уже отправлено, его копия останется в дашборде.")
            .setPositiveButton("Удалить") { _, _ -> stopRecording(); draft?.clear(this); draft = null; item = null; finish() }.setNegativeButton("Отмена", null).show()
    }
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (recorder != null) { stopRecording(); pending() } else super.onBackPressed()
    }
    private fun JSONObject.nonempty(key: String) = if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
    private fun <T> work(job: () -> T, success: (T) -> Unit) {
        if (busy) return; busy = true
        io.execute {
            val result = runCatching(job)
            runOnUiThread {
                busy = false; if (isFinishing || isDestroyed) return@runOnUiThread
                result.onSuccess(success).onFailure { error ->
                    if (error is ApiClient.AccessRequired) { if (active) startActivityForResult(Intent(this, LoginActivity::class.java), 10) else resumeAfterLogin = true }
                    else {
                        pending("${error.message ?: "Нет связи с сервером."}\nЗапись остаётся на телефоне.")
                        if (draft == null) button("Повторить проверку входа", false) { authorize() }
                    }
                }
            }
        }
    }
}
