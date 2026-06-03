/**
 * receipt-extractor.js
 * --------------------
 * Extrae gastos de archivos: PDFs (texto, vía pdf-import) e IMÁGENES de
 * boletas/tickets (OCR con Tesseract.js cargado on-demand desde CDN).
 * Devuelve ítems editables { monto, descripcion, categoria, fecha } que la UI
 * muestra para CORREGIR y APROBAR antes de crear los gastos.
 * 100% local: el OCR corre en el navegador, sin enviar nada a un servidor.
 */
import { extraerTextoPdf } from './pdf-import.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';
let _tess = null;

async function cargarTesseract() {
  if (_tess) return _tess;
  const mod = await import(/* @vite-ignore */ TESSERACT_URL);
  // El build ESM expone recognize como named export y/o en default.
  _tess = (mod && typeof mod.recognize === 'function') ? mod
        : (mod?.default && typeof mod.default.recognize === 'function') ? mod.default
        : mod;
  return _tess;
}

/** ¿Es una imagen soportada? */
export function esImagen(file) {
  return !!file && (file.type?.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp|gif)$/i.test(file.name || ''));
}
export function esPdf(file) {
  return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

/** Extrae el texto crudo de un archivo (PDF o imagen). onProgress(0..1) opcional. */
export async function extraerTextoArchivo(file, onProgress) {
  if (esPdf(file)) {
    const { texto } = await extraerTextoPdf(file);
    return texto || '';
  }
  if (esImagen(file)) {
    const T = await cargarTesseract();
    const res = await T.recognize(file, 'spa', {
      logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress || 0); },
    });
    return res?.data?.text || '';
  }
  return '';
}

/** Parsea un monto en formato local "1.234,56" o "1234.56" → número. */
function parsearMonto(s) {
  if (!s) return null;
  let t = String(s).replace(/[^\d.,]/g, '');
  if (!t) return null;
  // Si tiene coma decimal (formato AR): puntos = miles, coma = decimal.
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');           // coma como miles
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}

const RE_FECHA = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/;

/**
 * Heurística para tickets/boletas: detecta el TOTAL, la fecha y el comercio.
 * Para un ticket normal devuelve 1 ítem; queda editable en la UI de revisión.
 * @param {function} [sugerirCat] sugeridor de categoría (opcional)
 */
export function parsearTicket(texto, sugerirCat) {
  const lineas = String(texto || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // ── Monto: preferir una línea con "total" (la mayor) ──
  let monto = null;
  for (const l of lineas) {
    if (/total/i.test(l) && !/sub\s*total/i.test(l)) {
      const n = parsearMonto((l.match(/[\d.,]+\s*$/) || [l])[0]);
      if (n != null && (monto == null || n > monto)) monto = n;
    }
  }
  if (monto == null) {
    const nums = (texto.match(/\d[\d.,]*\d|\d/g) || []).map(parsearMonto).filter(n => n != null && n >= 1);
    monto = nums.length ? Math.max(...nums) : 0;
  }

  // ── Fecha ──
  let fecha = new Date().toISOString().slice(0, 10);
  const fm = texto.match(RE_FECHA);
  if (fm) {
    let [, d, mo, y] = fm;
    if (y.length === 2) y = '20' + y;
    const dd = String(d).padStart(2, '0'), mm = String(mo).padStart(2, '0');
    if (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31) fecha = `${y}-${mm}-${dd}`;
  }

  // ── Descripción: primera línea "de comercio" (con letras, no totales/IVA/CUIT) ──
  const desc = (lineas.find(l =>
    /[a-záéíóúñ]{3,}/i.test(l) && !/total|subtotal|iva|cuit|c\.?u\.?i\.?t|importe|cambio|efectivo|tarjeta/i.test(l)
  ) || 'Ticket').slice(0, 40);

  const categoria = (sugerirCat && sugerirCat(desc)) || 'general';

  return {
    items: [{
      monto: monto != null ? Math.round(monto * 100) / 100 : 0,
      descripcion: desc,
      categoria,
      fecha,
      _confianza: monto > 0 ? 'media' : 'baja',
    }],
  };
}

/** Pipeline completo: archivo → texto → ítems editables. */
export async function extraerGastosDeArchivo(file, { sugerirCat, onProgress } = {}) {
  const texto = await extraerTextoArchivo(file, onProgress);
  const { items } = parsearTicket(texto, sugerirCat);
  return { items, texto, archivo: file.name };
}
