package ru.ipayev.chiefofstaff

import android.app.Application

class NikodimApplication : Application() {
    override fun onCreate() { super.onCreate(); SecureSession.initialize(this) }
}
