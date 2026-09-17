package ru.ipayev.chiefofstaff

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import java.util.Locale
import java.util.concurrent.Executors

class CaptureActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private var recognizer: SpeechRecognizer? = null
    private var projects: List<Project> = emptyList()
    private val draftRows = mutableListOf<DraftRow>()

    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private lateinit var transcript: EditText
    private lateinit var listenButton: Button
    private lateinit var parseButton: Button
    private lateinit var progress: ProgressBar
    private lateinit var reviewTitle: TextView
    private lateinit var reviewBox: LinearLayout
    private lateinit var saveButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        loadProjects()
        if (intent.getBooleanExtra(EXTRA_AUTOSTART, false) || intent.action == ACTION_SHORTCUT_CAPTURE) {
            ensureAudioPermissionAndListen()
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent?.getBooleanExtra(EXTRA_AUTOSTART, false) == true || intent?.action == ACTION_SHORTCUT_CAPTURE) {
            resetForNewCapture()
            ensureAudioPermissionAndListen()
        }
    }

    override fun onDestroy() {
        recognizer?.destroy()
        recognizer = null
        io.shutdownNow()
        super.onDestroy()
    }

    private fun buildUi(): ScrollView {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.rgb(245, 247, 251))
            isFillViewport = true
        }
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(40))
        }
        scroll.addView(root)

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(label("Никодим", 28f).apply {
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        top.addView(secondaryButton("Закрыть").apply {
            setOnClickListener { finish() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        })
        root.addView(top)
        root.addView(label("Продиктуйте задачу обычной речью. Ничего не создаётся без подтверждения.", 13f, muted = true).apply {
            margin(top = dp(5), bottom = dp(18))
        })

        val listenCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(18), dp(22), dp(18), dp(20))
            background = roundedDrawable(Color.WHITE, dp(20).toFloat(), Color.rgb(215, 222, 232), dp(1))
        }
        status = label("Готов к диктовке", 16f).apply {
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        listenCard.addView(status)

        listenButton = primaryButton("🎙  Начать диктовку").apply {
            textSize = 18f
            setOnClickListener { ensureAudioPermissionAndListen() }
        }
        listenCard.addView(listenButton)
        listenButton.margin(top = dp(14))

        progress = ProgressBar(this).apply {
            visibility = View.GONE
            isIndeterminate = true
        }
        listenCard.addView(progress)
        progress.margin(top = dp(12))
        root.addView(listenCard)

        root.addView(sectionTitle("Распознанный текст").apply { margin(top = dp(22), bottom = dp(8)) })
        transcript = EditText(this).apply {
            minLines = 3
            maxLines = 8
            textSize = 16f
            hint = "Например: завтра утром отправить Елене итог по Интершарму…"
            setTextColor(Color.rgb(23, 32, 51))
            setHintTextColor(Color.rgb(152, 162, 179))
            background = roundedDrawable(Color.WHITE, dp(14).toFloat(), Color.rgb(215, 222, 232), dp(1))
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        root.addView(transcript)

        parseButton = primaryButton("Разобрать текст").apply {
            setOnClickListener { parseTranscript() }
        }
        root.addView(parseButton)
        parseButton.margin(top = dp(10))

        reviewTitle = sectionTitle("Черновики задач").apply { visibility = View.GONE }
        root.addView(reviewTitle)
        reviewTitle.margin(top = dp(28), bottom = dp(8))

        reviewBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(reviewBox)

        saveButton = primaryButton("Создать выбранные задачи").apply {
            visibility = View.GONE
            setOnClickListener { saveDrafts() }
        }
        root.addView(saveButton)
        saveButton.margin(top = dp(8), bottom = dp(16))
        return scroll
    }

    private fun ensureAudioPermissionAndListen() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startListening()
        } else {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startListening()
            else setError("Без доступа к микрофону голосовой ввод не работает. Разрешение можно включить в настройках Android.")
        }
    }

    private fun startListening() {
        hideKeyboard()
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            setError("На устройстве не найден системный сервис распознавания речи.")
            return
        }
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    status.setTextColor(Color.rgb(23, 32, 51))
                    status.text = "Слушаю…"
                    listenButton.text = "Говорите"
                    listenButton.isEnabled = false
                    progress.visibility = View.VISIBLE
                }
                override fun onBeginningOfSpeech() { status.text = "Записываю речь…" }
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() { status.text = "Распознаю…" }
                override fun onError(error: Int) {
                    progress.visibility = View.GONE
                    listenButton.isEnabled = true
                    listenButton.text = "🎙  Повторить диктовку"
                    status.text = when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH -> "Не расслышал. Попробуйте ещё раз."
                        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Речь не услышана."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Ошибка сети при распознавании."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Нет доступа к микрофону."
                        else -> "Распознавание остановлено ($error)."
                    }
                }
                override fun onResults(results: Bundle?) {
                    val best = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    progress.visibility = View.GONE
                    listenButton.isEnabled = true
                    listenButton.text = "🎙  Продиктовать заново"
                    if (best.isNotBlank()) {
                        transcript.setText(best)
                        transcript.setSelection(best.length)
                        status.text = "Текст распознан"
                        parseTranscript()
                    } else status.text = "Текст не распознан"
                }
                override fun onPartialResults(partialResults: Bundle?) {
                    val part = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    if (part.isNotBlank()) {
                        transcript.setText(part)
                        transcript.setSelection(part.length)
                    }
                }
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
        }
        val recognizerIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "ru-RU")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Диктуйте задачу")
        }
        recognizer?.startListening(recognizerIntent)
    }

    private fun parseTranscript() {
        val text = transcript.text.toString().trim()
        if (text.isBlank()) {
            setError("Сначала продиктуйте или введите текст.")
            return
        }
        hideKeyboard()
        setBusy("Никодим разбирает текст…")
        io.execute {
            if (projects.isEmpty()) runCatching { ApiClient.loadProjects() }.onSuccess { projects = it }
            runCatching { ApiClient.parseVoice(text) }
                .onSuccess { result -> runOnUiThread { showDrafts(result) } }
                .onFailure { e -> runOnUiThread { setError("Не удалось разобрать текст: ${e.message ?: "ошибка сети"}") } }
        }
    }

    private fun showDrafts(result: ParseResult) {
        progress.visibility = View.GONE
        parseButton.isEnabled = true
        listenButton.isEnabled = true
        saveButton.isEnabled = true
        status.setTextColor(Color.rgb(23, 32, 51))
        status.text = if (result.drafts.isEmpty()) "Никодим не нашёл явных задач" else "Проверьте черновики перед созданием"
        reviewBox.removeAllViews()
        draftRows.clear()
        if (result.drafts.isEmpty()) {
            reviewTitle.visibility = View.GONE
            saveButton.visibility = View.GONE
            return
        }
        reviewTitle.visibility = View.VISIBLE
        saveButton.visibility = View.VISIBLE
        result.drafts.forEachIndexed { index, draft ->
            val row = buildDraftCard(index, draft)
            draftRows += row
            reviewBox.addView(row.container)
            row.container.margin(bottom = dp(10))
        }
    }

    private fun buildDraftCard(index: Int, draft: Draft): DraftRow {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(14))
            background = roundedDrawable(Color.WHITE, dp(16).toFloat(), Color.rgb(215, 222, 232), dp(1))
        }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val check = CheckBox(this).apply {
            isChecked = true
            text = "Задача ${index + 1}"
            textSize = 14f
            setTextColor(Color.rgb(23, 32, 51))
            setTypeface(typeface, Typeface.BOLD)
        }
        header.addView(check, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        card.addView(header)
        val description = EditText(this).apply {
            setText(draft.description)
            minLines = 2
            maxLines = 6
            textSize = 15f
            setTextColor(Color.rgb(23, 32, 51))
            background = roundedDrawable(Color.rgb(248, 250, 252), dp(12).toFloat(), Color.rgb(226, 232, 240), dp(1))
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        card.addView(description)
        description.margin(top = dp(8), bottom = dp(10))
        card.addView(label("Проект", 12f, muted = true))
        val projectTitles = listOf("Без проекта") + projects.map { it.title }
        val spinner = Spinner(this).apply {
            adapter = ArrayAdapter(this@CaptureActivity, android.R.layout.simple_spinner_dropdown_item, projectTitles)
            background = roundedDrawable(Color.rgb(248, 250, 252), dp(10).toFloat(), Color.rgb(215, 222, 232), dp(1))
            setPadding(dp(8), dp(4), dp(8), dp(4))
            setSelection(findProjectIndex(draft.projectTitle) + 1)
        }
        card.addView(spinner)
        spinner.margin(top = dp(4), bottom = dp(8))
        val metaParts = mutableListOf<String>()
        metaParts += directionLabel(draft.direction)
        draft.who?.takeIf { it.isNotBlank() }?.let { metaParts += "от/для: $it" }
        draft.deadline?.let { metaParts += "срок $it" }
        draft.deadlineText?.takeIf { it != draft.deadline }?.let { metaParts += "«$it»" }
        card.addView(label(metaParts.joinToString(" · "), 12f, muted = true))
        if (draft.warnings.isNotEmpty()) {
            card.addView(label(draft.warnings.joinToString("\n"), 12f, muted = true).apply {
                setTextColor(Color.rgb(193, 116, 20))
                margin(top = dp(6))
            })
        }
        return DraftRow(card, check, description, spinner, draft)
    }

    private fun saveDrafts() {
        val sourceText = transcript.text.toString().trim()
        val selected = draftRows.filter { it.checkBox.isChecked }
        if (selected.isEmpty()) {
            setError("Выберите хотя бы одну задачу.")
            return
        }
        setBusy("Создаю ${selected.size} ${taskWord(selected.size)}…")
        io.execute {
            runCatching {
                selected.forEach { row ->
                    val description = row.description.text.toString().trim()
                    if (description.isBlank()) return@forEach
                    row.draft.description = description
                    val projectId = row.projectSpinner.selectedItemPosition.takeIf { it > 0 }?.let { projects[it - 1].id }
                    ApiClient.createCommitment(row.draft, projectId, sourceText)
                }
            }.onSuccess { runOnUiThread { showSuccess(selected.size) } }
                .onFailure { e -> runOnUiThread { setError("Задачи не сохранены: ${e.message ?: "ошибка сети"}") } }
        }
    }

    private fun showSuccess(count: Int) {
        progress.visibility = View.GONE
        status.setTextColor(Color.rgb(33, 138, 99))
        status.text = "Готово: ${createdPhrase(count)}"
        reviewTitle.visibility = View.GONE
        reviewBox.removeAllViews()
        saveButton.visibility = View.GONE
        parseButton.isEnabled = true
        listenButton.isEnabled = true
        listenButton.text = "🎙  Продиктовать ещё"
        listenButton.setOnClickListener { resetForNewCapture(); ensureAudioPermissionAndListen() }
        transcript.setText("")
    }

    private fun resetForNewCapture() {
        recognizer?.cancel()
        transcript.setText("")
        reviewBox.removeAllViews()
        draftRows.clear()
        reviewTitle.visibility = View.GONE
        saveButton.visibility = View.GONE
        progress.visibility = View.GONE
        status.setTextColor(Color.rgb(23, 32, 51))
        status.text = "Готов к диктовке"
        parseButton.isEnabled = true
        listenButton.isEnabled = true
        listenButton.text = "🎙  Начать диктовку"
        listenButton.setOnClickListener { ensureAudioPermissionAndListen() }
    }

    private fun loadProjects() {
        io.execute { runCatching { ApiClient.loadProjects() }.onSuccess { loaded -> projects = loaded } }
    }

    private fun setBusy(message: String) {
        status.text = message
        progress.visibility = View.VISIBLE
        parseButton.isEnabled = false
        listenButton.isEnabled = false
        saveButton.isEnabled = false
    }

    private fun setError(message: String) {
        progress.visibility = View.GONE
        status.text = message
        status.setTextColor(Color.rgb(194, 65, 55))
        parseButton.isEnabled = true
        listenButton.isEnabled = true
        saveButton.isEnabled = true
    }

    private fun findProjectIndex(projectTitle: String?): Int {
        if (projectTitle.isNullOrBlank()) return -1
        val needle = normalize(projectTitle)
        val exact = projects.indexOfFirst { normalize(it.title) == needle }
        if (exact >= 0) return exact
        return projects.indexOfFirst { normalize(it.title).contains(needle) || needle.contains(normalize(it.title)) }
    }

    private fun normalize(value: String): String = value
        .lowercase(Locale.forLanguageTag("ru-RU"))
        .replace('ё', 'е')
        .replace(Regex("\\s+"), " ")
        .trim()

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(currentFocus?.windowToken, 0)
    }

    private fun directionLabel(direction: String): String = when (direction) {
        "from_me" -> "Мне сделать"
        "to_me" -> "Жду от другого"
        else -> "Моя задача"
    }

    private fun taskWord(count: Int): String {
        val mod10 = count % 10
        val mod100 = count % 100
        return when {
            mod100 in 11..14 -> "задач"
            mod10 == 1 -> "задачу"
            mod10 in 2..4 -> "задачи"
            else -> "задач"
        }
    }

    private fun createdPhrase(count: Int): String {
        val mod10 = count % 10
        val mod100 = count % 100
        return when {
            mod100 in 11..14 -> "создано $count задач"
            mod10 == 1 -> "создана $count задача"
            mod10 in 2..4 -> "созданы $count задачи"
            else -> "создано $count задач"
        }
    }

    private data class DraftRow(
        val container: LinearLayout,
        val checkBox: CheckBox,
        val description: EditText,
        val projectSpinner: Spinner,
        val draft: Draft
    )

    companion object {
        const val EXTRA_AUTOSTART = "start_voice"
        const val ACTION_SHORTCUT_CAPTURE = "ru.ipayev.chiefofstaff.VOICE_CAPTURE"
        private const val REQUEST_AUDIO = 1001
    }
}
