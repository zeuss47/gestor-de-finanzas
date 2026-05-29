# ════════════════════════════════════════════════════════════════
# Deploy automatizado a GitHub Pages
# ════════════════════════════════════════════════════════════════
# Uso: .\deploy.ps1
# Requisitos: git instalado, usuario configurado en git config --global
# ════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"
$REPO_NAME = "gestor-de-finanzas"
$DATA_REPO_NAME = "datafinance"

# Color helpers
function Info($msg)    { Write-Host "  $msg" -ForegroundColor Cyan }
function Success($msg) { Write-Host "  $msg" -ForegroundColor Green }
function WarnY($msg)   { Write-Host "  $msg" -ForegroundColor Yellow }
function ErrR($msg)    { Write-Host "  $msg" -ForegroundColor Red }
function Title($msg)   { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Magenta }

# Obtener usuario de git
$GH_USER = git config --global user.name
if (-not $GH_USER) {
    ErrR "ERROR: git config --global user.name no esta configurado"
    Write-Host "  Ejecuta: git config --global user.name 'tu-usuario-github'"
    exit 1
}

Title "Pre-deploy"
Info "Usuario git: $GH_USER"
Info "Repo codigo: $REPO_NAME"
Info "Repo datos:  $DATA_REPO_NAME"
Info "Directorio:  $PWD"

# ─── 1. Verificar que estamos en frontend/ ─────────────────────────
if (-not (Test-Path ".\index.html")) {
    ErrR "ERROR: No se encontro index.html. Ejecuta este script desde la carpeta frontend\"
    exit 1
}

# ─── 2. Pedir el PAT ─────────────────────────────────────────────
Title "Personal Access Token"
WarnY "Necesitas un PAT de GitHub con scope 'repo'."
WarnY "Si no tenes uno: https://github.com/settings/tokens/new?scopes=repo&description=finanzas-deploy"
Write-Host ""
$PAT = Read-Host "Pega tu PAT (no se va a mostrar)" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($PAT)
$PAT_PLAIN = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if (-not $PAT_PLAIN -or $PAT_PLAIN.Length -lt 20) {
    ErrR "ERROR: PAT invalido o vacio"
    exit 1
}

# ─── 3. Crear los 2 repos via API ─────────────────────────────────
Title "Creando repos en GitHub"

$headers = @{
    "Authorization" = "token $PAT_PLAIN"
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "deploy-script"
}

function CreateRepo($name, $description, $private) {
    Info "Creando repo: $name (private: $private)"
    $body = @{
        name        = $name
        description = $description
        private     = $private
        auto_init   = $true
    } | ConvertTo-Json

    try {
        $r = Invoke-WebRequest -Uri "https://api.github.com/user/repos" `
            -Method POST -Headers $headers -Body $body -ContentType "application/json" `
            -UseBasicParsing -ErrorAction Stop
        Success "Repo $name creado"
        return $true
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 422) {
            WarnY "El repo $name ya existe, continuamos..."
            return $true
        }
        ErrR "Error creando ${name}: $_"
        return $false
    }
}

$ok1 = CreateRepo $REPO_NAME "PWA cyberpunk de gestion de finanzas personales con IA local y sync GitHub" $false
$ok2 = CreateRepo $DATA_REPO_NAME "Storage privado de datos para gestor-de-finanzas" $true

if (-not $ok1 -or -not $ok2) {
    ErrR "No se pudo crear alguno de los repos. Aborto."
    exit 1
}

# ─── 4. Init + commit + push del codigo ───────────────────────────
Title "Subiendo codigo a $REPO_NAME"

# Limpiar .git si existe
if (Test-Path ".\.git") {
    WarnY "Existe .git previo, lo borramos para empezar limpio"
    Remove-Item -Recurse -Force ".\.git"
}

git init -q
git checkout -b main -q 2>$null
git add .
git commit -q -m "feat: gestor de finanzas cyberpunk PWA inicial

- Dashboard con 14 widgets redimensionables
- Cuentas bancarias + tarjetas con motor de ciclos
- IA predictiva de balance futuro + saturacion de tarjetas
- Sync automatico con GitHub (5 disparadores)
- 100% offline-first con IndexedDB
- Tema cyberpunk con glassmorphism"

# Configurar remote y push usando PAT (sin guardar en el repo)
$REPO_URL = "https://$GH_USER`:$PAT_PLAIN@github.com/$GH_USER/$REPO_NAME.git"
git remote add origin $REPO_URL
Info "Pusheando a main..."
git push -u origin main --force-with-lease -q 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    # Reintentar con --force si --force-with-lease falla por ref nuevo
    git push -u origin main --force -q
}

# Eliminar el remote con PAT y guardar uno limpio
git remote set-url origin "https://github.com/$GH_USER/$REPO_NAME.git"

Success "Codigo subido a github.com/$GH_USER/$REPO_NAME"

# ─── 5. Habilitar GitHub Pages via API ────────────────────────────
Title "Habilitando GitHub Pages"

$pagesBody = @{
    source = @{
        branch = "main"
        path   = "/"
    }
} | ConvertTo-Json -Depth 3

try {
    Invoke-WebRequest -Uri "https://api.github.com/repos/$GH_USER/$REPO_NAME/pages" `
        -Method POST -Headers $headers -Body $pagesBody -ContentType "application/json" `
        -UseBasicParsing -ErrorAction Stop | Out-Null
    Success "GitHub Pages habilitado"
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 409) {
        WarnY "GitHub Pages ya estaba habilitado"
    } else {
        WarnY "No pude habilitar Pages automaticamente. Activalo manualmente en:"
        WarnY "https://github.com/$GH_USER/$REPO_NAME/settings/pages"
        WarnY "Source = main / (root)"
    }
}

# ─── 6. Resumen final ────────────────────────────────────────────
Title "DEPLOY COMPLETO"
Write-Host ""
Success "Codigo: https://github.com/$GH_USER/$REPO_NAME"
Success "Datos:  https://github.com/$GH_USER/$DATA_REPO_NAME (privado)"
Write-Host ""
Info "URL de la app (puede tardar 1-2 min en estar online):"
Write-Host ""
Write-Host "  https://$GH_USER.github.io/$REPO_NAME/" -ForegroundColor Yellow -BackgroundColor DarkBlue
Write-Host ""
Info "Para sincronizar tus datos:"
Info "1. Abri la app en el link de arriba"
Info "2. Ajustes -> Sync"
Info "3. PAT: (el mismo que usaste aca)"
Info "4. Usuario: $GH_USER"
Info "5. Repo: $DATA_REPO_NAME"
Info "6. Tocar 'Probar conexion y sincronizar'"
Write-Host ""
WarnY "El PAT que ingresaste NO se guardo en ningun archivo de este repo."
WarnY "Si lo vas a usar en otros dispositivos, manten el mismo PAT a mano."
Write-Host ""
