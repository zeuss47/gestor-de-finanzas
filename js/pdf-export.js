/**
 * pdf-export.js
 * --------------
 * Generador de reportes financieros en PDF para imprimir o archivar.
 *
 * Usa jsPDF + jspdf-autotable cargados desde CDN bajo demanda.
 *
 * Reporte incluye:
 *   - Header con período + fecha de generación
 *   - Resumen ejecutivo (ingresos, gastos, neto, % ahorro)
 *   - Desglose por categoría
 *   - Detalle por cuenta (saldos y movimientos por cuenta)
 *   - Detalle por tarjeta (consumo del período + ciclo)
 *   - Lista detallada de movimientos cronológica
 *
 * 100% local — la generación se hace en el cliente, no se envía nada.
 */

const JSPDF_URL    = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const AUTOTABLE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.0/jspdf.plugin.autotable.min.js';

let _libsLoaded = false;
async function cargarLibrerias() {
  if (_libsLoaded) return;
  // Cargar jsPDF (UMD, expone window.jspdf.jsPDF)
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSPDF_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar jsPDF'));
    document.head.appendChild(s);
  });
  // Cargar autoTable (extiende jsPDF)
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = AUTOTABLE_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar jspdf-autotable'));
    document.head.appendChild(s);
  });
  _libsLoaded = true;
}

/* ─── Helpers de formato ──────────────────────────────────────── */

const FMT = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const FMT_FULL = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function rangoDePeriodo({ tipo, mes, anio, desde, hasta }) {
  if (tipo === 'mes') {
    const y = parseInt(anio);
    const m = parseInt(mes);
    return {
      desde: new Date(y, m - 1, 1),
      hasta: new Date(y, m, 0, 23, 59, 59),
      label: `${MESES_ES[m - 1]} ${y}`,
    };
  }
  if (tipo === 'anio') {
    const y = parseInt(anio);
    return {
      desde: new Date(y, 0, 1),
      hasta: new Date(y, 11, 31, 23, 59, 59),
      label: `Año ${y}`,
    };
  }
  // tipo === 'rango'
  return {
    desde: new Date(desde + 'T00:00:00'),
    hasta: new Date(hasta + 'T23:59:59'),
    label: `${desde} al ${hasta}`,
  };
}

function inRange(iso, desde, hasta) {
  if (!iso) return false;
  const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
  return d >= desde && d <= hasta;
}

/* ─── Generador del reporte ───────────────────────────────────── */

