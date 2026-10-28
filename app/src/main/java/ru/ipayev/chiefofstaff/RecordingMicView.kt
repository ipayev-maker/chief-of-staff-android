package ru.ipayev.chiefofstaff

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator

/** A quiet recording indicator. No animation survives detachment or stopping. */
class RecordingMicView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val microphone = context.getDrawable(R.drawable.ic_widget_mic)!!.mutate()
    private var pulse: ValueAnimator? = null
    private var phase = 0f
    private var recording = false

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    fun setRecording(value: Boolean) {
        recording = value
        updateAnimation()
    }

    private fun updateAnimation() {
        pulse?.cancel(); pulse = null; phase = 0f
        if (recording && isAttachedToWindow && windowVisibility == VISIBLE && ValueAnimator.areAnimatorsEnabled()) {
            pulse = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1400
                repeatCount = ValueAnimator.INFINITE
                repeatMode = ValueAnimator.REVERSE
                interpolator = AccelerateDecelerateInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; invalidate() }
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
        val cx = width / 2f; val cy = height / 2f; val size = minOf(width, height).toFloat()
        paint.color = Color.argb((20 + phase * 13).toInt(), 53, 104, 232)
        canvas.drawCircle(cx, cy, size * (0.43f + phase * 0.065f), paint)
        paint.color = Color.argb((28 + phase * 16).toInt(), 53, 104, 232)
        canvas.drawCircle(cx, cy, size * (0.37f + phase * 0.035f), paint)
        paint.color = Color.rgb(53, 104, 232)
        canvas.drawCircle(cx, cy, size * 0.32f, paint)
        val half = (size * 0.15f).toInt()
        microphone.setBounds(cx.toInt() - half, cy.toInt() - half, cx.toInt() + half, cy.toInt() + half)
        microphone.alpha = (210 + phase * 45).toInt()
        microphone.draw(canvas)
    }
}
