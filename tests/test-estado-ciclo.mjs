/** Test de estadoCiclo: clasificación de ciclos (componente 3 del módulo). */
import { estadoCiclo } from '../js/cards.js';
let ok=0, fail=0; const ck=(n,c,x='')=>{ if(c)ok++; else{fail++; console.log(`  ✗ ${n} ${x}`);} };
const HOY = new Date('2026-06-02T12:00:00');

// Ciclo en curso: hoy (02-jun) antes del cierre (28-jun) → ABIERTO
let e = estadoCiclo({ fechaCierre:'2026-06-28', fechaVencimiento:'2026-07-05', hoy:HOY });
ck('abierto', e.estado==='abierto', e.estado);
ck('días para cierre = 26', e.diasParaCierre===26, e.diasParaCierre);

// Cerrado pero no vencido: cierre 28-may, venc 05-jun, hoy 02-jun → CERRADO_PENDIENTE
e = estadoCiclo({ fechaCierre:'2026-05-28', fechaVencimiento:'2026-06-05', hoy:HOY });
ck('cerrado pendiente', e.estado==='cerrado_pendiente', e.estado);
ck('vence en 3 días', e.diasParaVencimiento===3, e.diasParaVencimiento);
ck('etiqueta correcta', e.etiqueta==='Cerrado - Pendiente de pago', e.etiqueta);

// Pasó el vencimiento sin pagar → VENCIDO
e = estadoCiclo({ fechaCierre:'2026-04-30', fechaVencimiento:'2026-05-08', hoy:HOY });
ck('vencido', e.estado==='vencido', e.estado);

// Pagado (override) aunque haya vencido → PAGADO
e = estadoCiclo({ fechaCierre:'2026-04-30', fechaVencimiento:'2026-05-08', pagado:true, hoy:HOY });
ck('pagado', e.estado==='pagado', e.estado);

// Acepta Date además de ISO
e = estadoCiclo({ cierre:new Date('2026-06-28T12:00:00'), vencimiento:new Date('2026-07-05T12:00:00'), hoy:HOY });
ck('acepta Date', e.estado==='abierto', e.estado);

console.log(`\n${fail===0?'✓ TODOS OK':'✗ FALLAS'} — ${ok} pasados, ${fail} fallados`);
process.exit(fail===0?0:1);
