# 🔄 Auto-sync de código

Este repo tiene **auto-push** configurado: cada cambio que Claude hace en la app se sube automáticamente a `main` y se redeploya en GitHub Pages en ~1-2 minutos.

## Cómo funciona

1. Claude edita archivos (Write/Edit)
2. Al finalizar el turno, el hook `Stop` dispara `auto-push.ps1`
3. El script hace `git add . && git commit && git push` con un mensaje auto-generado
4. GitHub Pages rebuilda y publica la nueva versión

## Mensaje de commit auto-generado

```
auto-update 2026-05-29 14:30 · index.html, js/app.js, css/styles.css
```

## Log de pushes

Para revisar qué se commiteó automáticamente:
```powershell
Get-Content "$env:TEMP\claude-autopush.log"
```

## Desactivar temporalmente

Si querés que Claude NO empuje cambios automáticamente, decile **"no pushees nada"** o **"trabajemos en local"**, y editá el hook en `~/.claude/projects/...claude.../settings.local.json`.
