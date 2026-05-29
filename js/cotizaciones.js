/**
 * cotizaciones.js
 * ---------------
 * Obtiene cotizaciones del dólar (oficial, blue, tarjeta, MEP, CCL, cripto)
 * desde dolarapi.com — una API gratuita de la comunidad con CORS abierto.
 *
 * Por qué dolarapi.com:
 *   - dolarhoy.com no expone API pública (sería scraping → bloqueado por CORS)
 *   - dolarapi.com sí tiene CORS habilitado y devuelve los mismos datos
 *     que muestran dolarhoy/ambito/clarín (sus fuentes son las mismas).
 *
 * Cache: las cotizaciones del Banco Central se publican diariamente.
 * Usamos cache de 5 min para no abusar de la API.
 */

const API_BASE = 'https://dolarapi.com/v1/dolares';
const CACHE_KEY = '_cotiz_cache';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Mapeo de "casa" (cómo lo devuelve la API) → clave interna que usamos
const CASA_MAP = {
  oficial:         { clave: 'USD',         nombre: 'Dólar oficial', simbolo: '🇺🇸' },
  blue:            { clave: 'USD_BLUE',    nombre: 'Dólar blue',    simbolo: '💵' },
  tarjeta:         { clave: 'USD_TARJETA', nombre: 'Dólar tarjeta', simbolo: '💳' },
  bolsa:           { clave: 'USD_MEP',     nombre: 'Dólar MEP',     simbolo: '📈' },
  contadoconliqui: { clave: 'USD_CCL',     nombre: 'Dólar CCL',     simbolo: '🏦' },
  cripto:          { clave: 'USD_CRIPTO',  nombre: 'Dólar cripto',  simbolo: '₿'  },
  mayorista:       { clave: 'USD_MAYOR',   nombre: 'Dólar mayorista',simbolo: '🏛' },
};

/**
 * Trae todas las cotizaciones. Cache de 5 min para no martillar la API.
 * @param {boolean} force - Si true, ignora el cache y trae fresco.
 * @returns {Promise<Object>} { USD: {valor,fecha,nombre,simbolo}, USD_BLUE: {...}, ... }
 */
export async function fetchCotizaciones(force = false) {
  // 1. Intentar cache en memoria/localStorage si no es forzado
  if (!force) {
    const cached = leerCache();
    if (cached) return cached;
  }

  // 2. Fetch a la API
  try {
    const r = await fetch(`${API_BASE}`, {
      method: 'GET',
      cache: 'no-cache',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();

    // 3. Mapear a nuestro formato
    const result = {};
    for (const item of arr) {
      const meta = CASA_MAP[item.casa];
      if (!meta) continue;
      result[meta.clave] = {
        valor: parseFloat(item.venta) || parseFloat(item.compra) || 0,
        compra: parseFloat(item.compra) || null,
        venta: parseFloat(item.venta) || null,
        fecha: item.fechaActualizacion,
        nombre: meta.nombre,
        simbolo: meta.simbolo,
      };
    }

    // 4. Guardar en cache
    escribirCache(result);
    return result;
  } catch (e) {
    console.warn('fetchCotizaciones falló:', e.message);
    // Como fallback, devolver lo último que haya en cache aunque esté expirado
    const cached = leerCache(true);
    if (cached) return cached;
    throw e;
  }
}

/**
 * Trae solo el oficial. Útil para el badge en el header.
 */
export async function fetchOficial(force = false) {
  const cot = await fetchCotizaciones(force);
  return cot.USD || null;
}

/**
 * Trae el dólar tarjeta (oficial + impuestos PAÍS + perceptiva). Útil para
 * gastos con tarjeta de crédito que se facturan en USD.
 */
export async function fetchTarjeta(force = false) {
  const cot = await fetchCotizaciones(force);
  return cot.USD_TARJETA || null;
}

function leerCache(ignorarTTL = false) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (!ignorarTTL && Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function escribirCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

export function timestampUltimoFetch() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts } = JSON.parse(raw);
    return ts;
  } catch { return null; }
}
