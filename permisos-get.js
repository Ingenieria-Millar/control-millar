'use strict';
/* Permisos de LECTURA (GET) por módulo y tipo de dato.

   Hasta ahora casi todas las lecturas solo exigían tener sesión: cualquiera de las 293 personas con el
   permiso `modulos` (Contador) podía leer visitantes, contratos, empleados, etc. Aquí vive UNA tabla
   `ruta → permisos` y un único filtro (en vez de tocar ~90 rutas). El administrador pasa siempre.

   Dos modos (variable PERMISOS_GET_MODO):
     · observar (por defecto): NO bloquea. Solo anota "habría negado a X en GET /ruta" para corregir la
       tabla con el uso real antes de cerrar nada. Así nadie se queda sin pantalla (operarios, televisores).
     · aplicar: responde 403 a quien no tenga ninguno de los permisos de la regla.
   Las rutas que no están en la tabla siguen como hoy (cualquier sesión): ver deploy/permisos-get-propuesta.md. */

// Permisos "operativos": quien trabaja con producción, asistencia, tableros, informes o incentivos.
const OPER = ['modulos', 'contador_modulos', 'ordenes_produccion', 'registros_produccion', 'tiempos_improductivos', 'reporte_calidad',
  'informes', 'tablero', 'tablero_planta', 'tablero_eficiencia', 'tablero_individual', 'tablero_produccion', 'tablero_ci',
  'conteo_recogedores', 'calificacion_preparacion', 'area_asistencia', 'consulta_incentivos', 'auditorias_calidad',
  // nombres de antes que algunos perfiles todavía conservan
  'area_ingreso', 'area_calidad', 'ci_tablero'];
const MECANICOS = ['area_montajes', 'mmt_locativo', 'hoja_vida', 'area_solicitar_insumos', 'tablero_planta', 'area_mecanicos'];
const UBICACIONES = ['ubicaciones', 'tablero_ci', 'ci_tablero', 'ci_inventario', 'area_ci'];
const INCENTIVOS = ['consulta_incentivos', 'informes', 'modulos', 'contador_modulos'];

// Lo más específico primero: gana la primera coincidencia. ':x' es un tramo variable; '/*' cualquier cola.
const TABLA = [
  // 1. Datos personales
  ['/api/buscar-contrato', ['consulta_incentivos']],
  ['/api/visitantes/db', ['visitantes_sst']],
  ['/api/ia-records', ['area_asistencia', 'modulos', 'contador_modulos', 'informes']],
  ['/api/empleados', [...OPER, 'almacen_insumos', 'area_montajes', 'visitantes_sst']],
  // 2. Incentivos
  ['/api/incentivos', INCENTIVOS], ['/api/incentivos/*', INCENTIVOS], ['/api/incentivos-diarios', INCENTIVOS],
  ['/api/incentivos-individuales', INCENTIVOS], ['/api/incentivos-config', INCENTIVOS], ['/api/incentivos-disponibilidad', INCENTIVOS],
  // 3. Producción
  ['/api/ordenes', OPER], ['/api/ordenes/:opoc', OPER], ['/api/fichas', OPER], ['/api/fichas/:referencia', OPER],
  ['/api/fichas-faltantes', OPER], ['/api/produccion', OPER], ['/api/produccion-meta', OPER], ['/api/contador-produccion/*', OPER],
  ['/api/config-produccion', OPER], ['/api/config-produccion/*', OPER], ['/api/lt-improductivos', OPER], ['/api/historial', OPER],
  ['/api/improductivos/registros', OPER], ['/api/asistencia-modulos', OPER], ['/api/asistencia-modulos-rango', OPER],
  ['/api/asistencia-personas-rango', OPER], ['/api/asistencia-presentes', OPER], ['/api/supervisoras-modulos', OPER],
  // 4. Telas
  ['/api/revision-telas', ['revision_telas', 'informes']], ['/api/turnos-asignados', ['revision_telas']],
  ['/api/corte-solicitudes', ['corte', 'almacen_insumos', 'revision_telas']],
  // 5. Almacén
  ['/api/almacen/*', ['almacen_insumos']],
  // 6. Mecánicos y mantenimiento
  ['/alistamiento/api/*', MECANICOS], ['/api/mantenimiento', MECANICOS], ['/api/mmt-miembros', ['mmt_locativo', 'area_montajes']],
  // 7. Ubicaciones
  ['/api/ubicaciones', UBICACIONES], ['/api/lotes', UBICACIONES], ['/api/lotes/exportar', UBICACIONES]
];

function compilar(tabla) {
  return tabla.map(([patron, claves]) => {
    const comodin = patron.endsWith('/*');
    const base = (comodin ? patron.slice(0, -2) : patron).split('/');
    return { patron, claves, comodin, base };
  });
}
function buscar(reglas, ruta) {
  const partes = String(ruta).replace(/\/+$/, '').split('/');
  return reglas.find(r => {
    if (r.comodin ? partes.length <= r.base.length : partes.length !== r.base.length) return false;
    return r.base.every((seg, i) => seg.startsWith(':') ? !!partes[i] : seg === partes[i]);
  }) || null;
}

const enmascarar = u => /^\d{6,}$/.test(String(u)) ? '***' + String(u).slice(-3) : String(u);

function crearGuardiaGet({ tabla = TABLA, tienePermiso, verificarToken, modo = 'observar', registrar = console.warn, ahora = Date.now } = {}) {
  const reglas = compilar(tabla);
  const aplicar = String(modo).toLowerCase() === 'aplicar';
  const vistos = new Map();            // "usuario|ruta" → cuándo se anotó (no repetir el mismo aviso por 6 h)
  const LIMITE = 5000, VIGENCIA = 6 * 60 * 60 * 1000;

  function anotar(payload, req, regla) {
    const k = payload.user + '|' + regla.patron, t = ahora();
    if (vistos.has(k) && t - vistos.get(k) < VIGENCIA) return;
    if (vistos.size >= LIMITE) vistos.delete(vistos.keys().next().value);
    vistos.set(k, t);
    registrar(`[PERMISOS-GET] ${aplicar ? 'NEGADO' : 'habria negado'}: ${payload.tipo === 'persona' ? 'persona' : 'perfil'} "${enmascarar(payload.user)}" en GET ${req.path} (regla ${regla.patron}; le falta alguno de: ${regla.claves.join('|')})`);
  }

  function guardia(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const regla = buscar(reglas, req.path);
    if (!regla) return next();
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || req.query.token || '');
    const payload = verificarToken(token);
    if (!payload) return next();                 // sin sesión responde la guardia general (o el interruptor está apagado)
    if (tienePermiso(payload, regla.claves)) return next();
    anotar(payload, req, regla);
    if (aplicar) return res.status(403).json({ error: 'No tienes permiso para ver esta información' });
    next();
  }
  guardia.modo = aplicar ? 'aplicar' : 'observar';
  guardia.reglas = reglas.length;
  return guardia;
}

module.exports = { TABLA, OPER, compilar, buscar, crearGuardiaGet, enmascarar };
