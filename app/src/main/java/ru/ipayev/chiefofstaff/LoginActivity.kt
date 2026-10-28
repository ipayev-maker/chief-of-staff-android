package ru.ipayev.chiefofstaff

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.util.Base64
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors

class LoginActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(40), dp(24), dp(32)) }
        setContentView(ScrollView(this).apply { setBackgroundColor(Color.WHITE); addView(root) })
        applySystemInsets(root)
        if (intent.data != null) complete(intent.data!!) else checkSession()
    }
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent); setIntent(intent)
        intent?.data?.let { complete(it) }
    }
    override fun onDestroy() { io.shutdownNow(); super.onDestroy() }
    private fun base(title: String) {
        root.removeAllViews(); root.addView(label(title, 24f))
        status = label("", 15f, muted = true)
        root.addView(status); status.margin(top = dp(14), bottom = dp(18))
    }
    private fun checkSession() {
        base("Вход в Никодим"); status.text = "Проверяю вход…"
        runIo({ ApiClient.session() }) { state ->
            if (!state.optBoolean("authenticated")) googleLogin()
            else if (state.optBoolean("pinRequired", true)) pinLogin(state.optBoolean("pinSetupRequired"))
            else done()
        }
    }
    private fun googleLogin() {
        base("Вход через Google")
        status.text = "Войдите в аккаунт владельца. После входа приложение запросит ваш PIN."
        root.addView(primaryButton("Войти через Google").apply {
            setOnClickListener {
                runCatching {
                    val bytes = ByteArray(48).also { SecureRandom().nextBytes(it) }
                    val verifier = Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)
                    val challenge = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
                    SecureSession.begin(verifier)
                    val url = Uri.parse("https://chief-of-staff-v3-live.vercel.app/api/google-calendar/bridge-start").buildUpon()
                        .appendQueryParameter("challenge", challenge).appendQueryParameter("time_zone", "Europe/Moscow").appendQueryParameter("return_to", "/android").build()
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    status.text = "Завершите вход в браузере и вернитесь в приложение."
                }.onFailure { status.text = "Не удалось открыть браузер. Попробуйте ещё раз." }
            }
        })
        root.addView(secondaryButton("Отмена").apply { setOnClickListener { finish() }; margin(top = dp(12)) })
    }
    private fun complete(uri: Uri) {
        val code = uri.getQueryParameter("code")
        if (uri.scheme != "ru.ipayev.chiefofstaff" || uri.host != "auth" || code == null || !code.matches(Regex("[A-Za-z0-9_-]{32,200}")) || SecureSession.verifier() == null) { googleLogin(); return }
        base("Завершаю вход"); status.text = "Проверяю подтверждение Google…"
        runIo({ ApiClient.completeLogin(code); ApiClient.session() }) { state ->
            if (state.optBoolean("authenticated")) pinLogin(state.optBoolean("pinSetupRequired")) else googleLogin()
        }
    }
    private fun pinLogin(setup: Boolean) {
        base(if (setup) "Задайте PIN" else "Введите PIN")
        status.text = if (setup) "Четыре цифры для входа в приложение и дашборд." else "Тот же четырёхзначный PIN, что и в дашборде."
        fun field(hintText: String) = EditText(this).apply {
            hint = hintText; textSize = 24f; inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(InputFilter.LengthFilter(4)); isSaveEnabled = false
            importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        val pin = field("PIN"); root.addView(pin)
        val confirmation = if (setup) field("Повторите PIN").also { root.addView(it) } else null
        val button = primaryButton(if (setup) "Сохранить PIN" else "Войти")
        root.addView(button); button.margin(top = dp(18))
        button.setOnClickListener {
            if (busy) return@setOnClickListener
            val value = pin.text.toString(); val repeated = confirmation?.text?.toString()
            if (!value.matches(Regex("[0-9]{4}")) || setup && repeated != value) { status.text = if (setup) "Введите одинаковый четырёхзначный PIN в обоих полях." else "Введите четыре цифры."; return@setOnClickListener }
            pin.text.clear(); confirmation?.text?.clear(); status.text = "Проверяю…"
            runIo({ ApiClient.unlock(value, repeated) }) { done() }
        }
        root.addView(secondaryButton("Отмена").apply { setOnClickListener { finish() }; margin(top = dp(12)) })
    }
    private fun done() { setResult(RESULT_OK); finish() }
    private fun <T> runIo(work: () -> T, success: (T) -> Unit) {
        if (busy) return; busy = true
        io.execute {
            val result = runCatching(work)
            runOnUiThread {
                busy = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.onSuccess(success).onFailure { error ->
                    if (error is ApiClient.AccessRequired) googleLogin()
                    else { status.text = error.message ?: "Нет связи. Попробуйте ещё раз."; if (root.childCount <= 2) root.addView(secondaryButton("Повторить вход").apply { setOnClickListener { checkSession() } }) }
                }
            }
        }
    }
}
