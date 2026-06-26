package com.zeuss47.gestorfinanzas;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Lee widget-cache.json desde GitHub Pages (URL pública, sin auth, sin rate limits).
 * El archivo es generado por la app web en cada sync y servido en:
 * https://zeuss47.github.io/gestor-de-finanzas/data/widget-cache.json
 */
public class WidgetCache {

    private static final String TAG      = "WidgetCache";
    private static final String PREFS    = "widget_cache_v1";
    private static final String K_GDESC  = "g_desc";
    private static final String K_GAMT   = "g_amt";
    private static final String K_PNAME  = "p_name";
    private static final String K_PPRICE = "p_price";
    private static final String K_HNAME  = "h_name";
    private static final String K_HSTATUS= "h_status";   // "OK" | ""

    // GitHub Pages sirve todos los archivos del repo publicamente
    private static final String PAGES_URL =
        "https://zeuss47.github.io/gestor-de-finanzas/data/widget-cache.json";

    // ── Getters ────────────────────────────────────────────────────────

    static String[] getGastosDesc(Context ctx)      { return load(ctx, K_GDESC);   }
    static String[] getGastosAmt(Context ctx)        { return load(ctx, K_GAMT);    }
    static String[] getProductosNames(Context ctx)   { return load(ctx, K_PNAME);   }
    static String[] getProductosPrices(Context ctx)  { return load(ctx, K_PPRICE);  }
    static String[] getHabitualesNames(Context ctx)  { return load(ctx, K_HNAME);   }
    static String[] getHabitualesStatus(Context ctx) { return load(ctx, K_HSTATUS); }

    private static String[] load(Context ctx, String key) {
        String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, null);
        if (json == null) return new String[0];
        try {
            JSONArray arr = new JSONArray(json);
            String[] out = new String[arr.length()];
            for (int i = 0; i < arr.length(); i++) out[i] = arr.optString(i, "");
            return out;
        } catch (Exception e) { return new String[0]; }
    }

    // ── Fetch desde GitHub Pages (hilo de fondo) ───────────────────────

    static void fetch(Context ctx, Runnable onDone) {
        new Thread(() -> {
            try {
                // Parametro _t para saltar cache del CDN de GitHub Pages
                String url = PAGES_URL + "?_t=" + System.currentTimeMillis();
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                conn.setRequestProperty("Cache-Control", "no-cache");

                int code = conn.getResponseCode();
                if (code == 200) {
                    StringBuilder sb = new StringBuilder();
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                        String line;
                        while ((line = br.readLine()) != null) sb.append(line);
                    }
                    // GitHub Pages devuelve el JSON directamente (sin base64)
                    parseAndStore(ctx, new JSONObject(sb.toString()));
                } else {
                    Log.w(TAG, "fetch HTTP " + code + " — sin datos frescos, usando cache");
                }
            } catch (Exception e) {
                Log.w(TAG, "fetch error: " + e.getMessage());
            }
            if (onDone != null) {
                new Handler(Looper.getMainLooper()).post(onDone);
            }
        }).start();
    }

    private static void parseAndStore(Context ctx, JSONObject root) throws Exception {
        // ── Gastos ──
        JSONArray gastos = root.optJSONArray("gastos");
        JSONArray gDesc = new JSONArray(), gAmt = new JSONArray();
        if (gastos != null) {
            for (int i = 0; i < gastos.length(); i++) {
                JSONObject g = gastos.getJSONObject(i);
                String f = g.optString("f", ""), d = g.optString("d", "");
                long m = g.optLong("m", 0);
                gDesc.put(f.isEmpty() ? d : f + "  " + d);
                gAmt.put(m > 0 ? "-$" + fmt(m) : "");
            }
        }

        // ── Productos ──
        JSONArray productos = root.optJSONArray("productos");
        JSONArray pName = new JSONArray(), pPrice = new JSONArray();
        if (productos != null) {
            for (int i = 0; i < productos.length(); i++) {
                JSONObject p = productos.getJSONObject(i);
                pName.put(p.optString("n", ""));
                long pr = p.optLong("p", 0);
                pPrice.put(pr > 0 ? "$" + fmt(pr) : "");
            }
        }

        // ── Habituales ──
        JSONArray habs = root.optJSONArray("habituales");
        JSONArray hName = new JSONArray(), hStatus = new JSONArray();
        if (habs != null) {
            for (int i = 0; i < habs.length(); i++) {
                JSONObject h = habs.getJSONObject(i);
                hName.put(h.optString("n", ""));
                hStatus.put(h.optBoolean("ok", false) ? "OK" : "");
            }
        }

        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(K_GDESC,   gDesc.toString())
                .putString(K_GAMT,    gAmt.toString())
                .putString(K_PNAME,   pName.toString())
                .putString(K_PPRICE,  pPrice.toString())
                .putString(K_HNAME,   hName.toString())
                .putString(K_HSTATUS, hStatus.toString())
                .apply();
    }

    private static String fmt(long n) {
        String s = Long.toString(n);
        StringBuilder sb = new StringBuilder();
        int len = s.length();
        for (int i = 0; i < len; i++) {
            if (i > 0 && (len - i) % 3 == 0) sb.append('.');
            sb.append(s.charAt(i));
        }
        return sb.toString();
    }
}
