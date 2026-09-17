package ru.ipayev.chiefofstaff

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

fun roundedDrawable(
    color: Int,
    radiusDp: Float,
    strokeColor: Int? = null,
    strokeWidthPx: Int = 1
): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radiusDp
    if (strokeColor != null) setStroke(strokeWidthPx, strokeColor)
}

fun Context.primaryButton(text: String): Button = Button(this).apply {
    this.text = text
    textSize = 16f
    isAllCaps = false
    setTextColor(Color.WHITE)
    background = roundedDrawable(Color.rgb(53, 104, 232), dp(16).toFloat())
    setPadding(dp(18), dp(12), dp(18), dp(12))
    minHeight = dp(52)
}

fun Context.secondaryButton(text: String): Button = Button(this).apply {
    this.text = text
    textSize = 15f
    isAllCaps = false
    setTextColor(Color.rgb(23, 32, 51))
    background = roundedDrawable(Color.WHITE, dp(14).toFloat(), Color.rgb(215, 222, 232), dp(1))
    setPadding(dp(16), dp(10), dp(16), dp(10))
    minHeight = dp(48)
}

fun Context.label(text: String, sizeSp: Float = 14f, muted: Boolean = false): TextView = TextView(this).apply {
    this.text = text
    textSize = sizeSp
    setTextColor(if (muted) Color.rgb(102, 112, 133) else Color.rgb(23, 32, 51))
}

fun View.margin(top: Int = 0, bottom: Int = 0, start: Int = 0, end: Int = 0) {
    val lp = (layoutParams as? LinearLayout.LayoutParams) ?: LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    )
    lp.setMargins(start, top, end, bottom)
    layoutParams = lp
}

fun Context.sectionTitle(text: String): TextView = label(text, 13f, muted = true).apply {
    setTypeface(typeface, Typeface.BOLD)
    gravity = Gravity.START
    letterSpacing = 0.04f
}
