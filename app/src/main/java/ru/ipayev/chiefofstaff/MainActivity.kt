package ru.ipayev.chiefofstaff

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var taskList: LinearLayout
    private lateinit var stateText: TextView
    private var loading = false
    private var askingLogin = false
    private var cancelledLogin = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(28), dp(22), dp(32)) }
        setContentView(ScrollView(this).apply { isFillViewport = true; setBackgroundColor(Color.rgb(245, 247, 251)); addView(root) })
        applySystemInsets(root)
        root.addView(label("Никодим", 26f))
        root.addView(label("Версия 0.4.0 · голосовой ввод", 14f, muted = true).apply { margin(top = dp(4), bottom = dp(22)) })
        root.addView(primaryButton("Записать сообщение").apply { setOnClickListener { startActivity(Intent(this@MainActivity, QuickCaptureActivity::class.java)) } })
        root.addView(label("Задачи, встречи и заметки из голоса. Виджет на рабочем столе открывает запись одним нажатием.", 15f, muted = true).apply { margin(top = dp(12), bottom = dp(22)) })
        root.addView(sectionTitle("Последние открытые задачи"))
        stateText = label("", 15f, muted = true); root.addView(stateText)
        root.addView(secondaryButton("Обновить / войти").apply { setOnClickListener { cancelledLogin = false; loadTasks() }; margin(top = dp(12), bottom = dp(14)) })
        taskList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; root.addView(taskList)
        root.addView(secondaryButton("Открыть дашборд").apply { setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ApiClient.BASE_URL))) }; margin(top = dp(22)) })
        root.addView(secondaryButton("Заблокировать приложение").apply { setOnClickListener { lock() }; margin(top = dp(10)) })
    }
    override fun onResume() { super.onResume(); if (!askingLogin && !cancelledLogin) loadTasks() }
    override fun onDestroy() { io.shutdown(); super.onDestroy() }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) { askingLogin = false; cancelledLogin = resultCode != RESULT_OK; if (cancelledLogin) stateText.text = "Для просмотра задач войдите через Google и введите PIN." }
    }
    private fun loadTasks() {
        if (loading || askingLogin) return; loading = true; stateText.text = "Загружаю…"
        io.execute {
            val result = runCatching { ApiClient.loadOpenTasks() }
            runOnUiThread {
                loading = false; if (isFinishing || isDestroyed) return@runOnUiThread
                taskList.removeAllViews()
                result.onSuccess { tasks ->
                    stateText.text = if (tasks.isEmpty()) "Открытых задач нет." else ""
                    tasks.forEach { task ->
                        taskList.addView(label(task.description, 17f).apply { setPadding(0, dp(12), 0, dp(6)) })
                        task.deadline?.let { taskList.addView(label("Срок: $it", 14f, muted = true)) }
                    }
                }.onFailure { error ->
                    if (error is ApiClient.AccessRequired) { askingLogin = true; startActivityForResult(Intent(this, LoginActivity::class.java), 10) }
                    else stateText.text = error.message ?: "Не удалось загрузить задачи."
                }
            }
        }
    }
    private fun lock() {
        if (loading) return
        loading = true; taskList.removeAllViews(); cancelledLogin = true
        io.execute {
            runCatching { ApiClient.lock() }
            // Remove local access even if the server is temporarily unreachable.
            SecureSession.clearPin()
            runOnUiThread { loading = false; if (!isDestroyed) stateText.text = "Приложение заблокировано. Для входа нажмите «Обновить / войти»." }
        }
    }
}
