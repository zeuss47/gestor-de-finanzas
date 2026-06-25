package com.zeuss47.gestorfinanzas;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.widget.RemoteViews;

public class HabitualesWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "HabitualesWidget";
    private static final String BASE_URL = "https://zeuss47.github.io/gestor-de-finanzas/";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int widgetId : appWidgetIds) {
            try {
                updateWidget(context, appWidgetManager, widgetId);
            } catch (Exception e) {
                Log.e(TAG, "Error actualizando widget id=" + widgetId, e);
            }
        }
    }

    static void updateWidget(Context context, AppWidgetManager appWidgetManager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_habituales);

        // "Ver habituales" -> abre la app en el widget de habituales (home tab, scroll)
        PendingIntent piVer = buildIntent(context, BASE_URL + "?action=habituales", 3001);
        views.setOnClickPendingIntent(R.id.wh_btn_ver, piVer);

        // "Aprobar mes" -> abre la app y aprueba automaticamente todos los habituales del mes
        PendingIntent piAprobar = buildIntent(context, BASE_URL + "?action=aprobar-habituales", 3002);
        views.setOnClickPendingIntent(R.id.wh_btn_aprobar, piAprobar);

        appWidgetManager.updateAppWidget(widgetId, views);
    }

    private static PendingIntent buildIntent(Context context, String url, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setClass(context, LauncherActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(context, requestCode, intent, flags);
    }
}
