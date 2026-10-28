package ru.ipayev.chiefofstaff

import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.os.Bundle

/** Only forwards the one-use code. LoginActivity checks the local PKCE verifier. */
class AuthRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        if (uri?.scheme == "ru.ipayev.chiefofstaff" && uri.host == "auth" && (uri.path.isNullOrEmpty() || uri.path == "/")) {
            val callback = Intent(this, LoginActivity::class.java).setData(uri)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            // Return to the login that started this PKCE exchange, including
            // a widget's separate capture task. Never take a task ID from a link.
            val delivered = runCatching {
                val taskId = SecureSession.loginTaskId()
                @Suppress("DEPRECATION")
                val task = (getSystemService(ACTIVITY_SERVICE) as ActivityManager).appTasks.firstOrNull { taskId != null && it.taskInfo.id == taskId }
                if (task != null) { task.startActivity(this, callback, null); true } else false
            }.getOrDefault(false)
            if (!delivered) startActivity(callback)
        }
        finish()
    }
}
