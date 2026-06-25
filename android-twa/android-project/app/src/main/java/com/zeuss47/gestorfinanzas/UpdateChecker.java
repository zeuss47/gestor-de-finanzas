package com.zeuss47.gestorfinanzas;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Comprueba si hay una nueva versión del APK publicada en GitHub Releases.
 * Si la hay, muestra un diálogo y descarga/instala via DownloadManager.
 *
 * El tag de cada release tiene el formato "v{versionName}-b{runNumber}",
 * ej. "v1.3-b17". La comparación usa el número de build (runNumber), que
 * coincide con el versionCode inyectado por Gradle en el CI.
 */
public class UpdateChecker {

    private static final String GITHUB_OWNER   = "zeuss47";
    private static final String GITHUB_REPO    = "gestor-de-finanzas";
    // Nombre exacto del asset publicado en GitHub Releases por el workflow
    private static final String APK_ASSET_NAME = "gestor-finanzas.apk";
    // Intervalo mínimo entre checks al servidor (12 horas)
    private static final long   CHECK_INTERVAL_MS = 12L * 60 * 60 * 1000;

    private static final String PREFS_NAME      = "update_checker";
    private static final String KEY_LAST_CHECK  = "last_check_ts";
    private static final String KEY_SKIPPED_TAG = "skipped_tag";

    private static final String API_URL =
            "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/releases/latest";

    /** Punto de entrada: llamar desde onResume() de LauncherActivity. */
    public static void check(Activity activity) {
        SharedPreferences prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long lastCheck = prefs.getLong(KEY_LAST_CHECK, 0);
        if (System.currentTimeMillis() - lastCheck < CHECK_INTERVAL_MS) return;

        ExecutorService executor = Executors.newSingleThreadExecutor();
        Handler mainHandler    = new Handler(Looper.getMainLooper());

        executor.execute(() -> {
            try {
                ReleaseInfo info = fetchLatestRelease();
                if (info == null) return;

                prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();

                int    localBuild  = getInstalledBuildNumber(activity);
                String skippedTag  = prefs.getString(KEY_SKIPPED_TAG, "");

                if (isNewer(info.tagName, localBuild) && !info.tagName.equals(skippedTag)) {
                    mainHandler.post(() -> showUpdateDialog(activity, info, prefs));
                }
            } catch (Exception ignored) {
                // Silencioso: sin conexión o API rate-limit, no molestamos al usuario
            }
        });
    }

    // ── Modelo ───────────────────────────────────────────────────────────────────

    private static class ReleaseInfo {
        String tagName;  // ej. "v1.3-b17"
        String apkUrl;   // browser_download_url del asset APK
        String body;     // notas del release (changelog)
    }

    // ── Red ──────────────────────────────────────────────────────────────────────

    private static ReleaseInfo fetchLatestRelease() throws Exception {
        URL url = new URL(API_URL);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestProperty("Accept", "application/vnd.github+json");
        conn.setRequestProperty("User-Agent", "GestorFinanzas-UpdateChecker/1.0");
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);

        if (conn.getResponseCode() != 200) return null;

        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(conn.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
        }
        conn.disconnect();

        JSONObject json = new JSONObject(sb.toString());
        String tag  = json.optString("tag_name", "");
        String body = json.optString("body", "");
        if (tag.isEmpty()) return null;

