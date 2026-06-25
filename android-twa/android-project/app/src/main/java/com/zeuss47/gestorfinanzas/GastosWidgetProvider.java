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

public class GastosWidgetProvider extends AppWidgetProvider {

    private static final String TAG      = "GastosWidget";
    private static final String BASE_URL = "https://zeuss47.github.io/gestor-de-finanzas/";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        // Mostrar datos en caché de inmediato
        for (int id : appWidgetIds) {
            try { updateWidget(context, appWidgetManager, id); }
            catch (Exception e) { Log.e(TAG, "updateWidget error id=" + id, e); }
        }
        // Obtener datos frescos en segundo plano
        WidgetCache.fetch(context, () -> {
            for (int id : appWidgetIds) {
                try { updateWidget(context, appWidgetManager, id); }
                catch (Exception e) { Log.e(TAG, "post-fetch error id=" + id, e); }
            }
        });
    }

    static void updateWidget(Context context, AppWidgetManager appWidgetManager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_gastos);

        // Botones de acción
        views.setOnClickPendingIntent(R.id.wg_btn_historial,
                buildIntent(context, BASE_URL + "?action=historial", 1001));
        views.setOnClickPendingIntent(R.id.wg_btn_nuevo,
                buildIntent(context, BASE_URL + "?action=new-gasto", 1002));

        // Datos del caché
        String[] descs = WidgetCache.getGastosDesc(context);
        String[] amts  = WidgetCache.getGastosAmt(context);

        int[] descIds = { R.id.wg_r1_desc, R.id.wg_r2_desc, R.id.wg_r3_desc };
        int[] amtIds  = { R.id.wg_r1_amt,  R.id.wg_r2_amt,  R.id.wg_r3_amt  };

        for (int i = 0; i < descIds.length; i++) {
            if (i < descs.length) {
                views.setTextViewText(descIds[i], descs[i]);
                views.setTextViewText(amtIds[i], i < amts.length ? amts[i] : "");
            } else {
                views.setTextViewText(descIds[i], i == 0 && descs.length == 0 ? "Sincroniza la app para ver datos" : "");
                views.setTextViewText(amtIds[i], "");
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
