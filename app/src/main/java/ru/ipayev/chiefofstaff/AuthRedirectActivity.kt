package ru.ipayev.chiefofstaff

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Only forwards the one-use code. LoginActivity checks the local PKCE verifier. */
class AuthRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        if (uri?.scheme == "ru.ipayev.chiefofstaff" && uri.host == "auth" && (uri.path.isNullOrEmpty() || uri.path == "/")) {
            startActivity(Intent(this, LoginActivity::class.java).setData(uri)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
        finish()
    }
}
