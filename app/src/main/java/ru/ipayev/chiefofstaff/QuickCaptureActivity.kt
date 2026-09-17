package ru.ipayev.chiefofstaff

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale
import java.util.concurrent.Executors

class QuickCaptureActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private var recognizer: SpeechRecognizer? = null
    private var sessionActive = false
    private var parseStarted = false
    private var inSpeech = false
    private var heardSpeech = false
    private var lastSilenceAnchorMs = 0L
    private var currentPartial = ""
    private val finalSegments = mutableListOf<String>()
    private var projects: List<Project> = emptyList()
    private val draftRows = mutableListOf<QuickDraftRow>()
    private var sourceText = ""

    private lateinit var card: LinearLayout
    private lateinit var mic: ImageView
    private lateinit var status: TextView
    private lateinit var countdown: TextView
    private lateinit var transcript: TextView
    private lateinit var progress: ProgressBar
    private lateinit var doneButton: Button
    private lateinit var cancelButton: Button
    private lateinit var reviewBox: LinearLayout
    private lateinit var confirmButton: Button
    private lateinit var retryButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureWindow()
        setContentView(buildUi())
        setFinishOnTouchOutside(false)
        loadProjectsInBackground()
        ensurePermissionAndStart()
    }

    override fun onDestroy() {
        sessionActive = false
        main.removeCallbacksAndMessages(null)
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        io.shutdownNow()
        super.onDestroy()
    }

    private fun configureWindow() {
        window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        val attrs = window.attributes
        attrs.dimAmount = 0.38f
        attrs.gravity = Gravity.CENTER
        window.attributes = attrs
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            val width = (resources.displayMetrics.widthPixels - dp(24)).coerceAtMost(dp(520))
            window.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT)
        }
    }

    private fun buildUi(): ScrollView {
        val scroll = ScrollView(this).apply {
            isFillViewport = false
            setBackgroundColor(Color.TRANSPARENT)
        }
        card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = roundedDrawable(Color.WHITE, dp(24).toFloat(), Color.rgb(214, 222, 232), dp(1))
        }
        scroll.addView(card)

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(label("Никодим", 19f).apply {
            setTypeface(typeface, Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        top.addView(TextView(this).apply {
            text = "×"
            textSize = 28f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(102, 112, 133))
            setPadding(dp(10), 0, dp(2), 0)
            setOnClickListener { finish() }
        })
        card.addView(top, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        mic = ImageView(this).apply {
            setImageResource(R.drawable.ic_nikodim_mic)
            setPadding(dp(22), dp(22), dp(22), dp(22))
            background = roundedDrawable(Color.rgb(55, 104, 232), dp(48).toFloat())
            contentDescription = "Микрофон"
        }
        card.addView(mic, LinearLayout.LayoutParams(dp(96), dp(96)).apply { topMargin = dp(14) })

        status = label("Запускаю микрофон…", 18f).apply {
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
        }
        card.addView(status, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })

        countdown = label("После паузы жду 5 секунд", 13f, muted = true).apply { gravity = Gravity.CENTER }
        card.addView(countdown, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })

        transcript = label("", 16f).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(10), dp(10), dp(10))
            visibility = View.GONE
            background = roundedDrawable(Color.rgb(247, 249, 252), dp(14).toFloat())
        }
        card.addView(transcript, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

        progress = ProgressBar(this).apply { visibility = View.GONE; isIndeterminate = true }
        card.addView(progress, LinearLayout.LayoutParams(dp(34), dp(34)).apply { topMargin = dp(10) })

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        cancelButton = secondaryButton("Отмена").apply { setOnClickListener { finish() } }
        doneButton = primaryButton("Готово").apply {
            isEnabled = false
            setOnClickListener { finishListeningAndParse(force = true) }
        }
        actions.addView(cancelButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6) })
        actions.addView(doneButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(6) })
        card.addView(actions, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) })

        reviewBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        card.addView(reviewBox, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })

        retryButton = secondaryButton("Передиктовать").apply {
            visibility = View.GONE
            setOnClickListener { beginSession() }
        }
        confirmButton = primaryButton("Создать").apply {
            visibility = View.GONE
            setOnClickListener { createSelectedDrafts() }
        }
        val confirmActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        confirmActions.addView(retryButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6) })
        confirmActions.addView(confirmButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(6) })
        card.addView(confirmActions, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) })

        return scroll
    }

    private fun ensurePermissionAndStart() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            beginSession()
        } else {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_AUDIO)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_AUDIO) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) beginSession()
            else showFatal("Нужен доступ к микрофону")
        }
    }

    private fun beginSession() {
        sessionActive = false
        parseStarted = false
        main.removeCallbacks(silenceWatchdog)
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null

        finalSegments.clear()
        currentPartial = ""
        sourceText = ""
        heardSpeech = false
        inSpeech = false
        lastSilenceAnchorMs = SystemClock.elapsedRealtime()
        draftRows.clear()

        reviewBox.removeAllViews()
        reviewBox.visibility = View.GONE
        retryButton.visibility = View.GONE
        confirmButton.visibility = View.GONE
        doneButton.visibility = View.VISIBLE
        cancelButton.visibility = View.VISIBLE
        doneButton.isEnabled = false
        progress.visibility = View.GONE
        transcript.text = ""
        transcript.visibility = View.GONE
        mic.visibility = View.VISIBLE
        status.text = "Слушаю…"
        status.setTextColor(Color.rgb(23, 32, 51))
        countdown.text = "После паузы жду 5 секунд"
        countdown.visibility = View.VISIBLE

        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            showFatal("На устройстве нет сервиса распознавания речи")
            return
        }

        sessionActive = true
        createRecognizer()
        startRecognizerSegment()
        main.post(silenceWatchdog)
    }

    private fun createRecognizer() {
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    if (!sessionActive) return
                    status.text = if (heardSpeech) "Продолжаю слушать…" else "Слушаю…"
                }

                override fun onBeginningOfSpeech() {
                    if (!sessionActive) return
                    inSpeech = true
                    heardSpeech = true
                    doneButton.isEnabled = true
                    status.text = "Говорите…"
                    countdown.text = "После паузы — ещё 5 секунд"
                }

                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit

                override fun onEndOfSpeech() {
                    if (!sessionActive) return
                    inSpeech = false
                    lastSilenceAnchorMs = SystemClock.elapsedRealtime()
                    status.text = "Пауза — я ещё слушаю"
                }

                override fun onError(error: Int) {
                    if (!sessionActive || parseStarted) return
                    inSpeech = false
                    when (error) {
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> showFatal("Нет доступа к микрофону")
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> showFatal("Ошибка сети при распознавании")
                        SpeechRecognizer.ERROR_SERVER -> restartRecognizerSoon(350)
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> restartRecognizerSoon(450)
                        SpeechRecognizer.ERROR_CLIENT -> restartRecognizerSoon(250, recreate = true)
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restartRecognizerSoon(120)
                        else -> restartRecognizerSoon(180)
                    }
                }

                override fun onResults(results: Bundle?) {
                    if (!sessionActive || parseStarted) return
                    val best = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().trim()
                    if (best.isNotBlank()) {
                        appendFinal(best)
                        heardSpeech = true
                        doneButton.isEnabled = true
                        lastSilenceAnchorMs = SystemClock.elapsedRealtime()
                    }
                    currentPartial = ""
                    inSpeech = false
                    renderTranscript()
                    status.text = "Пауза — я ещё слушаю"
                    restartRecognizerSoon(120)
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    if (!sessionActive || parseStarted) return
                    val part = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().trim()
                    if (part.isNotBlank()) {
                        currentPartial = part
                        heardSpeech = true
                        inSpeech = true
                        doneButton.isEnabled = true
                        renderTranscript()
                    }
                }

                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
        }
    }

    private fun startRecognizerSegment() {
        if (!sessionActive || parseStarted || isFinishing) return
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "ru-RU")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1000L)
        }
        runCatching { recognizer?.startListening(intent) }
            .onFailure { restartRecognizerSoon(300, recreate = true) }
    }

    private fun restartRecognizerSoon(delayMs: Long, recreate: Boolean = false) {
        if (!sessionActive || parseStarted) return
        main.postDelayed({
            if (!sessionActive || parseStarted || isFinishing) return@postDelayed
            if (recreate) createRecognizer()
            startRecognizerSegment()
        }, delayMs)
    }

    private val silenceWatchdog = object : Runnable {
        override fun run() {
            if (!sessionActive || parseStarted || isFinishing) return
            val now = SystemClock.elapsedRealtime()
            if (inSpeech) {
                countdown.text = "Слушаю речь…"
            } else {
                val elapsed = now - lastSilenceAnchorMs
                val remaining = (SILENCE_MS - elapsed).coerceAtLeast(0L)
                val sec = remaining / 1000.0
                countdown.text = if (heardSpeech) {
                    String.format(Locale.US, "Пауза: %.1f сек до отправки", sec)
                } else {
                    String.format(Locale.US, "Жду речь ещё %.1f сек", sec)
                }
                if (elapsed >= SILENCE_MS) {
                    if (heardSpeech && composedText().isNotBlank()) finishListeningAndParse(force = false)
                    else showNoSpeech()
                    return
                }
            }
            main.postDelayed(this, WATCHDOG_TICK_MS)
        }
    }

    private fun appendFinal(text: String) {
        val normalized = normalize(text)
        if (normalized.isBlank()) return
        val duplicate = finalSegments.any { normalize(it) == normalized }
        if (!duplicate) finalSegments += text.trim()
    }

    private fun composedText(): String {
        val pieces = finalSegments.toMutableList()
        val part = currentPartial.trim()
        if (part.isNotBlank() && pieces.none { normalize(it) == normalize(part) }) pieces += part
        return pieces.joinToString(" ").replace(Regex("\\s+"), " ").trim()
    }

    private fun renderTranscript() {
        val text = composedText()
        transcript.text = text
        transcript.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
    }

    private fun finishListeningAndParse(force: Boolean) {
        if (parseStarted) return
        val text = composedText()
        if (text.isBlank()) {
            if (force) showNoSpeech()
            return
        }
        parseStarted = true
        sessionActive = false
        main.removeCallbacks(silenceWatchdog)
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        sourceText = text

        mic.visibility = View.GONE
        doneButton.visibility = View.GONE
        cancelButton.visibility = View.GONE
        countdown.text = "Никодим разбирает сказанное…"
        status.text = "Обрабатываю"
        progress.visibility = View.VISIBLE

        io.execute {
            if (projects.isEmpty()) runCatching { ApiClient.loadProjects() }.onSuccess { projects = it }
            runCatching { ApiClient.parseVoice(text) }
                .onSuccess { result -> runOnUiThread { showReview(result) } }
                .onFailure { error -> runOnUiThread { showParseError(error.message ?: "Ошибка") } }
        }
    }

    private fun showReview(result: ParseResult) {
        progress.visibility = View.GONE
        countdown.visibility = View.GONE
        reviewBox.removeAllViews()
        draftRows.clear()

        if (result.drafts.isEmpty()) {
            status.text = "Не нашёл явной задачи"
            retryButton.visibility = View.VISIBLE
            confirmButton.visibility = View.GONE
            reviewBox.visibility = View.GONE
            return
        }

        status.text = if (result.drafts.size == 1) "Никодим понял так" else "Никодим нашёл ${result.drafts.size} задачи"
        reviewBox.visibility = View.VISIBLE
        result.drafts.forEachIndexed { index, draft ->
            val row = buildDraftRow(index, draft)
            draftRows += row
            reviewBox.addView(row.container)
        }
        retryButton.visibility = View.VISIBLE
        confirmButton.visibility = View.VISIBLE
        confirmButton.text = if (result.drafts.size == 1) "Создать задачу" else "Создать ${result.drafts.size} задачи"
    }

    private fun buildDraftRow(index: Int, draft: Draft): QuickDraftRow {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = roundedDrawable(Color.rgb(247, 249, 252), dp(13).toFloat())
        }
        if (index > 0) box.margin(top = dp(7))

        val check = CheckBox(this).apply {
            isChecked = true
            text = draft.description
            textSize = 15f
            setTextColor(Color.rgb(23, 32, 51))
            setTypeface(typeface, Typeface.BOLD)
        }
        box.addView(check)

        val meta = mutableListOf<String>()
        draft.projectTitle?.takeIf { it.isNotBlank() }?.let { meta += it }
        draft.deadline?.takeIf { it.isNotBlank() }?.let { meta += "срок $it" }
        draft.deadlineText?.takeIf { it.isNotBlank() && it != draft.deadline }?.let { meta += it }
        if (meta.isNotEmpty()) {
            box.addView(label(meta.joinToString(" · "), 12f, muted = true).apply { setPadding(dp(34), 0, 0, 0) })
        }
        return QuickDraftRow(box, check, draft)
    }

    private fun createSelectedDrafts() {
        val selected = draftRows.filter { it.check.isChecked }
        if (selected.isEmpty()) {
            status.text = "Выберите хотя бы одну задачу"
            return
        }
        confirmButton.isEnabled = false
        retryButton.isEnabled = false
        progress.visibility = View.VISIBLE
        status.text = "Создаю…"

        io.execute {
            runCatching {
                if (projects.isEmpty()) projects = ApiClient.loadProjects()
                selected.forEach { row ->
                    val projectId = matchProject(row.draft.projectTitle)?.id
                    ApiClient.createCommitment(row.draft, projectId, sourceText)
                }
            }.onSuccess {
                runOnUiThread {
                    progress.visibility = View.GONE
                    reviewBox.visibility = View.GONE
                    retryButton.visibility = View.GONE
                    confirmButton.visibility = View.GONE
                    status.setTextColor(Color.rgb(22, 128, 91))
                    status.text = if (selected.size == 1) "Задача создана" else "Создано задач: ${selected.size}"
                    countdown.visibility = View.VISIBLE
                    countdown.text = "Готово"
                    main.postDelayed({ if (!isFinishing) finish() }, 900)
                }
            }.onFailure { error ->
                runOnUiThread {
                    progress.visibility = View.GONE
                    confirmButton.isEnabled = true
                    retryButton.isEnabled = true
                    status.setTextColor(Color.rgb(184, 58, 50))
                    status.text = "Не удалось сохранить"
                    countdown.visibility = View.VISIBLE
                    countdown.text = error.message ?: "Ошибка сети"
                }
            }
        }
    }

    private fun matchProject(title: String?): Project? {
        val needle = normalize(title ?: return null)
        if (needle.isBlank()) return null
        return projects.firstOrNull { normalize(it.title) == needle }
            ?: projects.firstOrNull { normalize(it.title).contains(needle) || needle.contains(normalize(it.title)) }
    }

    private fun loadProjectsInBackground() {
        io.execute { runCatching { ApiClient.loadProjects() }.onSuccess { projects = it } }
    }

    private fun showNoSpeech() {
        sessionActive = false
        main.removeCallbacks(silenceWatchdog)
        recognizer?.cancel()
        status.text = "Не услышал речь"
        countdown.text = "Нажмите «Повторить»"
        progress.visibility = View.GONE
        doneButton.visibility = View.GONE
        cancelButton.visibility = View.GONE
        retryButton.visibility = View.VISIBLE
        retryButton.text = "Повторить"
        confirmButton.visibility = View.GONE
    }

    private fun showParseError(message: String) {
        progress.visibility = View.GONE
        status.setTextColor(Color.rgb(184, 58, 50))
        status.text = "Не удалось разобрать"
        countdown.visibility = View.VISIBLE
        countdown.text = message
        retryButton.visibility = View.VISIBLE
        confirmButton.visibility = View.GONE
    }

    private fun showFatal(message: String) {
        sessionActive = false
        parseStarted = false
        main.removeCallbacks(silenceWatchdog)
        recognizer?.cancel()
        progress.visibility = View.GONE
        status.setTextColor(Color.rgb(184, 58, 50))
        status.text = message
        countdown.text = "Закройте окно и попробуйте снова"
        doneButton.visibility = View.GONE
        retryButton.visibility = View.GONE
        confirmButton.visibility = View.GONE
    }

    private fun normalize(value: String): String = value
        .lowercase(Locale.ROOT)
        .replace('ё', 'е')
        .replace(Regex("[^a-zа-я0-9]+"), " ")
        .trim()

    private data class QuickDraftRow(
        val container: LinearLayout,
        val check: CheckBox,
        val draft: Draft
    )

    companion object {
        private const val REQUEST_AUDIO = 9201
        private const val SILENCE_MS = 5_000L
        private const val WATCHDOG_TICK_MS = 200L
    }
}
