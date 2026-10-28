package ru.ipayev.chiefofstaff

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import kotlin.math.sqrt

/** Live microphone amplitude, never an invented waveform. Animation ends with recording. */
class RecordingWaveView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(28, 28, 26) }
    private val levels = FloatArray(11)
    private val displayed = FloatArray(11)
    private var pulse: ValueAnimator? = null
    private var phase = 0f
    private var recording = false

    init { contentDescription = "Идёт запись. Уровень звука микрофона" }

    fun setAmplitude(amplitude: Int) {
        if (!recording) return
        for (i in 0 until levels.lastIndex) levels[i] = levels[i + 1]
        levels[levels.lastIndex] = sqrt(amplitude.coerceIn(0, 32767) / 32767f)
        if (!ValueAnimator.areAnimatorsEnabled()) levels.copyInto(displayed)
        invalidate()
    }

    fun setRecording(value: Boolean) {
        recording = value
        if (!value) { levels.fill(0f); displayed.fill(0f) }
        updateAnimation()
    }

    private fun updateAnimation() {
        pulse?.cancel(); pulse = null; phase = 0f
        if (recording && isAttachedToWindow && windowVisibility == VISIBLE && ValueAnimator.areAnimatorsEnabled()) {
            pulse = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1400; repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.REVERSE
                interpolator = AccelerateDecelerateInterpolator()
                addUpdateListener {
                    phase = it.animatedValue as Float
                    for (i in displayed.indices) displayed[i] += (levels[i] - displayed[i]) * 0.3f
                    invalidate()
                }
                start()
            }
        }
        invalidate()
    }

    override fun onAttachedToWindow() { super.onAttachedToWindow(); updateAnimation() }
    override fun onDetachedFromWindow() { pulse?.cancel(); pulse = null; super.onDetachedFromWindow() }
    override fun onWindowVisibilityChanged(visibility: Int) { super.onWindowVisibilityChanged(visibility); updateAnimation() }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val density = resources.displayMetrics.density
        val spacing = minOf(8f * density, width / 15f)
        val barWidth = minOf(4f * density, spacing * 0.55f)
        val left = (width - (levels.size - 1) * spacing) / 2f
        paint.alpha = if (recording && ValueAnimator.areAnimatorsEnabled()) (205 + 50 * phase).toInt() else 255
        for (i in levels.indices) {
            val level = if (pulse == null) levels[i] else displayed[i]
            val barHeight = 4f * density + level * minOf(32f * density, height * 0.55f)
            val x = left + spacing * i
            canvas.drawRoundRect(x - barWidth / 2, (height - barHeight) / 2, x + barWidth / 2, (height + barHeight) / 2, barWidth / 2, barWidth / 2, paint)
        }
    }
}
