package ru.ipayev.chiefofstaff

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

object ApiClient {
    const val BASE_URL = "https://nikodim.vercel.app"
    class AccessRequired : IllegalStateException("Войдите через Google и введите PIN")
    class RequestError(val status: Int, val code: String, message: String) : IllegalStateException(message)

    private fun connection(method: String, path: String, timeout: Int = 30_000): HttpURLConnection {
        require(path.startsWith("/api/") && !path.contains(".."))
        return (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method; connectTimeout = 30_000; readTimeout = timeout; instanceFollowRedirects = false
            setRequestProperty("Origin", BASE_URL); setRequestProperty("Cookie", SecureSession.cookies())
            setRequestProperty("Accept", "application/json")
        }
    }
    private fun response(connection: HttpURLConnection): String {
        val status = connection.responseCode
        SecureSession.acceptCookies(connection.headerFields.filterKeys { it?.equals("Set-Cookie", true) == true }.values.flatten())
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        if (status == 401 || status == 423) throw AccessRequired()
        if (status !in 200..299) {
            val code = runCatching { JSONObject(text).optString("error") }.getOrDefault("")
            val message = when (code) {
                "pin_incorrect" -> "Неверный PIN"
                "pin_locked" -> "Слишком много попыток. Повторите позже."
                "pin_setup_required" -> "Сначала задайте PIN"
                "pin_already_configured" -> "PIN уже настроен. Откройте вход заново."
                "inbox_conflict" -> "Карточка уже изменилась. Обновите её перед сохранением."
                "source_archived", "source_archived_or_deleted" -> "Исходная заметка уже в архиве или удалена."
                "voice_too_large" -> "Запись слишком большая. Запишите более короткое сообщение."
                "mobile_capture_conflict" -> "Запись отличается от уже отправленной. Откройте сохранённую карточку."
                else -> "Не удалось выполнить запрос (HTTP $status)"
            }
            throw RequestError(status, code, message)
        }
        return text
    }
    private fun request(method: String, path: String, body: JSONObject? = null, timeout: Int = 30_000): JSONObject {
        val conn = connection(method, path, timeout)
        try {
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                conn.doOutput = true; conn.setRequestProperty("Content-Type", "application/json")
                conn.setFixedLengthStreamingMode(bytes.size); conn.outputStream.use { it.write(bytes) }
            }
            return JSONObject(response(conn))
        } finally { conn.disconnect() }
    }
    fun session() = request("GET", "/api/session")
    fun requireUnlocked() { val state = session(); if (!state.optBoolean("authenticated") || state.optBoolean("pinRequired", true)) throw AccessRequired() }
    fun unlock(pin: String, confirmation: String? = null) {
        val body = JSONObject().put("pin", pin); confirmation?.let { body.put("confirmation", it) }
        request("POST", if (confirmation == null) "/api/session/pin/unlock" else "/api/session/pin/setup", body)
        requireUnlocked()
    }
    fun lock() { request("POST", "/api/session/pin/lock", JSONObject()) }
    fun completeLogin(code: String) {
        require(code.matches(Regex("[A-Za-z0-9_-]{32,200}")))
        val verifier = SecureSession.verifier() ?: throw IllegalStateException("Вход истёк. Начните вход заново.")
        val conn = connection("GET", "/api/google-calendar/bridge-finish?code=$code")
        try {
            conn.setRequestProperty("Cookie", "__Host-cos-auth-transfer=$verifier")
            val status = conn.responseCode
            val cookies = conn.headerFields.filterKeys { it?.equals("Set-Cookie", true) == true }.values.flatten()
            if (status != 303 || cookies.none { it.startsWith("__Host-cos-calendar-session=") }) throw IllegalStateException("Вход не подтверждён. Повторите вход через Google.")
            SecureSession.acceptCookies(cookies); SecureSession.finishLogin()
        } finally { conn.disconnect() }
    }
    fun uploadVoice(draft: VoiceDraft, file: File): JSONObject {
        require(file.length() in 32..3L * 1024 * 1024) { "Запись пуста или слишком большая" }
        val conn = connection("POST", "/api/notes/mobile/voice", 150_000)
        try {
            conn.doOutput = true; conn.setRequestProperty("Content-Type", "audio/mp4")
            conn.setRequestProperty("X-Capture-ID", draft.id); conn.setRequestProperty("X-Audio-Seconds", draft.seconds.toString())
            conn.setRequestProperty("X-Recorded-At", draft.recordedAt)
            conn.setFixedLengthStreamingMode(file.length()); conn.outputStream.use { output -> file.inputStream().use { it.copyTo(output) } }
            return JSONObject(response(conn)).getJSONObject("item")
        } finally { conn.disconnect() }
    }
    fun inbox(id: String) = request("GET", "/api/notes/inbox/$id").getJSONObject("item")
    fun apply(id: String, body: JSONObject) = request("POST", "/api/notes/inbox/$id/apply", body, 60_000).getJSONObject("item")
    fun loadOpenTasks(limit: Int = 40): List<TaskSummary> {
        val conn = connection("GET", "/api/data/rest/v1/commitments?select=id,description,status,direction,deadline,project_id&status=in.(open,paused)&deleted_at=is.null&order=created_at.desc&limit=$limit")
        try {
            val array = JSONArray(response(conn))
            return List(array.length()) { index -> val row = array.getJSONObject(index)
                TaskSummary(row.getString("id"), row.getString("description"), row.optString("status", "open"), row.optString("direction", "internal"), row.optional("deadline"), row.optional("project_id")) }
        } finally { conn.disconnect() }
    }
    private fun JSONObject.optional(name: String) = if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }
}
