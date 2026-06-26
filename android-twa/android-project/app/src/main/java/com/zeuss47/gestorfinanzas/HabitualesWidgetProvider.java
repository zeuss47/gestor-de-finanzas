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

    private static final String TAG      = "HabitualesWidget";
    private static final String BASE_URL = "https://zeuss47.github.io/gestor-de-finanzas/";

    private static final int COLOR_OK      = 0xFF10B981;  // verde esmeralda
    private static final int COLOR_PENDING = 0xFF8892A4;  // gris

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        // Mostrar cache inmediatamente
        for (int id : appWidgetIds) {
            try { updateWidget(context, appWidgetManager, id); }
            catch (Exception e) { Log.e(TAG, "updateWidget error id=" + id, e); }
        }
        // Refrescar en segundo plano
        WidgetCache.fetch(context, () -> {
            for (int id : appWidgetIds) {
                try { updateWidget(context, appWidgetManager, id); }
                catch (Exception e) { Log.e(TAG, "post-fetch error id=" + id, e); }
            }
        });
    }

    static void updateWidget(Context context, AppWidgetManager appWidgetManager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_habituales);

        views.setOnClickPendingIntent(R.id.wh_btn_ver,
                buildIntent(context, BASE_URL + "?action=habituales", 3001));
        views.setOnClickPendingIntent(R.id.wh_btn_aprobar,
                buildIntent(context, BASE_URL + "?action=aprobar-habituales", 3002));

        String[] names    = WidgetCache.getHabitualesNames(context);
        String[] statuses = WidgetCache.getHabitualesStatus(context);

        int[] nameIds   = { R.id.wh_r1_name,   R.id.wh_r2_name,   R.id.wh_r3_name   };
        int[] statusIds = { R.id.wh_r1_status, R.id.wh_r2_status, R.id.wh_r3_status };

        for (int i = 0; i < nameIds.length; i++) {
            if (i < names.length) {
                String st = i < statuses.length ? statuses[i] : "";
                boolean ok = "OK".equals(st);
                views.setTextViewText(nameIds[i], names[i]);
                views.setTextViewText(statusIds[i], ok ? "OK" : "pend.");
                views.setTextColor(nameIds[i],   ok ? COLOR_OK : COLOR_PENDING);
                views.setTextColor(statusIds[i], ok ? COLOR_OK : COLOR_PENDING);
            } else {
                views.setTextViewText(nameIds[i],   i == 0 && names.length == 0 ? "Sincroniza la app para ver datos" : "");
                views.setTextViewText(statusIds[i], "");
            }
        }

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
