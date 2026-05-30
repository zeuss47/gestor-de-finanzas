/**
 * pdf-import.js
 * --------------
 * Parser local de recibos de sueldo argentinos en PDF.
 * Carga PDF.js bajo demanda (no es parte del precache) y extrae:
 *   - empleador (razón social arriba del recibo)
 *   - periodo_aplicacion (YYYY-MM desde "PERÍODO DE PAGO MARZO 2026")
 *   - fecha (YYYY-MM-DD desde "FECHA DE PAGO 31/03/2026")
 *   - sueldo_bruto (REM. ASIGNADA o suma de 0201+0202+0205)
 *   - sueldo_neto (TOTAL NETO)
 *   - bonos (códigos 5877/5878 no remunerativos)
 *   - descuentos por concepto (jubilación, ley 19032, obra social, sindicato)
 *
 * 100% offline una vez cargado. La primera importación trae PDF.js (~1MB).
 */

const PDFJS_VERSION = '4.0.379';
const PDFJS_URL    = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

let _pdfLib = null;

async function cargarPdfJs() {
  if (_pdfLib) return _pdfLib;
  const mod = await import(/* @vite-ignore */ PDFJS_URL);
  // Configurar worker (requerido)
  mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  _pdfLib = mod;
  return mod;
}

async function extraerTextoPdf(file) {
  const pdfjs = await cargarPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;

  const lineasPorPagina = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Agrupar items por línea (misma coordenada Y). PDF.js extrae fragmentos
    // separados con sus posiciones; sin agrupar perdemos contexto de columna.
    const filas = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round((item.transform?.[5] || 0));
      if (!filas.has(y)) filas.set(y, []);
      filas.get(y).push({
        x: item.transform?.[4] || 0,
        str: item.str,
      });
    }
    // Ordenar líneas de arriba hacia abajo (Y descendente en PDF coords)
    const lineasOrdenadas = [...filas.entries()]
      .sort(([a], [b]) => b - a)
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ').trim())
      .filter(l => l.length > 0);
    lineasPorPagina.push(...lineasOrdenadas);
  }

  return {
    texto: lineasPorPagina.join('\n'),
    lineas: lineasPorPagina,
  };
}

/* ─── Helpers de parsing ───────────────────────────────────────── */

// "1.199.671,16" → 1199671.16
function num(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
}

const MESES = {
  ENERO:'01', FEBRERO:'02', MARZO:'03', ABRIL:'04', MAYO:'05', JUNIO:'06',
  JULIO:'07', AGOSTO:'08', SEPTIEMBRE:'09', OCTUBRE:'10', NOVIEMBRE:'11', DICIEMBRE:'12'
};

function buscarMontoCodigo(lineas, codigo, conceptoPat) {
  // Recibos arg: línea típica "0401 JUBILACION 165.302,21" o columnar.
  // El concepto se envuelve en (?:...) para que las alternativas (|) no rompan
  // la estructura del regex completo.
  const cs = typeof conceptoPat === 'string' ? conceptoPat : conceptoPat.source;
  const re = new RegExp(`\\b${codigo}\\b[\\s\\S]{0,80}?(?:${cs})[\\s\\S]{0,80}?([\\d.]+,\\d{2})`, 'i');
  for (const linea of lineas) {
    const m = linea.match(re);
    if (m && m[1]) return num(m[1]);
  }
  // Fallback: buscar el código y tomar el primer monto positivo que aparezca después
  for (const linea of lineas) {
    if (new RegExp(`\\b${codigo}\\b`).test(linea)) {
      const m = linea.match(/(?<!-)([\d]{1,3}(?:\.[\d]{3})*,\d{2})/);
      if (m) return num(m[1]);
    }
  }
  return 0;
}

function buscarTotalNeto(texto, lineas) {
  // "TOTAL NETO → 1.451.806,86" (con flecha, dos puntos, o nada en medio)
  const reTotal = /TOTAL\s+NETO\s*[→>:\-\s]*([\d]{1,3}(?:\.[\d]{3})*,\d{2})/i;
  const m1 = texto.match(reTotal);
  if (m1) return num(m1[1]);

  // Fallback: si en la línea "IMPORTE EN LETRAS" o cerca hay un monto, tomarlo
  const idxImp = lineas.findIndex(l => /IMPORTE\s+EN\s+LETRAS/i.test(l));
  if (idxImp > 0) {
    for (let i = Math.max(0, idxImp - 3); i <= Math.min(lineas.length - 1, idxImp + 1); i++) {
      const m = lineas[i].match(/([\d]{1,3}(?:\.[\d]{3})*,\d{2})/);
      if (m) return num(m[1]);
    }
  }
  return 0;
}

