/**
 * build-apk.cjs
 *
 * Usa @bubblewrap/core para generar el proyecto Android TWA de forma
 * no-interactiva (apto para CI). Lee la config de twa-manifest.json.
 *
 * Uso: node build-apk.cjs
 * La salida queda en ./android-project/
 */

'use strict';

const fs   = require('fs');
const path = require('path');

async function main() {
  let core;
  try {
    core = require('@bubblewrap/core');
  } catch (e) {
    console.error('ERROR: @bubblewrap/core no está instalado.');
    console.error('Ejecutá: npm install');
    process.exit(1);
  }

  const { TwaManifest, TwaGenerator } = core;

  // Leer twa-manifest.json (mismo directorio que este script)
  const manifestPath = path.join(__dirname, 'twa-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('ERROR: twa-manifest.json no encontrado en', manifestPath);
    process.exit(1);
  }
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  const targetDir = path.join(__dirname, 'android-project');

  console.log('Generando proyecto Android TWA...');
  console.log('  packageId :', manifestJson.packageId);
  console.log('  host      :', manifestJson.host);
  console.log('  startUrl  :', manifestJson.startUrl);
  console.log('  destino   :', targetDir);
  console.log('');

  let twaManifest;
  try {
    twaManifest = TwaManifest.fromJson(manifestJson);
  } catch (e) {
    console.error('ERROR al parsear twa-manifest.json:', e.message);
    process.exit(1);
  }

  const generator = new TwaGenerator();

  try {
    await generator.createTwaProject(targetDir, twaManifest);
    console.log('\n✓ Proyecto Android generado en:', targetDir);
    console.log('');
    console.log('Pasos siguientes en CI:');
    console.log('  1. Generar keystore (keytool)');
    console.log('  2. echo "sdk.dir=$ANDROID_HOME" > local.properties');
    console.log('  3. ./gradlew assembleRelease -Pandroid.injected.signing.*');
  } catch (e) {
    console.error('ERROR generando proyecto:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
