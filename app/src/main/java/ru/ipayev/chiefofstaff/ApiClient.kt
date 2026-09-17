package ru.ipayev.chiefofstaff

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

object ApiClient {
    private const val BASE_URL = "https://spabmyyxiufuzsaydrmx.supabase.co"
    private const val API_KEY = "sb_publishable_CNZsixovw_VFqkJNusVKFw_EErlVgMI"

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        prefer: String? = null,
        timeoutMs: Int = 30_000
    ): String {
        val connection = (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("apikey", API_KEY)
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            if (prefer != null) setRequestProperty("Prefer", prefer)
        }

        if (body != null) {
            connection.outputStream.use { out ->
                out.write(body.toString().toByteArray(Charsets.UTF_8))
            }
        }

        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val text = if (stream != null) {
            BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
        } else ""

        if (code !in 200..299) {
            throw IllegalStateException("HTTP $code: ${text.take(500)}")
        }
        return text
    }

    fun parseVoice(text: String): ParseResult {
        val payload = JSONObject().put("text", text)
        val raw = request(
            method = "POST",
            path = "/functions/v1/cos-capture-chat",
            body = payload,
            timeoutMs = 90_000
        )
        val root = JSONObject(raw)
        if (root.has("error")) throw IllegalStateException(root.optString("error"))

        val draftsJson = root.optJSONArray("drafts") ?: JSONArray()
        val drafts = buildList {
            for (i in 0 until draftsJson.length()) {
                val d = draftsJson.getJSONObject(i)
                val warningsJson = d.optJSONArray("warnings") ?: JSONArray()
                val warnings = buildList {
                    for (j in 0 until warningsJson.length()) add(warningsJson.optString(j))
                }
                add(
                    Draft(
                        description = d.optString("description"),
                        direction = d.optString("direction", "internal"),
                        areaKey = d.optNullableString("area_key"),
                        projectTitle = d.optNullableString("project_title"),
                        who = d.optNullableString("who"),
                        deadline = d.optNullableString("deadline"),
                        plannedOn = d.optNullableString("planned_on"),
                        nextCheckOn = d.optNullableString("next_check_on"),
                        deadlineText = d.optNullableString("deadline_text"),
                        warnings = warnings
                    )
                )
            }
        }
        return ParseResult(
            drafts = drafts,
            today = root.optNullableString("today"),
            timeZone = root.optNullableString("time_zone")
        )
    }

    fun loadProjects(): List<Project> {
        val raw = request(
            "GET",
            "/rest/v1/projects?select=id,title,area_key,status&status=eq.active&order=title.asc"
        )
        val arr = JSONArray(raw)
        return buildList {
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                add(Project(o.getString("id"), o.getString("title"), o.optNullableString("area_key")))
            }
        }
    }

    fun loadOpenTasks(limit: Int = 12): List<TaskSummary> {
        val raw = request(
            "GET",
            "/rest/v1/commitments?select=id,description,status,direction,deadline,project_id&status=in.(open,paused)&order=created_at.desc&limit=$limit"
        )
        val arr = JSONArray(raw)
        return buildList {
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                add(
                    TaskSummary(
                        id = o.getString("id"),
                        description = o.getString("description"),
                        status = o.optString("status", "open"),
                        direction = o.optString("direction", "internal"),
                        deadline = o.optNullableString("deadline"),
                        projectId = o.optNullableString("project_id")
                    )
                )
            }
        }
    }

    fun createCommitment(draft: Draft, projectId: String?, sourceText: String) {
        val body = JSONObject()
            .put("description", draft.description.trim())
            .put("direction", draft.direction.ifBlank { "internal" })
            .put("status", "open")
            .put("project_id", projectId ?: JSONObject.NULL)
            .put("area_key", draft.areaKey ?: JSONObject.NULL)
            .put("deadline", draft.deadline ?: JSONObject.NULL)
            .put("planned_on", draft.plannedOn ?: JSONObject.NULL)
            .put("next_check_on", draft.nextCheckOn ?: JSONObject.NULL)
            .put(
                "cos_creation_input",
                JSONObject()
                    .put("source", "android_voice")
                    .put("source_text", sourceText)
                    .put("who", draft.who ?: JSONObject.NULL)
                    .put("project_title", draft.projectTitle ?: JSONObject.NULL)
                    .put("deadline_text", draft.deadlineText ?: JSONObject.NULL)
            )

        request(
            method = "POST",
            path = "/rest/v1/commitments",
            body = body,
            prefer = "return=minimal"
        )
    }

    private fun JSONObject.optNullableString(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return optString(name).takeIf { it.isNotBlank() && it != "null" }
    }
}
