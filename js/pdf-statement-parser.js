/**
 * pdf-statement-parser.js
 * ─────────────────────────
 * Parser de resúmenes de tarjeta de crédito argentinos en PDF.
 *
 * Soporta los dos formatos de fecha más comunes:
 *   - Banco Macro:  "04.05.26"   (DD.MM.YY con puntos)
 *   - Banco BBVA:   "23-Ene-26"  (DD-MMM-YY con mes abreviado en español)
 *   - Genérico:     "14/03/26" o "14/03" (DD/MM con barras)
 *
 * Extrae: período, banco, fecha de cierre, fecha de vencimiento, saldo total,
 * pago mínimo, total de consumos (para validación) y la lista de movimientos
 * (consumos), filtrando pagos, impuestos, comisiones e intereses.
 *
 * Reutiliza extraerTextoPdf() y num() de pdf-import.js.
 */

import { extraerTextoPdf, num } from './pdf-import.js';

/* ─── Constantes ───────────────────────────────────────────── */

const MESES_ABR = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', SET: '09', OCT: '10', NOV: '11', DIC: '12',
};

// Bancos conocidos para etiquetar (se detecta por keyword en el texto).
const BANCOS = [
  { re: /\bMACRO\b/i,        nombre: 'Banco Macro' },
  { re: /\bBBVA\b/i,         nombre: 'BBVA' },
  { re: /\bGALICIA\b/i,      nombre: 'Banco Galicia' },
  { re: /\bSANTANDER\b/i,    nombre: 'Santander' },
  { re: /\bICBC\b/i,         nombre: 'ICBC' },
  { re: /\bHSBC\b/i,         nombre: 'HSBC' },
  { re: /\bNACION\b/i,       nombre: 'Banco Nación' },
  { re: /\bCREDICOOP\b/i,    nombre: 'Credicoop' },
  { re: /\bBRUBANK\b/i,      nombre: 'Brubank' },
  { re: /\bUALA\b/i,         nombre: 'Ualá' },
  { re: /\bNARANJA\b/i,      nombre: 'Naranja X' },
];

// Líneas que NO son consumos: pagos, impuestos, comisiones, saldos, resúmenes.
const EXCLUIR = [
  /SALDO\s+ANTERIOR/i,
  /SALDO\s+ACTUAL/i,
  /SU\s+PAGO/i,
  /DEV\.?\s*IMP/i,
  /\bCR\.?\s*RG/i,
  /\bDB\.?\s*RG/i,
  /\bDB\s+IVA/i,
  /\bIVA\s+RG/i,
  /\bIVA\s+\d/i,
  /COMISION/i,
  /COMISIÓN/i,
  /TOTAL\s+CONSUMOS/i,
  /PAGO\s+M[IÍ]NIMO/i,
  /TOTAL\s+DE\s+CUOTAS/i,
  /CUOTAS?\s+A\s+VENCER/i,
  /\bIMP\.?\s*LEY/i,
  /PERCEP/i,
  /SEGURO\s+DE\s+VIDA/i,
  /CARGO\s+FINANC/i,
  /INTERESES?\s+(?:POR|DE|FINANC|PUNIT|COMPENS)/i,
];

/* ─── Helpers de fecha y números ───────────────────────────── */

function quitarTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function pad2(s) { return String(s).padStart(2, '0'); }
function anio4(s) { const n = parseInt(s, 10); return n < 100 ? 2000 + n : n; }
function normMes(s) { return quitarTildes(s).toUpperCase().slice(0, 3); }

/**
 * Parsea un token de fecha suelto en cualquiera de los formatos soportados.
 * Devuelve 'YYYY-MM-DD' o null.
 */
