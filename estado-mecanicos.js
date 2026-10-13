'use strict';
/* Estado de cada mecánico, a partir de lo que ya sabe el servidor de los módulos.

   Cuando una operaria dice quién llegó a atender, el módulo pasa a "atención de mecánico" (amarillo) y
   queda anotado el mecánico, la operaria y la hora en que empezó la atención. El alistamiento (granate o
   rosado) también lleva el nombre del mecánico. Aquí se da vuelta a esa información: en vez de "qué le pasa a
   cada módulo", "qué está haciendo cada mecánico". Sin base de datos ni disco: solo recibe los datos y calcula,
   para poder probarlo.

   Estados: 'atendiendo' | 'alistamiento' | 'ocupado' | 'disponible'. "Ocupado" = tiene una multitarea EN CURSO en el Registro MMT
   Mecánico (estado 'en_proceso'; la pendiente o finalizada no lo ocupa). Si un mecánico tiene varias cosas a la vez se muestra la que
   lleva más tiempo y se dice cuántas más tiene (`otras`). */

const sinTildes = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const mismoNombre = (a, b) => { const x = sinTildes(a); return x !== '' && x === sinTildes(b); };

// 'yellow' = atención de mecánico; 'garnet' y 'pink' = alistamiento.
const TIPO_DE = { yellow: 'atendiendo', garnet: 'alistamiento', pink: 'alistamiento' };

function ocupacionesDe(nombre, d) {
  const esPropio = d.esPropio || (() => false);
  const out = [];
  const ids = new Set([...Object.keys(d.multiImps || {}), ...Object.keys(d.states || {})]);
  ids.forEach(modId => {
    const lista = ((d.multiImps || {})[modId] || []).filter(i => i && !esPropio(i));
    if (lista.length) {
      lista.forEach(i => {
        const tipo = TIPO_DE[i.tipoActual || i.tipo];
        if (tipo && mismoNombre(i.mecanico, nombre)) {
          out.push({ estado: tipo, modulo: modId, persona: String(i.empleada || (d.lastEmpleada || {})[modId] || ''), desde: Number(i.inicio) || Number((d.stateTimes || {})[modId]) || null });
        }
      });
    } else {
      // Sin lista de improductivos en ese módulo: vale el color de siempre (mecanismo viejo de un solo estado).
      const tipo = TIPO_DE[(d.states || {})[modId]];
      if (tipo && mismoNombre((d.lastMec || {})[modId], nombre)) {
        out.push({ estado: tipo, modulo: modId, persona: String((d.lastEmpleada || {})[modId] || ''), desde: Number((d.stateTimes || {})[modId]) || null });
      }
    }
  });
  // Multitareas en curso del Registro MMT Mecánico.
  (d.multitareas || []).forEach(r => {
    if (r && r.estado === 'en_proceso' && mismoNombre(r.mecanico, nombre)) {
      out.push({ estado: 'ocupado', modulo: '', persona: '', actividad: String(r.tarea || '').trim(), desde: Date.parse(r.horaInicio) || null });
    }
  });
  return out;
}

// mecanicos: [{ nombre, foto }]. Devuelve una tarjeta por mecánico, en orden alfabético (estable: no saltan de lugar).
function calcularEstadoMecanicos(d) {
  const lista = (d.mecanicos || []).filter(m => m && String(m.nombre || '').trim());
  return lista.map(m => {
    const nombre = String(m.nombre).trim();
    const oc = ocupacionesDe(nombre, d);
    // La atención pesa más que el alistamiento; entre iguales, la que lleva más tiempo (la más antigua).
    const peso = o => (o.estado === 'atendiendo' ? 0 : o.estado === 'alistamiento' ? 1 : 2);
    oc.sort((a, b) => peso(a) - peso(b) || (a.desde || Infinity) - (b.desde || Infinity));
    const principal = oc[0];
    return {
      nombre, foto: m.foto ? String(m.foto) : '',
      estado: principal ? principal.estado : 'disponible',
      modulo: principal ? principal.modulo : '',
      persona: principal ? principal.persona : '',
      actividad: principal ? (principal.actividad || '') : '',
      desde: principal ? principal.desde : null,
      otras: Math.max(0, oc.length - 1)
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// Los mecánicos activos del perfil "Mecánicos" (el nombre del perfil puede venir con o sin tilde).
function mecanicosDelPerfil(perfilMembers) {
  const clave = Object.keys(perfilMembers || {}).find(k => sinTildes(k) === 'MECANICOS');
  const lista = clave && Array.isArray(perfilMembers[clave]) ? perfilMembers[clave] : [];
  return lista
    .map(m => typeof m === 'string' ? { nombre: m, disabled: false } : m)
    .filter(m => m && !m.disabled && String(m.nombre || '').trim())
    .map(m => ({ nombre: String(m.nombre).trim(), foto: m.foto ? String(m.foto) : '' }));
}

module.exports = { calcularEstadoMecanicos, mecanicosDelPerfil, ocupacionesDe, mismoNombre };
