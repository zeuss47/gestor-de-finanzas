'use strict';

const fs   = require('fs');
const path = require('path');

async function main() {
  let core;
  try {
    core = require('@bubblewrap/core');
  } catch (e) {
    console.error('ERROR: @bubblewrap/core no instalado. Ejecuta: npm install');
    process.exit(1);
  }

  const { TwaManifest, TwaGenerator, ConsoleLog } = core;

  const manifestPath = path.join(__dirname, 'twa-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('ERROR: twa-manifest.json no encontrado en', manifestPath);
    process.exit(1);
  }

  const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const targetDir    = path.join(__dirname, 'android-project');

  console.log('Generando proyecto Android TWA...');
  console.log('  packageId:', manifestData.packageId);
  console.log('  host     :', manifestData.host);
  console.log('  startUrl :', manifestData.startUrl);
  console.log('  destino  :', targetDir);

  let twaManifest;
  try {
    twaManifest = new TwaManifest(manifestData);
  } catch (e) {
    console.error('ERROR al crear TwaManifest:', e.message);
    process.exit(1);
  }

  // Validar antes de generar
  const validationError = twaManifest.validate();
  if (validationError) {
    console.error('Manifest inválido:', validationError);
    process.exit(1);
  }

  const log       = new ConsoleLog(false);
  const generator = new TwaGenerator();

  try {
    await generator.createTwaProject(targetDir, twaManifest, log);
    console.log('\n✓ Proyecto Android generado en:', targetDir);
  } catch (e) {
    console.error('ERROR generando proyecto:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
