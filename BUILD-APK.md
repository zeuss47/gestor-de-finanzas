# 📱 Cómo tener Gestor de Finanzas en Android

3 caminos según cuánta funcionalidad quieras:

---

## ✅ Opción A — Instalar como PWA (recomendado para empezar)

**Sin APK, sin tienda. Funciona en 30 segundos.**

### Pasos
1. Abrí **Chrome en tu Android**: https://zeuss47.github.io/gestor-de-finanzas/
2. Tocá los **3 puntos** arriba a la derecha → **"Instalar app"** o **"Añadir a pantalla de inicio"**
3. Aparece el icono en tu home como una app más
4. **Long-press en el icono** → vas a ver shortcuts: `Nuevo gasto`, `Nuevo ingreso`, `Sync`, `Tarjetas`

### Lo que tenés
- ✅ Funciona offline (Service Worker cachea todo)
- ✅ Notificaciones nativas
- ✅ Pantalla completa sin barra del navegador
- ✅ Shortcuts (long-press)
- ❌ No hay widget en el home screen (eso requiere Opción C)

---

## ⭐ Opción B — APK con PWABuilder (más cerca de una app nativa)

**Genera un APK firmado que podés instalar o subir a la Play Store.**

### Pasos (2 minutos, todo desde el navegador)

1. Andá a **https://www.pwabuilder.com/**
2. Pegá la URL: `https://zeuss47.github.io/gestor-de-finanzas/`
3. Tocá **"Start"** → analiza tu PWA y te da un score
4. Tocá **"Package For Stores"** → seleccioná **Android**
5. Opciones recomendadas:
   - **Package ID**: `com.zeuss47.finanzas` (debe ser único)
   - **App name**: `Gestor de Finanzas`
   - **Display mode**: Standalone
   - **Status bar color**: `#050614`
   - **Splash screen color**: `#050614`
   - **Signing key**: PWABuilder te genera una nueva (descargala y guardala)
6. Tocá **"Download"** → te baja un ZIP con:
   - `app-release-signed.apk` ← este es el APK
   - `signing.keystore` ← guardalo SEGURO para futuras actualizaciones
   - Instrucciones de Play Store

### Instalar el APK en tu Android

1. Pasá el `.apk` al teléfono (USB, drive, email)
2. Andá a **Ajustes → Seguridad → Permitir desde esta fuente** (para tu app de archivos)
3. Tocá el APK → "Instalar"
4. Listo, tenés el ícono como cualquier app

### Subirlo a Google Play Store (opcional)

1. Creá cuenta de desarrollador en https://play.google.com/console (USD 25, una vez)
2. Subí el `app-release-signed.aab` (Android App Bundle) que también te genera PWABuilder
3. Completá ficha de la app y envialo a revisión
4. En ~24hs está aprobado

### Pros vs PWA
- ✅ Icono propio sin "Powered by Chrome"
- ✅ Splash screen personalizado
- ✅ Se puede publicar en Play Store
- ✅ Misma experiencia que la PWA (es una TWA = Trusted Web Activity)
- ⚠️ Necesitás `assetlinks.json` en `zeuss47.github.io` para que TWA confíe en tu dominio (PWABuilder te da el JSON listo, lo subís al repo)
- ❌ Sigue sin tener widgets en el home

---

## ⭐⭐⭐ Opción C — Capacitor + Android Studio (con widgets en home)

**Para tener widgets nativos en la pantalla principal de Android.**

Esto requiere Android Studio y conocimiento básico de desarrollo nativo Android. No lo puedo hacer 100% por chat porque necesita IDE.

### Setup

```powershell
# 1. Instalar Android Studio (incluye Android SDK)
# https://developer.android.com/studio

# 2. Configurar variables de entorno
$env:ANDROID_HOME = "C:\Users\$env:USERNAME\AppData\Local\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"  # Necesitás JDK 17+

# 3. En la carpeta frontend, agregar Capacitor
cd "c:\Users\pc\Documents\vs codec\app finanzas\frontend"
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Gestor de Finanzas" com.zeuss47.finanzas
npx cap add android
npx cap copy
npx cap open android
```

Eso abre Android Studio con un proyecto Android nativo que envuelve tu PWA.

### Agregar widget de home screen

En `android/app/src/main/`, agregar:

1. **`AndroidManifest.xml`** → declarar el widget receiver:
```xml
<receiver android:name=".FinanzasWidget" android:exported="true">
    <intent-filter>
        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
    </intent-filter>
    <meta-data android:name="android.appwidget.provider"
               android:resource="@xml/finanzas_widget_info" />
</receiver>
```

2. **`res/xml/finanzas_widget_info.xml`** → tamaño y configuración:
```xml
<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="180dp"
    android:minHeight="80dp"
    android:updatePeriodMillis="1800000"
    android:initialLayout="@layout/finanzas_widget"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen" />
```

3. **`res/layout/finanzas_widget.xml`** → layout XML del widget (saldo, ingresos, etc.)

4. **`FinanzasWidget.kt`** → AppWidgetProvider que lee datos desde IndexedDB
   (necesita un puente: la PWA escribe a localStorage o un endpoint del WebView; el widget Android los lee y muestra)

### Datos del widget
El widget Android no puede leer IndexedDB directamente. Hay 3 opciones:
- **A.** WebView background que ejecuta JS y consulta IndexedDB, devuelve a Kotlin
- **B.** Sincronizar localStorage → SharedPreferences cada N min (más simple)
- **C.** El widget muestra el último estado guardado en SharedPreferences por la app cuando se cerró

Esto último es lo más simple: cada vez que el usuario abre la app y cambia algo, la PWA escribe en SharedPreferences vía un plugin Capacitor, y el widget lee de ahí.

### Pros vs APK simple
- ✅ Widget en el home (saldo líquido, próximo vencimiento, etc.)
- ✅ Acceso a APIs nativas (NFC, sensores, biometría)
- ✅ Notificaciones push reales (FCM)
- ❌ Más complejo de mantener
- ❌ Cada cambio de la PWA requiere `npx cap copy && rebuild APK`

---

## 🎯 Mi recomendación

**Empezá con la Opción A** (PWA instalada). Es 30 segundos y tenés casi todo. Los **shortcuts de long-press** te dan el atajo a "Nuevo gasto" que es lo más importante en la práctica.

Si querés un APK formal (sin barra de Chrome, splash screen propio, posibilidad de subirlo a Play Store), usá la **Opción B con PWABuilder**.

La **Opción C** solo si querés literalmente un **widget en el home screen mostrando tu saldo**. Eso requiere setup serio.
