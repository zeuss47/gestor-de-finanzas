# 💹 Gestor de Finanzas Personales

PWA cyberpunk para gestión financiera personal, **100% offline-first** con sincronización opcional a GitHub para usarlo en múltiples dispositivos.

🔗 **App en vivo:** https://zeuss47.github.io/gestor-de-finanzas/

---

## ✨ Features

### 📊 Dashboard analítico
- **14 widgets** dinámicos redimensionables (drag desde la esquina)
- KPIs en tiempo real, gráficos Chart.js, glassmorphism cyberpunk
- Vista de **Análisis** que filtra solo widgets de IA y patrones
- Modo claro/oscuro automático

### 💰 Gestión completa
- **Gastos** con categorías editables, métodos de pago visuales, gastos compartidos
- **Ingresos** con sueldo bruto/neto/bonos y período de aplicación
- **Tarjetas de crédito** con motor de ciclos (cierre + vencimiento + cuotas + recurrentes)
- **Cuentas bancarias** (caja ahorro, billetera, inversión, cripto) con saldo automático
- **Metas de ahorro** con presets, barra de progreso y prioridad

### 🔮 IA local (sin servidor)
- **Predicción de balance futuro** a 30/60/90 días con regresión lineal + media móvil ponderada
- **Saturación de tarjetas**: cuándo cada tarjeta llega al 80% del límite según ritmo
- **Diagnóstico estadístico**: detecta gastos hormiga, desvíos por categoría, rachas
- **Sugerencia de categorías** con TF-IDF light según descripciones históricas

### 🔄 Multi-dispositivo
- **5 disparadores de sync** combinados:
  - Al abrir la app (pull inicial)
  - Cada 5 min (configurable)
  - Al editar (debounce 30s)
  - Al volver online
  - Al cerrar/minimizar la pestaña
- **Merge LWW** (Last-Write-Wins) por `updated_at`
- PAT guardado **solo localmente**, nunca en el repo

---

## 🚀 Quick Start

### Como usuario

1. Abrí https://zeuss47.github.io/gestor-de-finanzas/ en tu navegador
2. (Opcional) Configurá GitHub Sync en Ajustes → Sync para usar en múltiples dispositivos
3. Cargá tu primer gasto con el botón flotante `+`

### Para correrlo localmente

```bash
git clone https://github.com/zeuss47/gestor-de-finanzas.git
cd gestor-de-finanzas
python -m http.server 8080
# Abrí http://localhost:8080
```

### Para usar con datos demo

Andá a `http://localhost:8080/demo.html` — carga 3 cuentas, 2 tarjetas, 16 movimientos y 2 metas de ejemplo.

---

## 🏗 Arquitectura

```
frontend/
├── index.html                ← Shell + templates + diálogos
├── manifest.json             ← PWA manifest (instalable)
├── sw.js                     ← Service Worker (offline + cache)
├── css/styles.css            ← Sistema de diseño cyberpunk
├── icons/                    ← Iconos PWA (192/512 + maskable)
└── js/
    ├── app.js                ← Orquestador (estado, render, eventos)
    ├── db.js                 ← Wrapper IndexedDB
    ├── cards.js              ← Motor de ciclos de tarjeta
    ├── sync.js               ← Auto-sync con GitHub
    ├── ai-local.js           ← Diagnóstico estadístico
    ├── ai-predict.js         ← Predicción de balance + saturación
    └── notifications.js      ← Web Notifications API
```

### Stores IndexedDB

| Store | Indexes |
|---|---|
| `gastos` | fecha, tarjeta_id, cuenta_id, categoria, updated_at |
| `ingresos` | fecha, periodo_aplicacion, cuenta_id, categoria, updated_at |
| `tarjetas` | nombre, updated_at |
| `cuentas` | nombre, tipo, updated_at |
| `metas` | prioridad, updated_at |
| `ajustes` | id (singleton) |
| `sync_queue` | qid (auto) |

---

## ⚙️ Configurar sincronización GitHub

1. Creá un repo **privado** llamado `datafinance` en https://github.com/new
2. Generá un **Personal Access Token** con scope `repo` en https://github.com/settings/tokens/new?scopes=repo&description=finanzas-app
3. En la app, abrí **Ajustes → Sync** y pegá:
   - PAT
   - Usuario/Org: `zeuss47`
   - Repositorio: `datafinance`
4. Tocá **🔌 Probar conexión y sincronizar**
5. ¡Listo! Repetí en cada dispositivo con la misma config.

---

## 🛠 Stack técnico

- **Frontend**: Vanilla JS (módulos ES6) + Tailwind CDN + Chart.js
- **Storage**: IndexedDB nativo
- **Sync**: GitHub REST API (sin backend propio)
- **PWA**: Service Worker + Web App Manifest
- **IA**: Algoritmos estadísticos puros (regresión lineal, TF-IDF, media móvil)

---

## 📄 Licencia

MIT — Hacé lo que quieras con el código.
