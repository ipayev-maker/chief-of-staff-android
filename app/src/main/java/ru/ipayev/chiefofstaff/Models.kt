package ru.ipayev.chiefofstaff

data class Project(
    val id: String,
    val title: String,
    val areaKey: String? = null
)

data class Draft(
    var description: String,
    val direction: String,
    val areaKey: String?,
    val projectTitle: String?,
    val who: String?,
    val deadline: String?,
    val plannedOn: String?,
    val nextCheckOn: String?,
    val deadlineText: String?,
    val warnings: List<String> = emptyList()
)

data class ParseResult(
    val drafts: List<Draft>,
    val today: String?,
    val timeZone: String?
)

data class TaskSummary(
    val id: String,
    val description: String,
    val status: String,
    val direction: String,
    val deadline: String?,
    val projectId: String?
)
