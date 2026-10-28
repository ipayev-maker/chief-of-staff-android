package ru.ipayev.chiefofstaff

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.widget.RemoteViews

class NikodimWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        appWidgetIds.forEach { appWidgetId ->
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
        updateWidget(context, appWidgetManager, appWidgetId)
    }

    private fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val intent = Intent(context, QuickCaptureActivity::class.java).apply {
                action = ACTION_WIDGET_CAPTURE
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                context,
                appWidgetId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            fun layout(resource: Int) = RemoteViews(context.packageName, resource).apply {
                setOnClickPendingIntent(R.id.widget_root, pendingIntent)
            }
            val views = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                RemoteViews(mapOf(
                    SizeF(40f, 40f) to layout(R.layout.widget_nikodim),
                    SizeF(140f, 52f) to layout(R.layout.widget_nikodim_wide)
                ))
            } else {
                val options = appWidgetManager.getAppWidgetOptions(appWidgetId)
                val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
                val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
                layout(if (width >= 140 && height >= 52) R.layout.widget_nikodim_wide else R.layout.widget_nikodim)
            }
            appWidgetManager.updateAppWidget(appWidgetId, views)
    }

    companion object {
        private const val ACTION_WIDGET_CAPTURE = "ru.ipayev.chiefofstaff.WIDGET_CAPTURE"
    }
}
