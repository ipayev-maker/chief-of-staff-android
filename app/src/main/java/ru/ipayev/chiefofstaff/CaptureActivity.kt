package ru.ipayev.chiefofstaff

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Keeps existing launcher shortcuts working after the update. */
class CaptureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, QuickCaptureActivity::class.java))
        finish()
    }
}
