# ════════════════════════════════════════════════════════════════
# setup-pat.ps1
# ────────────────────────────────────────────────────────────────
# Configura un PAT nuevo de GitHub en el remote local (solo .git/config).
# El PAT NUNCA queda en chat, transcript ni archivo trackeado por git.
#
# Uso:
#   .\setup-pat.ps1
# Te pide el PAT con input oculto (no se ve al pegarlo).
# ════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

Write-Host ""
Write-Host "  Configurar PAT de GitHub para auto-push" -ForegroundColor Cyan
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  1. Generar PAT nuevo: https://github.com/settings/tokens/new?scopes=repo&description=finanzas-autopush" -ForegroundColor Yellow
Write-Host "  2. Pegarlo abajo (no se va a ver mientras lo pegas)" -ForegroundColor Yellow
Write-Host ""

$PAT = Read-Host "  PAT" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($PAT)
$PLAIN = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if (-not $PLAIN -or $PLAIN.Length -lt 20) {
    Write-Host "  ✗ PAT inválido o vacío" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Configurando remote..." -ForegroundColor Cyan

$USER = git config --global user.name
if (-not $USER) { $USER = "zeuss47" }

# Configurar el remote del repo de código con el PAT (queda solo en .git/config)
git remote set-url origin "https://$USER`:$PLAIN@github.com/$USER/gestor-de-finanzas.git"

# Desactivar Git Credential Manager localmente para que no pida confirmación
git config --local credential.helper ""

Write-Host "  ✓ Remote configurado" -ForegroundColor Green
Write-Host ""
Write-Host "  Probando push..." -ForegroundColor Cyan
$env:GIT_TERMINAL_PROMPT = "0"

$pushOutput = & git push origin main 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✓ Push exitoso. Auto-sync activado." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Desde ahora, cada cambio en la app:" -ForegroundColor White
    Write-Host "    • Incrementa el build en version.json" -ForegroundColor Gray
    Write-Host "    • Hace commit con resumen automatico" -ForegroundColor Gray
    Write-Host "    • Pushea a GitHub" -ForegroundColor Gray
    Write-Host "    • GitHub Pages se redeploya en ~1-2 min" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  App: https://zeuss47.github.io/gestor-de-finanzas/" -ForegroundColor Yellow
} else {
    Write-Host "  ✗ Push falló:" -ForegroundColor Red
    $pushOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkRed }
    Write-Host ""
    Write-Host "  Verificá que el PAT tenga scope 'repo' y no haya expirado." -ForegroundColor Yellow
    exit 1
}

# Limpiar variables sensibles de memoria
$PLAIN = $null
$pushOutput = $null
[System.GC]::Collect()
