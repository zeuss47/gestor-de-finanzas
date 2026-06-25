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

public class ProductosWidgetProvider extends AppWidgetProvider {

    private static final String TAG      = "ProductosWidget";
    private static final String BASE_URL = "https://zeuss47.github.io/gestor-de-finanzas/";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            try { updateWidget(context, appWidgetManager, id); }
            catch (Exception e) { Log.e(TAG, "updateWidget error id=" + id, e); }
        }
        WidgetCache.fetch(context, () -> {
            for (int id : appWidgetIds) {
                try { updateWidget(context, appWidgetManager, id); }
                catch (Exception e) { Log.e(TAG, "post-fetch error id=" + id, e); }
            }
        });
    }

    static void updateWidget(Context context, AppWidgetManager appWidgetManager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_productos);

        views.setOnClickPendingIntent(R.id.wp_btn_lista,
                buildIntent(context, BASE_URL + "?action=productos", 2001));
        views.setOnClickPendingIntent(R.id.wp_btn_escanear,
                buildIntent(context, BASE_URL + "?action=escanear", 2002));

        String[] names  = WidgetCache.getProductosNames(context);
        String[] prices = WidgetCache.getProductosPrices(context);

        int[] nameIds  = { R.id.wp_r1_name,  R.id.wp_r2_name,  R.id.wp_r3_name  };
        int[] priceIds = { R.id.wp_r1_price, R.id.wp_r2_price, R.id.wp_r3_price };

        for (int i = 0; i < nameIds.length; i++) {
            if (i < names.length) {
                views.setTextViewText(nameIds[i], names[i]);
                views.setTextViewText(priceIds[i], i < prices.length ? prices[i] : "");
            } else {
                views.setTextViewText(nameIds[i], i == 0 && names.length == 0 ? "Sincroniza la app para ver datos" : "");
                views.setTextViewText(priceIds[i], "");
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
