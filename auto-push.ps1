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

        # Si hubo cambios mayores en archivos JS o HTML, sube minor
        $bigFiles = ($status -split "`n" | Where-Object { $_ -match "\.(js|html)$" } | Measure-Object).Count
        $newVersion = $v.version
        if ($bigFiles -ge 3) {
            $parts = $v.version -split '\.'
            if ($parts.Length -ge 3) {
                $patch = [int]$parts[2] + 1
                $newVersion = "$($parts[0]).$($parts[1]).$patch"
            }
        }

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
