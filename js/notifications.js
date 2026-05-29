/**
 * notifications.js
 * ----------------
 * API nativa de notificaciones. Tres responsabilidades:
 *
 *  1) Pedir permiso (Notification.requestPermission()).
 *  2) Disparar alertas locales:
 *       - Confirmación de movimientos / sueldos cargados.
 *       - Alertas de proximidad de cierre/vencimiento (5d / 48h / 24h).
 *       - Diagnósticos de IA local con severidad warning/critical.
 *  3) Estructurar el Payload de forma "limpia" (title + body + tag + data)
 *     para que iOS/Android repliquen la notificación al Smartwatch enlazado
 *     sin reformatear el contenido. Usar `tag` evita duplicados y permite
 *     ACTUALIZAR la misma notificación cuando el plazo cambia (5d -> 48h -> 24h).
 *
 * Implementación: si la página tiene un Service Worker activo, usamos
 * `registration.showNotification` (sobrevive al cierre de la pestaña).
 * Si no, caemos al constructor `new Notification(...)`.
 */

import { DB } from './db.js';
import { resumenTarjeta } from './cards.js';

export const Notif = {
  async pedirPermiso() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied')  return 'denied';
    return await Notification.requestPermission();
  },

  habilitadas() {
    return 'Notification' in window && Notification.permission === 'granted';
  },

  /**
   * Dispara una notificación. Si el SW está registrado y activo, la mostramos
   * vía SW (para que aparezca también con la app cerrada). Si no, usamos la
   * API directa.
   *
   * payload: { title, body, tag, severidad?, data? }
   */
  async show(payload) {
    if (!this.habilitadas()) return;
    const opts = {
      body: payload.body,
      tag: payload.tag,                       // dedupe por tag
      renotify: !!payload.renotify,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      data: payload.data || {},
      // Vibración: patrón que se replica bien en Wear OS / Android.
      vibrate: payload.severidad === 'critical' ? [200, 80, 200, 80, 400] : [120],
    };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.showNotification(payload.title, opts);
      } else {
        new Notification(payload.title, opts);
      }
    } catch (e) {
      console.warn('Notif show failed', e);
    }
  },

  /**
   * Confirmación de movimiento / sueldo. Se llama desde app.js justo después
   * de guardar en IndexedDB.
   */
  confirmarMovimiento({ tipo, descripcion, monto, moneda = 'ARS' }) {
    const formato = new Intl.NumberFormat('es-AR', { style: 'currency', currency: moneda });
    return this.show({
      title: tipo === 'ingreso' ? '✅ Ingreso registrado' : '✅ Movimiento registrado',
      body: `${descripcion}: ${formato.format(monto)}`,
      tag: `mov-${Date.now()}`,
      data: { kind: 'movimiento', tipo },
    });
  },

  /**
   * Alerta de tarjeta. Usa tag estable por tarjeta+evento para que las
   * sucesivas alertas (5d, 48h, 24h) ACTUALICEN la misma notificación
   * en lugar de generar 3 ítems separados.
   */
  alertaTarjeta(tarjeta, resumen, evento, dias) {
    const formato = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
    const titulo = evento === 'cierre'
      ? `💳 ${tarjeta.nombre}: cierra en ${dias}d`
      : `⏰ ${tarjeta.nombre}: vence en ${dias}d`;
    const cuerpo = `Resumen estimado: ${formato.format(resumen.total_resumen)}`;
    const sev = dias <= 1 ? 'critical' : (dias <= 2 ? 'warning' : 'info');
    return this.show({
      title: titulo,
      body: cuerpo,
      tag: `tarjeta-${tarjeta.id}-${evento}`,
      renotify: true,
      severidad: sev,
      data: { kind: 'tarjeta', tarjeta_id: tarjeta.id, evento, dias },
    });
  },

  /**
   * Alerta de IA local. severidad warning/critical -> notif visible.
   * info -> sólo se renderiza en el widget, no se notifica para evitar ruido.
   */
  alertaIA(diag) {
    if (diag.severidad === 'info') return;
    return this.show({
      title: `🧠 ${diag.titulo}`,
      body: diag.detalle,
      tag: `ia-${diag.tipo}-${diag.categoria || 'global'}`,
      severidad: diag.severidad,
      data: { kind: 'ia', diagnostico: diag },
    });
  },
};

/**
 * Chequeo diario de tarjetas: recorre todas las tarjetas activas, calcula
 * el resumen y dispara alertas según ajustes.notificaciones.alertas_tarjeta_dias.
 *
 * Esta función se invoca al cargar la app y también desde el SW vía
 * `periodicsync` cuando esté disponible.
 */
export async function chequeoDiarioTarjetas() {
  const aj = await DB.get('ajustes', 'ajustes_globales');
  const dias_alerta = aj?.notificaciones?.alertas_tarjeta_dias || [5, 2, 1];

  const tarjetas = (await DB.live('tarjetas')).filter(t => t.activa !== false);
  const gastos = await DB.live('gastos');

  for (const t of tarjetas) {
    const r = resumenTarjeta(t, gastos);
    if (dias_alerta.includes(r.dias_para_cierre) && r.dias_para_cierre >= 0) {
      await Notif.alertaTarjeta(t, r, 'cierre', r.dias_para_cierre);
    }
    if (dias_alerta.includes(r.dias_para_vencimiento) && r.dias_para_vencimiento >= 0) {
      await Notif.alertaTarjeta(t, r, 'vencimiento', r.dias_para_vencimiento);
    }
  }
}
