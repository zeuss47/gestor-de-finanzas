package com.zeuss47.gestorfinanzas;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class WidgetCache {

    private static final String TAG     = "WidgetCache";
    private static final String PREFS   = "widget_cache_v1";
    private static final String K_GDESC = "g_desc";
    private static final String K_GAMT  = "g_amt";
    private static final String K_PNAME = "p_name";
    private static final String K_PPRICE= "p_price";

    // GitHub repository info (public repo served via GitHub Pages)
    private static final String GH_OWNER  = "zeuss47";
    private static final String GH_REPO   = "gestor-de-finanzas";
    private static final String GH_BRANCH = "main";
    private static final String GH_PATH   = "data/widget-cache.json";

    // ── Getters (read from SharedPreferences) ──────────────────────────

    static String[] getGastosDesc(Context ctx) {
        return loadArray(ctx, K_GDESC);
    }

    static String[] getGastosAmt(Context ctx) {
        return loadArray(ctx, K_GAMT);
    }

    static String[] getProductosNames(Context ctx) {
        return loadArray(ctx, K_PNAME);
    }

    static String[] getProductosPrices(Context ctx) {
        return loadArray(ctx, K_PPRICE);
    }

    private static String[] loadArray(Context ctx, String key) {
        String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, null);
        if (json == null) return new String[0];
        try {
            JSONArray arr = new JSONArray(json);
            String[] out = new String[arr.length()];
            for (int i = 0; i < arr.length(); i++) out[i] = arr.optString(i, "");
            return out;
        } catch (Exception e) {
            return new String[0];
        }
    }

    // ── Fetch from GitHub API (background thread) ──────────────────────

    static void fetch(Context ctx, Runnable onDone) {
        new Thread(() -> {
            try {
                // Use GitHub Contents API (unauthenticated, public repo, 60 req/hour limit)
                String apiUrl = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO
                        + "/contents/" + GH_PATH + "?ref=" + GH_BRANCH;
                HttpURLConnection conn = (HttpURLConnection) new URL(apiUrl).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");

                int code = conn.getResponseCode();
                if (code == 200) {
                    StringBuilder sb = new StringBuilder();
                    try (BufferedReader br = new BufferedReader(
                            new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                        String line;
                        while ((line = br.readLine()) != null) sb.append(line);
                    }
                    JSONObject apiResp = new JSONObject(sb.toString());
                    // GitHub API returns content as base64 (with newlines)
                    String b64 = apiResp.getString("content").replaceAll("\\s+", "");
                    String cacheJson = new String(Base64.decode(b64, Base64.DEFAULT), "UTF-8");
                    parseAndStore(ctx, new JSONObject(cacheJson));
                } else {
                    Log.w(TAG, "fetch HTTP " + code);
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
        JSONArray gastos   = root.optJSONArray("gastos");
        JSONArray productos = root.optJSONArray("productos");

        JSONArray gDesc  = new JSONArray();
        JSONArray gAmt   = new JSONArray();
        if (gastos != null) {
            for (int i = 0; i < gastos.length(); i++) {
                JSONObject g = gastos.getJSONObject(i);
                String fecha = g.optString("f", "");
                String desc  = g.optString("d", "");
                long monto   = g.optLong("m", 0);
                gDesc.put(fecha.isEmpty() ? desc : fecha + "  " + desc);
                gAmt.put(monto > 0 ? "-$" + fmtNum(monto) : "");
            }
        }

        JSONArray pName  = new JSONArray();
        JSONArray pPrice = new JSONArray();
        if (productos != null) {
            for (int i = 0; i < productos.length(); i++) {
                JSONObject p = productos.getJSONObject(i);
                pName.put(p.optString("n", ""));
                long precio = p.optLong("p", 0);
                pPrice.put(precio > 0 ? "$" + fmtNum(precio) : "");
            }
        }

        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(K_GDESC,  gDesc.toString())
                .putString(K_GAMT,   gAmt.toString())
                .putString(K_PNAME,  pName.toString())
                .putString(K_PPRICE, pPrice.toString())
                .apply();
    }

    private static String fmtNum(long n) {
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
