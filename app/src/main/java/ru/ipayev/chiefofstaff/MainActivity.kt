package ru.ipayev.chiefofstaff

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var taskList: LinearLayout
    private lateinit var stateText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContent())
        loadTasks()
    }

    override fun onResume() {
        super.onResume()
        if (::taskList.isInitialized) loadTasks()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun buildContent(): ScrollView {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.rgb(245, 247, 251))
            isFillViewport = true
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(28), dp(22), dp(40))
        }
        scroll.addView(root)

        root.addView(label("Chief of Staff", 30f).apply {
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        root.addView(label("Никодим · мобильный ввод", 15f, muted = true).apply { margin(top = dp(4)) })

        val mic = primaryButton("🎙  Диктовать задачу").apply {
            textSize = 18f
            minHeight = dp(64)
            setOnClickListener {
                startActivity(Intent(this@MainActivity, CaptureActivity::class.java).putExtra(CaptureActivity.EXTRA_AUTOSTART, true))
            }
        }
        root.addView(mic)
        mic.margin(top = dp(26), bottom = dp(8))

        root.addView(label("То же самое можно вынести на домашний экран как виджет «Никодим»: один тап сразу открывает диктовку.", 13f, muted = true))

        stateText = label("Загружаю задачи…", 13f, muted = true)
        root.addView(sectionTitle("Последние открытые задачи").apply { margin(top = dp(32), bottom = dp(10)) })
        root.addView(stateText)

        taskList = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        root.addView(taskList)

        root.addView(sectionTitle("Как работает голосовой ввод").apply { margin(top = dp(32), bottom = dp(10)) })
        val steps = listOf(
            "1. Нажать виджет или кнопку выше.",
            "2. Продиктовать одну или несколько задач обычной речью.",
            "3. Никодим разберёт задачи, проект, срок и контекст.",
            "4. Проверить черновики и нажать «Создать задачи»."
        )
        steps.forEach { text ->
            root.addView(label(text, 14f).apply {
                setPadding(0, dp(4), 0, dp(4))
            })
        }
        return scroll
    }

    private fun loadTasks() {
        stateText.text = "Загружаю задачи…"
        io.execute {
            runCatching { ApiClient.loadOpenTasks() }
                .onSuccess { tasks ->
                    runOnUiThread {
                        stateText.text = if (tasks.isEmpty()) "Открытых задач нет." else ""
                        taskList.removeAllViews()
                        tasks.forEach { task ->
                            val box = LinearLayout(this).apply {
                                orientation = LinearLayout.VERTICAL
                                setPadding(dp(14), dp(12), dp(14), dp(12))
                                background = roundedDrawable(Color.WHITE, dp(14).toFloat(), Color.rgb(215, 222, 232), dp(1))
                            }
                            box.addView(label(task.description, 15f).apply {
                                setTypeface(typeface, android.graphics.Typeface.BOLD)
                            })
                            val meta = buildString {
                                append(directionLabel(task.direction))
                                task.deadline?.let { append(" · срок $it") }
                            }
                            box.addView(label(meta, 12f, muted = true).apply { margin(top = dp(5)) })
                            taskList.addView(box)
                            box.margin(bottom = dp(8))
                        }
                    }
                }
                .onFailure { e ->
                    runOnUiThread {
                        stateText.text = "Не удалось загрузить задачи: ${e.message ?: "ошибка сети"}"
                    }
                }
        }
    }

    private fun directionLabel(direction: String): String = when (direction) {
        "from_me" -> "Мне сделать"
        "to_me" -> "Жду от другого"
        else -> "Моя задача"
    }
}