export async function exportarReportePDF(state, periodo) {
  await cargarLibrerias();

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const { desde, hasta, label } = rangoDePeriodo(periodo);

  // Filtros
  const gastos    = (state.gastos    || []).filter(g => !g.deleted && inRange(g.fecha, desde, hasta));
  const ingresos  = (state.ingresos  || []).filter(i => !i.deleted && inRange(i.fecha, desde, hasta));
  const cuentas   = (state.cuentas   || []).filter(c => !c.deleted);
  const tarjetas  = (state.tarjetas  || []).filter(t => !t.deleted);

  // Totales
  const totalGastos   = gastos.reduce((a, g) => a + (g.monto || 0), 0);
  const totalIngresos = ingresos.reduce((a, i) => a + ((i.sueldo_neto || 0) + (i.bonos || 0)), 0);
  const neto          = totalIngresos - totalGastos;
  const pctAhorro     = totalIngresos > 0 ? Math.round((neto / totalIngresos) * 100) : 0;

  /* ─── Header ─── */
  doc.setFillColor(7, 9, 15);
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), 80, 'F');
  doc.setTextColor(0, 240, 255);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('Reporte Financiero', 40, 40);
  doc.setFontSize(11);
  doc.setTextColor(200, 220, 240);
  doc.setFont('helvetica', 'normal');
  doc.text(`Período: ${label}`, 40, 58);
  doc.text(`Generado: ${new Date().toLocaleString('es-AR')}`, 40, 72);

  /* ─── Resumen ejecutivo ─── */
  let y = 110;
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Resumen ejecutivo', 40, y);
  y += 8;

  doc.autoTable({
    startY: y + 5,
    head: [['Concepto', 'Monto']],
    body: [
      ['Total ingresos',  FMT_FULL.format(totalIngresos)],
      ['Total gastos',    FMT_FULL.format(totalGastos)],
      ['Neto del período', FMT_FULL.format(neto)],
      ['% de ahorro',     `${pctAhorro}%`],
      ['Movimientos',     `${gastos.length} gastos · ${ingresos.length} ingresos`],
    ],
    theme: 'striped',
    headStyles: { fillColor: [0, 240, 255], textColor: [7, 9, 15], fontStyle: 'bold' },
    margin: { left: 40, right: 40 },
    styles: { fontSize: 10 },
  });
  y = doc.lastAutoTable.finalY + 25;

  /* ─── Desglose por categoría ─── */
  const porCat = new Map();
  for (const g of gastos) {
    const k = g.categoria || 'general';
    porCat.set(k, (porCat.get(k) || 0) + (g.monto || 0));
  }
  const cats = [...porCat.entries()].sort((a, b) => b[1] - a[1]);

  if (cats.length > 0) {
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Gastos por categoría', 40, y);
    y += 8;
    doc.autoTable({
      startY: y + 5,
      head: [['Categoría', 'Monto', '% del total']],
      body: cats.map(([cat, monto]) => [
        cat,
        FMT.format(monto),
        totalGastos ? `${((monto / totalGastos) * 100).toFixed(1)}%` : '0%',
      ]),
      theme: 'striped',
      headStyles: { fillColor: [255, 45, 110], textColor: [255, 255, 255], fontStyle: 'bold' },
      margin: { left: 40, right: 40 },
      styles: { fontSize: 10 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    });
    y = doc.lastAutoTable.finalY + 25;
  }

  /* ─── Detalle por cuenta ─── */
  if (cuentas.length > 0) {
    if (y > 680) { doc.addPage(); y = 60; }
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Cuentas bancarias', 40, y);
    y += 8;

    const filas = cuentas.map(c => {
      const ingC = (state.ingresos || []).filter(i => !i.deleted && i.cuenta_id === c.id).reduce((a, i) => a + ((i.sueldo_neto || 0) + (i.bonos || 0)), 0);
      const gasC = (state.gastos   || []).filter(g => !g.deleted && g.cuenta_id === c.id).reduce((a, g) => a + (g.monto || 0), 0);
      const saldo = (c.saldo_inicial || 0) + ingC - gasC;
      const ingPer = ingresos.filter(i => i.cuenta_id === c.id).reduce((a, i) => a + ((i.sueldo_neto || 0) + (i.bonos || 0)), 0);
      const gasPer = gastos.filter(g => g.cuenta_id === c.id).reduce((a, g) => a + (g.monto || 0), 0);
      return [
        c.nombre || 'Cuenta',
        c.tipo || '—',
        FMT.format(saldo),
        FMT.format(ingPer),
        FMT.format(gasPer),
      ];
    });
    doc.autoTable({
      startY: y + 5,
      head: [['Cuenta', 'Tipo', 'Saldo actual', `Ingresos en ${label}`, `Gastos en ${label}`]],
      body: filas,
      theme: 'striped',
      headStyles: { fillColor: [0, 200, 100], textColor: [255, 255, 255], fontStyle: 'bold' },
      margin: { left: 40, right: 40 },
      styles: { fontSize: 9 },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    });
    y = doc.lastAutoTable.finalY + 25;
  }

  /* ─── Detalle por tarjeta ─── */
  if (tarjetas.length > 0) {
    if (y > 680) { doc.addPage(); y = 60; }
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Tarjetas de crédito', 40, y);
    y += 8;

    const filasT = tarjetas.map(t => {
      const consumoTotal = (state.gastos || []).filter(g => !g.deleted && g.tarjeta_id === t.id).reduce((a, g) => a + (g.monto || 0), 0);
      const consumoPer   = gastos.filter(g => g.tarjeta_id === t.id).reduce((a, g) => a + (g.monto || 0), 0);
      const pct = t.limite_credito ? Math.round((consumoTotal / t.limite_credito) * 100) : 0;
      return [
        t.nombre || 'Tarjeta',
        FMT.format(t.limite_credito || 0),
        FMT.format(consumoTotal),
        `${pct}%`,
        FMT.format(consumoPer),
        t.dia_cierre ? `${t.dia_cierre}` : '—',
      ];
    });
    doc.autoTable({
      startY: y + 5,
      head: [['Tarjeta', 'Límite', 'Consumido total', '% usado', `Consumo ${label}`, 'Día cierre']],
      body: filasT,
      theme: 'striped',
      headStyles: { fillColor: [181, 55, 255], textColor: [255, 255, 255], fontStyle: 'bold' },
      margin: { left: 40, right: 40 },
      styles: { fontSize: 9 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'center' } },
    });
    y = doc.lastAutoTable.finalY + 25;
  }

  /* ─── Detalle de movimientos ─── */
  if (gastos.length + ingresos.length > 0) {
    doc.addPage();
    y = 60;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(`Movimientos detallados — ${label}`, 40, y);
    y += 8;

    const movimientos = [
      ...gastos.map(g => ({
        fecha: g.fecha,
        tipo: 'Gasto',
        categoria: g.categoria || 'general',
        descripcion: g.descripcion || '',
        cuenta: cuentas.find(c => c.id === g.cuenta_id)?.nombre || (g.tarjeta_id ? `💳 ${tarjetas.find(t => t.id === g.tarjeta_id)?.nombre || 'tarjeta'}` : '—'),
        monto: -(g.monto || 0),
      })),
      ...ingresos.map(i => ({
        fecha: i.fecha,
        tipo: 'Ingreso',
        categoria: '—',
        descripcion: i.descripcion || 'Ingreso',
        cuenta: cuentas.find(c => c.id === i.cuenta_id)?.nombre || '—',
        monto: ((i.sueldo_neto || 0) + (i.bonos || 0)),
      })),
    ].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

    doc.autoTable({
      startY: y + 5,
      head: [['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Cuenta/Tarjeta', 'Monto']],
      body: movimientos.map(m => [
        m.fecha || '',
        m.tipo,
        m.categoria,
        m.descripcion.slice(0, 40),
        m.cuenta,
        (m.monto >= 0 ? '+' : '') + FMT.format(m.monto),
      ]),
      theme: 'grid',
      headStyles: { fillColor: [40, 40, 40], textColor: [0, 240, 255], fontStyle: 'bold' },
      margin: { left: 30, right: 30 },
      styles: { fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 60 },
        1: { cellWidth: 45 },
        2: { cellWidth: 65 },
        3: { cellWidth: 'auto' },
        4: { cellWidth: 100 },
        5: { cellWidth: 75, halign: 'right' },
      },
      didParseCell: (data) => {
        // Pintar montos: verde positivo, rojo negativo
        if (data.section === 'body' && data.column.index === 5) {
          const txt = data.cell.text[0] || '';
          if (txt.startsWith('+')) data.cell.styles.textColor = [0, 130, 80];
          else if (txt.startsWith('-')) data.cell.styles.textColor = [200, 30, 60];
        }
      },
    });
  }

  /* ─── Pie de página en todas las páginas ─── */
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Gestor de Finanzas · ${label}`, 40, h - 20);
    doc.text(`Página ${p} de ${totalPages}`, w - 40, h - 20, { align: 'right' });
  }

  // Guardar
  const nombre = `reporte-${label.replace(/\s+/g, '-').toLowerCase()}.pdf`;
  doc.save(nombre);
  return nombre;
}
