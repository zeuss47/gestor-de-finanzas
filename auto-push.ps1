# ════════════════════════════════════════════════════════════════
# auto-push.ps1
# ────────────────────────────────────────────────────────────────
# 1. Detecta cambios en el repo
# 2. Incrementa el build y actualiza la fecha en version.json
# 3. Commit + push automático
# Pensado para correr como hook "Stop" de Claude Code.
# ════════════════════════════════════════════════════════════════

$ErrorActionPreference = "SilentlyContinue"

$REPO = "c:\Users\pc\Documents\vs codec\app finanzas\frontend"

if (-not (Test-Path "$REPO\.git")) { exit 0 }
Set-Location $REPO

# ─── 0. Rebuild Tailwind CSS si index.html o JS cambiaron ────────
$twConfig = "$REPO\tailwind.config.js"
$twInput  = "$REPO\css\tailwind-input.css"
$twOutput = "$REPO\css\tailwind.css"
if ((Test-Path $twConfig) -and (Test-Path $twInput)) {
    # Solo rebuild si hay archivos HTML/JS modificados o tailwind.css no existe
    $hayHtmlJs = (& git status --porcelain 2>$null) -match '\.(html|js)$'
    if ($hayHtmlJs -or -not (Test-Path $twOutput)) {
        & npx tailwindcss -c $twConfig -i $twInput -o $twOutput --minify 2>$null
    }
}

# ¿Hay cambios?
$status = & git status --porcelain 2>$null
if (-not $status) { exit 0 }

$fecha = Get-Date -Format "yyyy-MM-dd HH:mm"
$fechaISO = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# ─── 1. Actualizar version.json ───────────────────────────────────
$versionFile = "$REPO\version.json"
if (Test-Path $versionFile) {
    try {
        $v = Get-Content $versionFile -Raw | ConvertFrom-Json
        $newBuild = ([int]$v.build) + 1

        # Versionado simple: major.minor. Cada commit sube minor en 1.
        # Si la version actual tiene formato viejo (1.0.7), la convertimos a major.minor+1.
        # Cuando minor llega a 99, sube major y reset minor a 0.
        $parts = $v.version -split '\.'
        $major = [int]$parts[0]
        if ($parts.Length -ge 2) { $minor = [int]$parts[1] } else { $minor = 0 }
        $minor = $minor + 1
        if ($minor -ge 100) { $major = $major + 1; $minor = 0 }
        $newVersion = "$major.$minor"

        # Resumen corto de archivos cambiados
        $archivos = ($status -split "`n" | ForEach-Object {
            ($_ -split '\s+', 2)[1]
        } | Where-Object { $_ }) -join ', '
        if ($archivos.Length -gt 100) { $archivos = $archivos.Substring(0, 97) + "..." }

        $v.version  = $newVersion
        $v.build    = $newBuild
        $v.modified = $fechaISO
        $v.commit   = $archivos
        $v.notes    = "Auto-update $fecha"

        $json = $v | ConvertTo-Json -Depth 5
        Set-Content -Path $versionFile -Value $json -Encoding UTF8 -NoNewline

        # Add explícito porque acabamos de modificar
        & git add version.json 2>$null
    } catch {
        # Si falla parse de JSON, seguimos sin tocar version.json
    }
}

# ─── 1b. Bumpear la VERSION del Service Worker con el build ────────
# Cada deploy debe cambiar sw.js para que el navegador detecte el SW nuevo
# (si sw.js no cambia, nunca se dispara 'updatefound' → no se detecta el update).
$swFile = "$REPO\sw.js"
if ((Test-Path $swFile) -and $newBuild) {
    try {
        # IMPORTANTE: leer SIEMPRE como UTF-8. Si se usa Get-Content -Raw sin
        # encoding, PowerShell 5.1 interpreta el UTF-8 como Windows-1252 y al
        # reescribir duplica los bytes de cada caracter acentuado -> el archivo
        # crece de forma exponencial en cada commit (corrupcion de mojibake).
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $sw = [System.IO.File]::ReadAllText($swFile, $utf8NoBom)
        # Conserva la base (ej. 'v3.3.0-pages') y reemplaza/agrega el sufijo -b<build>.
        $swNew = [regex]::Replace($sw, "const VERSION = '([^']*?)(?:-b\d+)?';", "const VERSION = '`${1}-b$newBuild';")
        if ($swNew -ne $sw) {
            [System.IO.File]::WriteAllText($swFile, $swNew, $utf8NoBom)   # UTF-8 sin BOM
            & git add sw.js 2>$null
        }
    } catch { }
}

# ─── 2. Add + commit + push ──────────────────────────────────────
& git add -A 2>$null

$shortMsg = if ($archivos.Length -gt 60) { $archivos.Substring(0, 57) + "..." } else { $archivos }
$commitMsg = "v$($v.version) build#$newBuild · $shortMsg"

& git -c user.name="zeuss47" -c user.email="axelfrankowski@gmail.com" `
      commit -q -m $commitMsg 2>$null

if ($LASTEXITCODE -ne 0) { exit 0 }

# Push silencioso. Si falla red/auth no aborta otras operaciones.
& git push origin main 2>&1 | Out-Null

# Log para debugging
$logLine = "[$fecha] v$($v.version) build#$newBuild → $shortMsg"
Add-Content -Path "$env:TEMP\claude-autopush.log" -Value $logLine -ErrorAction SilentlyContinue

exit 0