        // Buscar el asset con nombre exacto "gestor-finanzas.apk"
        JSONArray assets = json.optJSONArray("assets");
        String apkUrl = null;
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.getJSONObject(i);
                if (APK_ASSET_NAME.equals(asset.optString("name"))) {
                    apkUrl = asset.optString("browser_download_url");
                    break;
                }
            }
        }
        if (apkUrl == null || apkUrl.isEmpty()) return null;

        ReleaseInfo info = new ReleaseInfo();
        info.tagName = tag;
        info.apkUrl  = apkUrl;
        info.body    = body;
        return info;
    }

    // ── Comparación de versiones ──────────────────────────────────────────────────
    //
    // El tag tiene formato "v{versionName}-b{buildNumber}", ej. "v1.3-b17".
    // El versionCode del APK instalado coincide con el buildNumber del CI.
    // Comparamos enteros: si remoteBuild > localBuild → hay actualización.

    static boolean isNewer(String remoteTag, int localBuildNumber) {
        int remoteBuild = extractBuildNumber(remoteTag);
        if (remoteBuild > 0) {
            return remoteBuild > localBuildNumber;
        }
        // Fallback para tags sin sufijo -b (ej. "v1.3"): cualquier version != 0 es nueva
        return localBuildNumber == 0;
    }

    /** Extrae el número de build del tag. "v1.3-b17" → 17. Devuelve -1 si no parsea. */
    static int extractBuildNumber(String tag) {
        if (tag == null) return -1;
        int idx = tag.lastIndexOf("-b");
        if (idx < 0) return -1;
        try {
            return Integer.parseInt(tag.substring(idx + 2).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** versionCode del APK instalado (inyectado por Gradle con el run_number del CI). */
    static int getInstalledBuildNumber(Context ctx) {
        try {
            PackageInfo pi = ctx.getPackageManager()
                    .getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    // ── Diálogo ──────────────────────────────────────────────────────────────────

    private static void showUpdateDialog(Activity activity, ReleaseInfo info, SharedPreferences prefs) {
        if (activity.isFinishing() || activity.isDestroyed()) return;

        String changelog = (info.body != null && !info.body.isEmpty())
                ? "\n\n" + truncate(info.body, 280) + "\n"
                : "";

        String message = "Version disponible: " + info.tagName + changelog
                + "\n¿Descargar e instalar ahora?";

        new AlertDialog.Builder(activity)
                .setTitle("Nueva actualizacion disponible")
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton("Instalar", (d, w) -> downloadAndInstall(activity, info))
                .setNeutralButton("Ahora no",  (d, w) -> { /* vuelve a preguntar mañana */ })
                .setNegativeButton("Saltar esta version", (d, w) ->
                        prefs.edit().putString(KEY_SKIPPED_TAG, info.tagName).apply())
                .show();
    }

    // ── Descarga e instalación ────────────────────────────────────────────────────

    private static void downloadAndInstall(Activity activity, ReleaseInfo info) {
        // Android 8+ requiere que el usuario habilite "Instalar apps desconocidas" para esta app
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivityForResult(intent, 0);
                Toast.makeText(activity,
                        "Activa 'Instalar apps desconocidas' y vuelve a intentarlo",
                        Toast.LENGTH_LONG).show();
                return;
            }
        }

        String safeName = "gestor-finanzas-" +
                info.tagName.replaceAll("[^a-zA-Z0-9._-]", "_") + ".apk";

        File apkFile = new File(
                activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safeName);
        if (apkFile.exists()) apkFile.delete();

        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(info.apkUrl))
                .setTitle("Actualizando Gestor de Finanzas")
                .setDescription("Descargando " + info.tagName + "...")
                .setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(
                        activity, Environment.DIRECTORY_DOWNLOADS, safeName)
                .setMimeType("application/vnd.android.package-archive")
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false);

        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        long downloadId = dm.enqueue(req);

        Toast.makeText(activity, "Descargando actualizacion...", Toast.LENGTH_SHORT).show();

        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;

                DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
                Cursor cursor = dm.query(query);
                boolean success = false;
                if (cursor != null && cursor.moveToFirst()) {
                    int col = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    success = col >= 0 && cursor.getInt(col) == DownloadManager.STATUS_SUCCESSFUL;
                    cursor.close();
                }

                if (success) {
                    launchInstaller(activity, apkFile);
                } else {
                    new Handler(Looper.getMainLooper()).post(() ->
                            Toast.makeText(activity,
                                    "Error en la descarga. Intentalo de nuevo.",
                                    Toast.LENGTH_LONG).show());
                }

                try { activity.unregisterReceiver(this); }
                catch (IllegalArgumentException ignored) {}
            }
        };

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            activity.registerReceiver(receiver, filter);
        }
    }

    private static void launchInstaller(Activity activity, File apkFile) {
        Uri apkUri;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            apkUri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + ".fileprovider",
                    apkFile);
        } else {
            apkUri = Uri.fromFile(apkFile);
        }

        Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(apkUri, "application/vnd.android.package-archive")
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);

        if (install.resolveActivity(activity.getPackageManager()) != null) {
            activity.startActivity(install);
        } else {
            Toast.makeText(activity, "No se pudo abrir el instalador.", Toast.LENGTH_LONG).show();
        }
    }

    // ── Util ──────────────────────────────────────────────────────────────────────

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max) + "...";
    }
}