function buscarFechaPago(texto) {
  // "FECHA DE PAGO 31/03/2026"
  const m = texto.match(/FECHA\s+DE\s+PAGO[\s\S]{0,40}?(\d{2})\/(\d{2})\/(\d{4})/i);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Cualquier fecha dd/mm/yyyy en el documento
  const m2 = texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return '';
}

function buscarPeriodoPago(texto) {
  const limpiarMes = (s) => s.toUpperCase().replace(/[ÁÉÍÓÚ]/g, c => 'AEIOU'['ÁÉÍÓÚ'.indexOf(c)]);

  // "PERÍODO DE PAGO ... MARZO 2026" — ventana amplia porque el layout columnar
  // del PDF mete fechas y otras cosas entre el header y el valor.
  const m = texto.match(/PER[ÍI]ODO\s+DE\s+PAGO[\s\S]{0,120}?\b([A-ZÁÉÍÓÚ]{4,})\s+(\d{4})\b/i);
  if (m) {
    const mm = MESES[limpiarMes(m[1])];
    if (mm) return `${m[2]}-${mm}`;
  }
  // Patrón directo "MES YYYY" en cualquier parte del documento (primera coincidencia válida)
  const re = /\b([A-ZÁÉÍÓÚ]{4,})\s+(\d{4})\b/gi;
  let mm;
  while ((mm = re.exec(texto)) !== null) {
    const mes = MESES[limpiarMes(mm[1])];
    if (mes) return `${mm[2]}-${mes}`;
  }
  return '';
}

function buscarEmpleador(lineas) {
  // El empleador suele ser la primera o segunda línea (antes de "CUIT")
  for (let i = 0; i < Math.min(5, lineas.length); i++) {
    const l = lineas[i].trim();
    // Saltear líneas muy cortas o que sean CUIT/dirección
    if (l.length < 5) continue;
    if (/^CUIT/i.test(l)) continue;
    // Razón social: contiene letras y posiblemente S.R.L./S.A./EIRL
    if (/^[A-ZÁÉÍÓÚÑ&.,\s]+(?:S\.?R\.?L\.?|S\.?A\.?|EIRL)?\.?$/i.test(l) && /[A-Z]/i.test(l)) {
      return l.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function buscarSueldoBruto(texto, lineas) {
  // Patrón 1: "REM. ASIGNADA  1.199.671,16" (suele estar arriba)
  const m = texto.match(/REM\.\s*ASIGNADA[\s\S]{0,200}?([\d]{1,3}(?:\.[\d]{3})*,\d{2})/i);
  if (m) return num(m[1]);

  // Patrón 2: sumar conceptos remunerativos típicos
  const sueldo  = buscarMontoCodigo(lineas, '0201', 'SUELDO');
  const antig   = buscarMontoCodigo(lineas, '0202', 'ANTIG[UÜ]EDAD');
  const presen  = buscarMontoCodigo(lineas, '0205', 'PRESENTISMO');
  return sueldo + antig + presen;
}

function buscarBonos(lineas) {
  // Códigos 5877 ASIGNAC.NO REMUN, 5878 GRATIF EXTRAOR son bonos típicos
  let total = 0;
  total += buscarMontoCodigo(lineas, '5877', 'ASIGNAC|NO\\s*REMUN');
  total += buscarMontoCodigo(lineas, '5878', 'GRATIF|EXTRAOR');
  total += buscarMontoCodigo(lineas, '0289', 'ASIGN');
  return total;
}

/* ─── API pública ─────────────────────────────────────────────── */

export async function parsearRecibo(file) {
  const { texto, lineas } = await extraerTextoPdf(file);

  const resultado = {
    empleador:           buscarEmpleador(lineas),
    fecha:               buscarFechaPago(texto),
    periodo_aplicacion:  buscarPeriodoPago(texto),
    sueldo_bruto:        buscarSueldoBruto(texto, lineas),
    sueldo_neto:         buscarTotalNeto(texto, lineas),
    bonos:               buscarBonos(lineas),
    descuentos: {
      jubilacion:        buscarMontoCodigo(lineas, '0401', 'JUBILACI[OÓ]N'),
      ley_19032:         buscarMontoCodigo(lineas, '0402', 'LEY\\s+19032'),
      obra_social:       buscarMontoCodigo(lineas, '0405', 'LEY\\s+23660|OBRA\\s+SOCIAL'),
      sindicato:         buscarMontoCodigo(lineas, '0421', 'CUOTA\\s+SINDICAL|SINDICATO'),
    },
    _raw: { texto, lineas },
  };

  // Validación mínima: si no encontramos el TOTAL NETO, devolvemos error claro
  if (!resultado.sueldo_neto) {
    throw new Error('No se pudo detectar el "TOTAL NETO" en el PDF. Verificá que sea un recibo de sueldo estándar.');
  }
  return resultado;
}
