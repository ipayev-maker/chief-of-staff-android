package ru.ipayev.chiefofstaff

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

object ApiClient {
    private const val BASE_URL = "https://spabmyyxiufuzsaydrmx.supabase.co"
    private const val API_KEY = "sb_publishable_CNZsixovw_VFqJNusVKFw_EErlVgMI"

    private fun request(method: String, path: String, body: JSONObject? = null, prefer: String? = null, timeoutMs: Int = 30_000): String {
        val connection = (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("apikey", API_KEY)
            setRequestProperty("Accept", "application/json")
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json; charset=utf-8") }
            if (prefer != null) setRequestProperty("Prefer", prefer)
        }
        if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val responseText = if (stream != null) BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() } else ""
        if (code !in 200..299) throw IllegalStateException("HTTP $code: ${responseText.take(500)}")
        return responseText
    }

    fun parseVoice(text: String, context: JSONObject? = null): ParseResult {
        val payload = JSONObject().put("text", text)
        if (context != null) payload.put("context", context)
        val raw = request("POST", "/functions/v1/cos-capture-chat", payload, timeoutMs = 90_000)
        val root = JSONObject(raw)
        if (root.has("error")) throw IllegalStateException(root.optString("error"))
        val draftsJson = root.optJSONArray("drafts") ?: JSONArray()
        val drafts = buildList {
            for (i in 0 until draftsJson.length()) {
                val d = draftsJson.getJSONObject(i)
                val warningsJson = d.optJSONArray("warnings") ?: JSONArray()
                val warnings = buildList { for (j in 0 until warningsJson.length()) add(warningsJson.optString(j)) }
                val relationsJson = d.optJSONArray("relations") ?: JSONArray()
                val relations = buildList {
                    for (j in 0 until relationsJson.length()) {
                        val x = relationsJson.getJSONObject(j)
                        add(RelationProposal(x.optNullableString("target_task_id"), x.optNullableString("target_task_description"), x.optString("link_type", "related")))
                    }
                }
                add(Draft(
                    description=d.optString("description"), direction=d.optString("direction","internal"),
                    areaKey=d.optNullableString("area_key"), projectTitle=d.optNullableString("project_title"),
                    who=d.optNullableString("who"), deadline=d.optNullableString("deadline"),
                    plannedOn=d.optNullableString("planned_on"), nextCheckOn=d.optNullableString("next_check_on"),
                    deadlineText=d.optNullableString("deadline_text"), relations=relations, warnings=warnings
                ))
            }
        }
        return ParseResult(drafts, root.optNullableString("today"), root.optNullableString("time_zone"))
    }

    fun loadProjects(): List<Project> {
        val raw=request("GET","/rest/v1/projects?select=id,title,area_key,status&status=eq.active&order=title.asc"); val arr=JSONArray(raw)
        return buildList { for(i in 0 until arr.length()){val o=arr.getJSONObject(i);add(Project(o.getString("id"),o.getString("title"),o.optNullableString("area_key"))) } }
    }

    fun loadParticipants(): List<Participant> {
        val raw=request("GET","/rest/v1/participants?select=id,name&order=name.asc"); val arr=JSONArray(raw)
        return buildList { for(i in 0 until arr.length()){val o=arr.getJSONObject(i);add(Participant(o.getString("id"),o.getString("name"))) } }
    }

    fun loadOpenTasks(limit:Int=40):List<TaskSummary>{
        val raw=request("GET","/rest/v1/commitments?select=id,description,status,direction,deadline,project_id&status=in.(open,paused)&order=created_at.desc&limit=$limit"); val arr=JSONArray(raw)
        return buildList { for(i in 0 until arr.length()){val o=arr.getJSONObject(i);add(TaskSummary(o.getString("id"),o.getString("description"),o.optString("status","open"),o.optString("direction","internal"),o.optNullableString("deadline"),o.optNullableString("project_id"))) } }
    }

    fun createCommitment(draft:Draft,projectId:String?,participantId:String?,sourceText:String):String{
        val body=JSONObject().put("description",draft.description.trim()).put("direction",draft.direction.ifBlank{"internal"}).put("status","open")
            .put("project_id",projectId?:JSONObject.NULL).put("area_key",draft.areaKey?:JSONObject.NULL).put("deadline",draft.deadline?:JSONObject.NULL)
            .put("planned_on",draft.plannedOn?:JSONObject.NULL).put("next_check_on",draft.nextCheckOn?:JSONObject.NULL).put("participant_id",participantId?:JSONObject.NULL)
            .put("cos_creation_input",JSONObject().put("source","android_voice").put("source_text",sourceText).put("who",draft.who?:JSONObject.NULL).put("project_title",draft.projectTitle?:JSONObject.NULL).put("deadline_text",draft.deadlineText?:JSONObject.NULL))
        val raw=request("POST","/rest/v1/commitments",body,prefer="return=representation")
        return JSONArray(raw).getJSONObject(0).getString("id")
    }

    fun createLink(projectId:String?,sourceTaskId:String,targetTaskId:String,linkType:String){
        if(projectId.isNullOrBlank()||sourceTaskId==targetTaskId)return
        val safe=if(linkType in setOf("blocks","depends_on","related","parent","duplicate"))linkType else "related"
        val body=JSONObject().put("project_id",projectId).put("source_commitment_id",sourceTaskId).put("target_commitment_id",targetTaskId).put("link_type",safe)
        request("POST","/rest/v1/commitment_links",body,prefer="return=minimal")
    }

    private fun JSONObject.optNullableString(name:String):String?=if(!has(name)||isNull(name))null else optString(name).takeIf{it.isNotBlank()&&it!="null"}
}
