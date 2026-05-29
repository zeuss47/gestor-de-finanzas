# ════════════════════════════════════════════════════════════════
# auto-push.ps1
# ────────────────────────────────────────────────────────────────
# Lee JSON del hook por stdin, verifica si hay cambios en el repo,
# y si hay → git add + commit + push automático.
#
# Pensado para correr como hook "Stop" de Claude Code: se dispara
# UNA VEZ al final del turno, así múltiples edits en un mismo turno
# = 1 solo commit con todos los cambios juntos.
# ════════════════════════════════════════════════════════════════

$ErrorActionPreference = "SilentlyContinue"

# Carpeta del repo
$REPO = "c:\Users\pc\Documents\vs codec\app finanzas\frontend"

# Si no existe el repo, salir limpio
if (-not (Test-Path "$REPO\.git")) { exit 0 }

Set-Location $REPO

# ¿Hay cambios para commitear?
$status = & git status --porcelain 2>$null
if (-not $status) { exit 0 }

# Resumen de archivos modificados para el mensaje
$archivos = ($status -split "`n" | ForEach-Object {
    ($_ -split '\s+', 2)[1]
} | Where-Object { $_ }) -join ', '

# Truncar mensaje si es muy largo
if ($archivos.Length -gt 80) {
    $archivos = $archivos.Substring(0, 77) + "..."
}

$fecha = Get-Date -Format "yyyy-MM-dd HH:mm"

# Add + commit + push
& git add -A 2>$null
& git -c user.name="zeuss47" -c user.email="axelfrankowski@gmail.com" `
      commit -q -m "auto-update $fecha · $archivos" 2>$null

if ($LASTEXITCODE -ne 0) { exit 0 }

# Push (silencioso, no bloquea si falla la red)
& git push origin main 2>&1 | Out-Null

# Log a archivo para debugging
$logLine = "[$fecha] commit + push: $archivos"
Add-Content -Path "$env:TEMP\claude-autopush.log" -Value $logLine -ErrorAction SilentlyContinue

exit 0