function parsearFechaToken(str) {
  if (!str) return null;
  let m;
  // DD-Mon-YY / DD Mon YY  (BBVA, headers Macro): 23-Ene-26, 21 May 26
  m = str.match(/(\d{1,2})[-\s.]([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4})[-\s.](\d{2,4})/);
  if (m) {
    const mm = MESES_ABR[normMes(m[2])];
    if (mm) return `${anio4(m[3])}-${mm}-${pad2(m[1])}`;
  }
  // DD.MM.YY  (Macro): 04.05.26
  m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) return `${anio4(m[3])}-${pad2(m[2])}-${pad2(m[1])}`;
  // DD/MM/YY  (genérico con año)
  m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${anio4(m[3])}-${pad2(m[2])}-${pad2(m[1])}`;
  return null;
}

/**
 * Extrae la fecha al inicio de una línea de movimiento + el resto del texto.
 * Devuelve { fecha:'YYYY-MM-DD', resto } o, para DD/MM sin año,
 * { fecha:null, dia, mes, resto } para resolver el año por el ciclo.
 */
function extraerFechaInicio(linea) {
  let m;
  // DD-Mon-YY (BBVA)
  m = linea.match(/^\s*(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4})-(\d{2,4})\s+(.*)$/);
  if (m) {
    const mm = MESES_ABR[normMes(m[2])];
    if (mm) return { fecha: `${anio4(m[3])}-${mm}-${pad2(m[1])}`, resto: m[4] };
  }
  // DD.MM.YY (Macro)
  m = linea.match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(.*)$/);
  if (m) return { fecha: `${anio4(m[3])}-${pad2(m[2])}-${pad2(m[1])}`, resto: m[4] };
  // DD/MM/YY o DD/MM (genérico)
  m = linea.match(/^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.*)$/);
  if (m) {
    const anioParcial = m[3] ? anio4(m[3]) : null;
    return { fecha: null, dia: m[1], mes: m[2], anioParcial, resto: m[4] };
  }
  return null;
}

/* ─── Extracción de monto + moneda + descripción ───────────── */

// Sin \b inicial a propósito: BBVA pega el código de moneda a la referencia del
// consumo (ej "in1TTXjpBUSD 20,00" en CLAUDE.AI). Exigimos que el monto venga
// inmediatamente después para no confundir nombres que casualmente traigan "USD".
const RE_FX = /(USD|EUR|BRL|U\$S|U\$D)\s*([\d]{1,3}(?:\.[\d]{3})*,\d{2})(-?)/i;
const RE_AMT = /(\d{1,3}(?:\.\d{3})*,\d{2})(-?)/g;
// Fecha completa DD-Mon-YY / DD.MM.YY / DD/MM/YYYY. La usamos para detectar que
// la "descripción" de un consumo contiene una 2ª fecha → es una fila de la tabla
// de totales (cierre/venc/saldo) que se coló, no un consumo real.
const RE_FULLDATE = /\b\d{1,2}[-.\/](?:[A-Za-z]{3,4}|\d{1,2})[-.\/]\d{2,4}\b/;

// Un importe argentino: o bien con separador de miles (1.234,56) o bien plano
// (1234,56). Macro es inconsistente y usa las dos variantes en el mismo PDF.
const NUMERO = String.raw`(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}`;
// Un TOKEN que es sólo un importe (con prefijo $/U$S y signo - adelante/atrás
// o paréntesis opcionales). Sirve para detectar la celda de monto por posición.
const RE_MONTO_TOKEN = new RegExp(`^\\(?\\s*-?\\s*(?:U\\$[SD]|USD|\\$)?\\s*(${NUMERO})\\s*(-?)\\)?$`, 'i');

/**
 * Convierte un importe impreso (formato AR) a número con signo. Maneja:
 *  - signo '-' adelante (BBVA: '-973.072,63') o atrás (Macro: '360.197,23-')
 *  - paréntesis como negativo: '( 45185,87 )'
 *  - prefijos '$' / 'U$S' / 'USD'
 *  - separador de miles inconsistente ('360.197,23' y '360197,23')
 */
export function parsearMonto(s) {
  if (s == null) return null;
  let t = String(s).trim();
  let neg = false;
  if (t.endsWith('-'))   { neg = true; t = t.slice(0, -1).trim(); }
  if (t.startsWith('-')) { neg = true; t = t.slice(1).trim(); }
  if (t.startsWith('(') && t.endsWith(')')) { neg = true; t = t.slice(1, -1).trim(); }
  t = t.replace(/U\$[SD]|USD|\$/gi, '').trim();
  t = t.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(t);
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

function normalizarMoneda(s) {
  const u = s.toUpperCase();
  if (u === 'U$S' || u === 'U$D') return 'USD';
  return u;
}

/**
 * De "resto" (texto tras la fecha) saca el monto, la moneda y la descripción
 * cruda (sin limpiar comprobantes ni cuotas todavía).
 * Devuelve null si no hay monto, o { credito:true } si es un crédito/pago.
 */
function extraerMontoDesc(resto) {
  // 1. ¿Hay moneda extranjera? (consumos en USD/EUR/BRL)
  const fx = resto.match(RE_FX);
  if (fx) {
    if (fx[3] === '-') return { credito: true };        // pago/devolución en USD
    return {
      monto: num(fx[2]),
      moneda: normalizarMoneda(fx[1]),
      descRaw: resto.slice(0, fx.index).trim(),
    };
  }
  // 2. Montos en pesos: tomamos el ÚLTIMO (columna PESOS está a la derecha)
  const amts = [...resto.matchAll(RE_AMT)];
  if (!amts.length) return null;
  const last = amts[amts.length - 1];
  if (last[2] === '-') return { credito: true };         // crédito/pago/devolución
  return {
    monto: num(last[1]),
    moneda: 'ARS',
    descRaw: resto.slice(0, last.index).trim(),
  };
}

/**
 * Limpia la descripción cruda: quita comprobante (líder o final), cuotas,
 * y extrae info de cuotas si existe (Cuota 04/12 ó C.04/09).
 */
function limpiarDesc(descRaw) {
  let d = descRaw;
  let cuotaActual = null, cuotasTotal = null;

  // Cuotas: "Cuota 04/12", "C.04/09", "C 04/06"
  const cm = d.match(/\b(?:CUOTA|C)\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/i);
  if (cm) {
    cuotaActual = parseInt(cm[1], 10);
    cuotasTotal = parseInt(cm[2], 10);
    d = d.replace(cm[0], ' ');
  }
  // Comprobante líder (Macro): 4-8 dígitos + opcional * o letra. Ej "689452K", "008592*"
  d = d.replace(/^\s*\d{4,8}[*A-Za-z]?\s+/, '');
  // Comprobante/cupón al final (BBVA): 4-8 dígitos. Ej "...RODR 173212"
  d = d.replace(/\s+\d{4,8}\s*$/, '');
  // Referencia alfanumérica pegada (BBVA consumos USD): un token final que
  // mezcla letras y dígitos (ej "in1TTXjpB", resto de "in1TTXjpBUSD"). No es
  // parte del comercio, es el identificador de la operación.
  const ref = d.match(/\s+([A-Za-z0-9]{5,})$/);
  if (ref && /[A-Za-z]/.test(ref[1]) && /\d/.test(ref[1])) d = d.slice(0, ref.index);
  // Limpieza final
  d = d.replace(/\s{2,}/g, ' ').trim();
  return { desc: d, cuotaActual, cuotasTotal };
}

function esExcluido(s) {
  return EXCLUIR.some(re => re.test(s));
}

/**
 * Parsea una línea individual. Devuelve un movimiento o null.
 */
function parsearLinea(linea, ctx) {
  const f = extraerFechaInicio(linea);
  if (!f) return null;

  const md = extraerMontoDesc(f.resto);
  if (!md || md.credito || !(md.monto > 0)) return null;

  // Filtro de pagos/impuestos sobre el texto completo y la descripción
  if (esExcluido(f.resto)) return null;

  // Una 2ª fecha completa en lo que sería la descripción delata una fila de la
  // tabla de totales (ej "05-Jun-26 888.286,87 31,99") → no es un consumo.
  if (RE_FULLDATE.test(md.descRaw)) return null;

  const { desc, cuotaActual, cuotasTotal } = limpiarDesc(md.descRaw);
  // Un consumo real siempre tiene letras en el comercio. Una fila de totales
  // que se cuele (ej "888.286,87 31,99") queda como puros números → se descarta.
  if (!desc || desc.length < 2 || !/[A-Za-z]/.test(desc) || esExcluido(desc)) return null;

  // Resolver año para DD/MM sin año explícito
  let fecha = f.fecha;
  if (!fecha && f.dia) {
    const mesMov = parseInt(f.mes, 10);
    let anio = f.anioParcial;
    if (!anio) {
      anio = (ctx.mesCierre && mesMov > ctx.mesCierre) ? ctx.anioCierre - 1 : ctx.anioCierre;
    }
    fecha = `${anio}-${pad2(f.mes)}-${pad2(f.dia)}`;
  }

  const mov = { fecha, descripcion: desc, monto: md.monto, moneda: md.moneda };
  if (cuotasTotal) { mov.cuotaActual = cuotaActual; mov.cuotasTotal = cuotasTotal; }
  return mov;
}

/* ─── Extracción de consumos POR POSICIÓN (la regla de oro) ── */

/** Valor más repetido dentro de una lista numérica, con tolerancia. */
function _modoConTolerancia(valores, tol) {
  if (!valores.length) return null;
  let best = null, bestCount = -1;
  for (const v of valores) {
    const count = valores.filter(x => Math.abs(x - v) <= tol).length;
    if (count > bestCount) { bestCount = count; best = v; }
  }
  return best;
}

/**
 * Lee los consumos tratando el PDF como una GRILLA: cada fila que empieza con
 * una fecha es una transacción; la celda de monto se elige por su POSICIÓN
 * (la de mayor x1 = borde derecho, alineada a la columna), y la moneda se
 * decide por esa misma coordenada (columna DÓLARES está a la derecha de PESOS).
 *
 * Esto resuelve de raíz tres problemas que el texto plano no puede:
 *  - montos que aparecen 2 veces (uno embebido en la descripción, otro en la
 *    columna) → tomamos el de la columna (x1 mayor).
 *  - separar pesos de dólares aunque el consumo no diga "USD" en el texto.
 *  - la base de un impuesto entre paréntesis queda en la descripción y se ignora.
 *
 * @param {Array<{y:number,words:Array<{x0:number,x1:number,str:string}>}>} filas
 */
function _extraerConsumosPorPosicion(filas, ctx) {
  // 1) Filas-transacción (empiezan con fecha) + sus importes con x1
  const trans = [];
  for (const fila of filas) {
    const ws = fila.words || [];
    if (!ws.length) continue;

    let fecha = parsearFechaToken(ws[0].str);
    let start = 1, dm = null;
    if (!fecha && ws.length >= 3) {                    // "21 May 26" en 3 tokens
      const f3 = parsearFechaToken(`${ws[0].str} ${ws[1].str} ${ws[2].str}`);
      if (f3) { fecha = f3; start = 3; }
    }
    if (!fecha) {
      dm = ws[0].str.match(/^(\d{1,2})\/(\d{1,2})$/);  // DD/MM sin año
      if (!dm) continue;
    }

    const amounts = [];
    ws.forEach((w, i) => {
      if (RE_MONTO_TOKEN.test(w.str)) {
        amounts.push({ x1: w.x1, valor: parsearMonto(w.str), idx: i });
      }
    });
    if (!amounts.length) continue;

    const firstIdx = Math.min(...amounts.map(a => a.idx));
    const colAmt   = amounts.reduce((a, b) => (b.x1 > a.x1 ? b : a)); // celda = la más a la derecha
    const descRaw  = ws.slice(start, firstIdx).map(w => w.str).join(' ').trim();
    const rowText  = ws.map(w => w.str).join(' ');
    trans.push({ fecha, dm, descRaw, rowText, colAmt });
  }
  if (!trans.length) return [];

  // 2) Calibrar el borde de la columna PESOS = x1 dominante de las celdas de
  //    monto (la mayoría de los consumos son en pesos). DÓLARES está más a la
  //    derecha, así que una celda con x1 >> pesosEdge es un consumo en USD.
  const pesosEdge = _modoConTolerancia(trans.map(t => t.colAmt.x1), 6);

  // 3) Construir movimientos aplicando los mismos filtros que el modo texto
  const movs = [];
  for (const t of trans) {
    if (esExcluido(t.rowText)) continue;
    if (RE_FULLDATE.test(t.descRaw)) continue;          // fila de totales colada
    const valor = t.colAmt.valor;
    if (!(valor > 0)) continue;                         // pagos/créditos (negativos)

    const porPosicion = pesosEdge != null && t.colAmt.x1 > pesosEdge + 12;
    const porMarca    = /(?:USD|U\$[SD])\s*\d/i.test(t.rowText);
    const moneda = (porPosicion || porMarca) ? 'USD' : 'ARS';

    const { desc, cuotaActual, cuotasTotal } = limpiarDesc(t.descRaw);
    if (!desc || desc.length < 2 || !/[A-Za-z]/.test(desc) || esExcluido(desc)) continue;

    let fecha = t.fecha;
    if (!fecha && t.dm) {
      const mesMov = parseInt(t.dm[2], 10);
      const anio = (ctx.mesCierre && mesMov > ctx.mesCierre) ? ctx.anioCierre - 1 : ctx.anioCierre;
      fecha = `${anio}-${pad2(t.dm[2])}-${pad2(t.dm[1])}`;
    }

    const mov = { fecha, descripcion: desc, monto: valor, moneda };
    if (cuotasTotal) { mov.cuotaActual = cuotaActual; mov.cuotasTotal = cuotasTotal; }
    movs.push(mov);
  }
  return movs;
}

/* ─── Búsqueda de campos del header ────────────────────────── */

function buscarFechaLabel(texto, labels) {
  for (const label of labels) {
    const re = new RegExp(
      label + '[\\s\\S]{0,80}?(\\d{1,2})[-\\s.]([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4}|\\d{1,2})[-\\s.](\\d{2,4})',
      'i'
    );
    const m = texto.match(re);
    if (m) {
      // El grupo 2 puede ser mes-nombre o mes-número
      let mm;
      if (/^\d+$/.test(m[2])) mm = pad2(m[2]);
      else mm = MESES_ABR[normMes(m[2])];
      if (mm) return `${anio4(m[3])}-${mm}-${pad2(m[1])}`;
    }
  }
  return '';
}

function buscarMontoLabel(texto, labels) {
  for (const label of labels) {
    const re = new RegExp(label + '[^0-9\\-]{0,30}(\\d{1,3}(?:\\.\\d{3})*,\\d{2})', 'i');
    const m = texto.match(re);
    if (m) return num(m[1]);
  }
  return 0;
}

/**
 * Busca un monto en layout TABLA: la etiqueta va en una fila y los valores en
 * la siguiente. `cual` = 'first' (primera columna $) o 'last' (última, p.ej.
 * "PAGO MÍNIMO $" que en BBVA es la columna más a la derecha).
 */
function buscarMontoTabla(lineas, etiqueta, cual = 'last') {
  const RE = /(\d{1,3}(?:\.\d{3})*,\d{2})/g;
  for (let i = 0; i < lineas.length; i++) {
    if (!etiqueta.test(lineas[i])) continue;
    for (let j = i; j <= Math.min(i + 1, lineas.length - 1); j++) {
      const linea = j === i ? lineas[i].slice(lineas[i].search(etiqueta)) : lineas[j];
      const ms = [...linea.matchAll(RE)].map(m => num(m[1]));
      if (ms.length) return cual === 'first' ? ms[0] : ms[ms.length - 1];
    }
  }
  return 0;
}

function buscarTotalConsumos(texto) {
  const m = texto.match(/TOTAL\s+CONSUMOS[^0-9]*?(\d{1,3}(?:\.\d{3})*,\d{2})/i);
  return m ? num(m[1]) : 0;
}

/**
 * Total de consumos en USD impreso. En la línea "TOTAL CONSUMOS ... 857.352,71
 * 31,99" el primero es pesos y el segundo (último) es dólares. Si sólo hay uno,
 * no hubo consumos en USD (devuelve 0).
 */
function buscarTotalConsumosUSD(texto, lineas) {
  const linea = (lineas || []).find(l => /TOTAL\s+CONSUMOS/i.test(l))
    || (texto.match(/TOTAL\s+CONSUMOS[^\n]*/i)?.[0] ?? '');
  const nums = [...linea.matchAll(/(\d{1,3}(?:\.\d{3})*,\d{2})/g)];
  return nums.length >= 2 ? num(nums[nums.length - 1][1]) : 0;
}

function detectarBanco(texto) {
  // Contamos ocurrencias en vez de tomar el primer match: un resumen BBVA
  // menciona "BBVA" en cada pie de página, pero también nombra a otros bancos
  // una sola vez (p.ej. la tabla comparativa "Primeras 10 entidades" lista
  // "BANCO MACRO S.A.", "GALICIA", "SANTANDER"...). El emisor real es el que
  // más se repite a lo largo del resumen.
  let mejor = { nombre: 'Banco', n: 0 };
  for (const b of BANCOS) {
    const matches = texto.match(new RegExp(b.re.source, 'gi'));
    const n = matches ? matches.length : 0;
    if (n > mejor.n) mejor = { nombre: b.nombre, n };
  }
  return mejor.nombre;
}

/**
 * Extrae fechas de un layout de TABLA donde las etiquetas van en una fila y
 * los valores en la siguiente (así agrupa PDF.js por coordenada Y). Busca una
 * línea que contenga TODAS las etiquetas dadas y devuelve las fechas de esa
 * línea y/o las siguientes en orden posicional (1ª columna → 1ª fecha).
 */
function buscarFechasTabla(lineas, etiquetas) {
  const RE_FECHA = /(\d{1,2})[-\s.]([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4}|\d{1,2})[-\s.](\d{2,4})/g;
  for (let i = 0; i < lineas.length; i++) {
    if (!etiquetas.every((re) => re.test(lineas[i]))) continue;
    const fechas = [];
    for (let j = i; j <= Math.min(i + 2, lineas.length - 1); j++) {
      for (const m of lineas[j].matchAll(RE_FECHA)) {
        const mm = /^\d+$/.test(m[2]) ? pad2(m[2]) : MESES_ABR[normMes(m[2])];
        if (mm) fechas.push(`${anio4(m[3])}-${mm}-${pad2(m[1])}`);
      }
      if (j > i && fechas.length >= etiquetas.length) break;
    }
    if (fechas.length >= etiquetas.length) return fechas;
  }
  return [];
}

/* ─── Parser principal (testeable sin PDF) ─────────────────── */

/**
 * Parsea el resultado de extraerTextoPdf ({ texto, lineas }).
 * Separado de parsearResumenTarjeta() para poder testear sin un PDF real.
 */
export function _parsearTexto({ texto, lineas, filas }) {
  const banco = detectarBanco(texto);

  // ── Fechas de cierre y vencimiento ──────────────────────────
  // Layout TABLA (BBVA): "CIERRE ACTUAL  VENCIMIENTO ACTUAL ..." en una fila y
  // "28-May-26  05-Jun-26 ..." en la siguiente. Mapeamos por posición de columna
  // para no confundir el vencimiento con el valor del cierre.
  let fechaCierre = '', fechaVencimiento = '';
  const actuales = buscarFechasTabla(lineas, [/CIERRE\s+ACTUAL/i, /VENCIMIENTO\s+ACTUAL/i]);
  if (actuales.length >= 2) {
    fechaCierre = actuales[0];
    fechaVencimiento = actuales[1];
  } else {
    // Layout vertical (Macro): etiqueta y valor en líneas separadas.
    fechaCierre = buscarFechaLabel(texto, ['CIERRE\\s+ACTUAL', 'CIERRE']);
    fechaVencimiento = buscarFechaLabel(texto, ['VENCIMIENTO\\s+ACTUAL', 'VENCIMIENTO']);
  }
  // Sanity check: el vencimiento es siempre POSTERIOR al cierre. Si quedó igual
  // o anterior, lo descartamos para que la app no muestre un ciclo degenerado.
  if (fechaVencimiento && fechaCierre && fechaVencimiento <= fechaCierre) {
    fechaVencimiento = '';
  }

  // ── Próximo cierre / vencimiento ────────────────────────────
  // BBVA tiene fechas de cierre VARIABLES (28-May, luego 02-Jul). El próximo
  // cierre define el ciclo siguiente, así que lo capturamos para que la tarjeta
  // pueda gestionar el ciclo en curso Y el próximo.
  let cierreAnterior = '', vencimientoAnterior = '', proximoCierre = '', proximoVencimiento = '';
  const otros = buscarFechasTabla(lineas, [/CIERRE\s+ANTERIOR/i, /PR[OÓ]XIMO\s+CIERRE/i]);
  // Orden de columnas: cierre ant. · venc. ant. · próximo cierre · próximo venc.
  if (otros.length >= 4) {
    cierreAnterior = otros[0];
    vencimientoAnterior = otros[1];
    proximoCierre = otros[2];
    proximoVencimiento = otros[3];
  } else {
    cierreAnterior = buscarFechaLabel(texto, ['CIERRE\\s+ANTERIOR']);
    vencimientoAnterior = buscarFechaLabel(texto, ['VENCIMIENTO\\s+ANTERIOR', 'VTO\\.?\\s+ANTERIOR']);
    proximoCierre = buscarFechaLabel(texto, ['PR[OÓ]XIMO\\s+CIERRE']);
    proximoVencimiento = buscarFechaLabel(texto, ['PR[OÓ]XIMO\\s+VENCIMIENTO', 'PR[OÓ]XIMO\\s+VTO']);
  }

  // El período se deriva del cierre (YYYY-MM). Es lo más confiable.
  const periodo = fechaCierre ? fechaCierre.slice(0, 7) : '';
  const [anioCierreStr, mesCierreStr] = periodo ? periodo.split('-') : ['', ''];
  const ctx = {
    anioCierre: anioCierreStr ? parseInt(anioCierreStr, 10) : new Date().getFullYear(),
    mesCierre:  mesCierreStr ? parseInt(mesCierreStr, 10) : (new Date().getMonth() + 1),
  };

  let saldoTotal = buscarMontoLabel(texto, ['SALDO\\s+ACTUAL\\s*\\$', 'SALDO\\s+ACTUAL']);
  if (!saldoTotal) saldoTotal = buscarMontoTabla(lineas, /SALDO\s+ACTUAL\s*\$/i, 'first');
  let pagoMinimo = buscarMontoLabel(texto, ['PAGO\\s+M[IÍ]NIMO\\s*\\$', 'PAGO\\s+M[IÍ]NIMO', 'PAGO\\s+MIN\\.?\\s*\\$']);
  if (!pagoMinimo) pagoMinimo = buscarMontoTabla(lineas, /PAGO\s+M[IÍ]NIMO/i, 'last');
  const totalConsumos    = buscarTotalConsumos(texto);
  const totalConsumosUSD = buscarTotalConsumosUSD(texto, lineas);

  // Montos del encabezado que NUNCA son consumos: si una fila de la tabla de
  // totales (cierre/venc/saldo/pago-mínimo) se cuela como movimiento, su monto
  // coincide con el saldo o el pago mínimo → la descartamos como defensa extra.
  const headerMontos = [saldoTotal, pagoMinimo].filter(x => x > 0);
  const esHeaderMonto = (m) => headerMontos.some(h => Math.abs(h - m) < 0.5);

  // ── Consumos: por POSICIÓN si tenemos geometría (filas); si no, por texto ──
  let movimientos = [];
  if (Array.isArray(filas) && filas.length) {
    movimientos = _extraerConsumosPorPosicion(filas, ctx);
  }
  if (!movimientos.length) {
    movimientos = lineas.map(l => parsearLinea(l, ctx)).filter(Boolean);
  }
  movimientos = movimientos.filter(m => !(m.moneda === 'ARS' && esHeaderMonto(m.monto)));

  // ── Reconciliación contable: detectar lecturas dudosas ──────
  const validacion = _reconciliar({
    movimientos, totalConsumos, totalConsumosUSD,
    fechas: { cierreAnterior, vencimientoAnterior, fechaCierre, fechaVencimiento, proximoCierre, proximoVencimiento },
  });

  return {
    banco,
    periodo,
    fechaCierre,
    fechaVencimiento,
    cierreAnterior,
    vencimientoAnterior,
    proximoCierre,
    proximoVencimiento,
    saldoTotal,
    pagoMinimo,
    totalConsumos,
    totalConsumosUSD,
    movimientos,
    validacion,
  };
}

/**
 * Reconciliación contable (sección 6 de la guía). Devuelve un veredicto de
 * confianza para que la UI avise "lectura dudosa" en vez de guardar datos malos.
 * Chequea: suma de consumos ARS/USD == totales impresos, y orden cronológico
 * de las fechas del ciclo.
 */
function _reconciliar({ movimientos, totalConsumos, totalConsumosUSD, fechas }) {
  const advertencias = [];
  const sumaArs = movimientos.filter(m => m.moneda === 'ARS').reduce((a, m) => a + (m.monto || 0), 0);
  const sumaUsd = movimientos.filter(m => m.moneda === 'USD').reduce((a, m) => a + (m.monto || 0), 0);

  if (totalConsumos > 0 && Math.abs(sumaArs - totalConsumos) > 1) {
    advertencias.push(`Los consumos en pesos suman ${sumaArs.toFixed(2)} pero el total impreso es ${totalConsumos.toFixed(2)}.`);
  }
  if (totalConsumosUSD > 0 && Math.abs(sumaUsd - totalConsumosUSD) > 0.5) {
    advertencias.push(`Los consumos en USD suman ${sumaUsd.toFixed(2)} pero el total impreso es ${totalConsumosUSD.toFixed(2)}.`);
  }

  const orden = [fechas.cierreAnterior, fechas.vencimientoAnterior, fechas.fechaCierre,
                 fechas.fechaVencimiento, fechas.proximoCierre, fechas.proximoVencimiento].filter(Boolean);
  for (let i = 1; i < orden.length; i++) {
    if (orden[i] < orden[i - 1]) { advertencias.push('Las fechas del ciclo quedaron fuera de orden cronológico.'); break; }
  }

  return {
    confiable: advertencias.length === 0,
    advertencias,
    suma_ars: sumaArs,
    suma_usd: sumaUsd,
    total_impreso_ars: totalConsumos,
    total_impreso_usd: totalConsumosUSD,
  };
}

/**
 * Parsea un PDF de resumen de tarjeta de crédito.
 * @param {File} file  Archivo PDF subido por el usuario.
 */
export async function parsearResumenTarjeta(file) {
  const { texto, lineas, filas } = await extraerTextoPdf(file);
  return _parsearTexto({ texto, lineas, filas });
}

/* ─── Matching con gastos existentes ───────────────────────── */

function normalizar(s = '') {
  return String(s)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similitud(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const tokensA = na.split(' ').filter(t => t.length > 1);
  const tokensB = nb.split(' ').filter(t => t.length > 1);
  if (!tokensA.length || !tokensB.length) return 0;
  let coincidencias = 0;
  for (const t of tokensA) if (nb.includes(t)) coincidencias++;
  return coincidencias / Math.max(tokensA.length, tokensB.length);
}

/**
 * Cruza los movimientos del resumen con los gastos ya registrados de la tarjeta.
 * Scoring: fecha exacta 0.5 + monto exacto 0.4 + descripción similar 0.1.
 * Umbrales: ≥0.7 exacto · ≥0.3 probable · <0.3 no_encontrado.
 */
export function matchearConGastos(movimientos, gastos, tarjetaId) {
  const candidatos = gastos.filter(g => g.tarjeta_id === tarjetaId && !g.deleted);
  const usados = new Set();

  return movimientos.map(mov => {
    let mejorScore = 0, mejorGasto = null;
    for (const g of candidatos) {
      if (usados.has(g.id)) continue;
      let score = 0;
      // El MONTO es la señal primaria en una conciliación bancaria.
      // OJO con cuotas: el resumen muestra la CUOTA MENSUAL, mientras que el
      // gasto guarda el TOTAL. Para comparar, usamos el monto mensual del gasto.
      const montoGastoComparable = (g.tipo === 'cuotas' && g.cuotas_total)
        ? (g.monto || 0) / g.cuotas_total
        : (g.monto || 0);
      const montoCoincide = Math.abs(montoGastoComparable - mov.monto) <= 1;
      if (montoCoincide) score += 0.6;
      // La fecha confirma; sola no alcanza para "probable".
      if (g.fecha === mov.fecha) score += 0.3;
      else if (g.fecha && mov.fecha && Math.abs(new Date(g.fecha) - new Date(mov.fecha)) <= 2 * 86400000) score += 0.15;
      score += similitud(g.descripcion, mov.descripcion) * 0.1;
      if (score > mejorScore) { mejorScore = score; mejorGasto = g; }
    }
    let confianza;
    if (mejorScore >= 0.7) { confianza = 'exacto'; if (mejorGasto) usados.add(mejorGasto.id); }
    else if (mejorScore >= 0.4) { confianza = 'probable'; }   // requiere al menos monto
    else { confianza = 'no_encontrado'; mejorGasto = null; }
    return { ...mov, match: mejorGasto, confianza, _score: mejorScore };
  });
}
