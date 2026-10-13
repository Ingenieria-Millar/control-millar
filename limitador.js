'use strict';
/* Frenos contra quien insiste: límite de peticiones y límite de claves equivocadas.

   Dos reglas que el servidor no cumplía:
   · La IP del visitante. Detrás de nginx, Express veía siempre 127.0.0.1 (la de nginx),
     así que TODOS compartían el mismo cupo. `valorProxyConfiable` le dice a Express que
     solo crea en el encabezado X-Forwarded-For lo que escriba nginx (la conexión
     local), nunca lo que mande el visitante.
   · Cada ruta lleva su propia cuenta. El tráfico de una pantalla no gasta el cupo de otra.

   Los contadores no crecen sin límite: cada uno se borra cuando vence SU ventana y,
   si aun así se llena, se descartan los más viejos. */

// TRUST_PROXY (variable de entorno): vacío = confiar solo en la propia máquina (nginx en
// 127.0.0.1); "false" o "0" = no confiar en nadie; un número = cuántos saltos; o una lista
// de redes ("loopback, 10.10.0.0/16"). Nunca "true": eso confiaría en cualquiera.
function valorProxyConfiable(texto) {
  const t = String(texto == null ? '' : texto).trim().toLowerCase();
  if (t === '') return 'loopback';
  if (t === 'false' || t === '0' || t === 'no') return false;
  if (t === 'true') return 'loopback';
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return String(texto).trim();
}

function crearContador({ maxEntradas = 20000 } = {}) {
  const m = new Map();   // clave → { count, start, ventana }
  function limpiar(ahora = Date.now()) {
    for (const [k, v] of m) if (ahora - v.start > v.ventana) m.delete(k);
  }
  return {
    // Suma uno a la clave y devuelve cuántos lleva en su ventana actual.
    sumar(clave, ventanaMs, ahora = Date.now()) {
      const e = m.get(clave);
      if (e && ahora - e.start <= e.ventana) return ++e.count;
      m.delete(clave);                                   // al reponerla queda como la más nueva
      if (m.size >= maxEntradas) {
        limpiar(ahora);
        for (const k of m.keys()) { if (m.size < maxEntradas) break; m.delete(k); }   // las más viejas primero
      }
      m.set(clave, { count: 1, start: ahora, ventana: ventanaMs });
      return 1;
    },
    // Cuántos lleva la clave en su ventana actual (sin sumar).
    contar(clave, ahora = Date.now()) {
      const e = m.get(clave);
      return e && ahora - e.start <= e.ventana ? e.count : 0;
    },
    limpiar,
    get tamano() { return m.size; }
  };
}

// La ruta tal como se declaró (/api/obras/:id), no la dirección real: así una ruta con
// identificador no crea una cuenta nueva por cada identificador.
const rutaDe = req => req.method + ' ' + ((req.baseUrl || '') + (req.route && req.route.path != null ? req.route.path : req.path));
const ipDe = req => req.ip || (req.socket && req.socket.remoteAddress) || 'desconocida';

function crearLimitador({ maxEntradas = 20000, maxFallos = 20, ventanaFallosMs = 60 * 1000 } = {}) {
  const peticiones = crearContador({ maxEntradas });
  const fallos = crearContador({ maxEntradas });

  // Como middleware de una ruta: rateLimit(20, 60000)
  function rateLimit(maxReq, windowMs) {
    return (req, res, next) => {
      const n = peticiones.sumar(ipDe(req) + '|' + rutaDe(req), windowMs);
      if (n > maxReq) {
        console.warn(`Rate limit superado para IP ${ipDe(req)} en ${req.path}`);
        return res.status(429).json({ error: 'Demasiadas solicitudes. Intente en un momento.' });
      }
      next();
    };
  }
  // Solo cuentan las claves EQUIVOCADAS: en planta las tablets salen por la misma IP y las
  // claves bien puestas no deben gastar el cupo de nadie. Cada ruta lleva su cuenta.
  const bloqueadoPorFallos = req => fallos.contar(ipDe(req) + '|' + rutaDe(req)) >= maxFallos;
  const anotarFallo = req => { fallos.sumar(ipDe(req) + '|' + rutaDe(req), ventanaFallosMs); };

  // Limpieza periódica; unref() para que no impida apagar el servidor.
  const timer = setInterval(() => { peticiones.limpiar(); fallos.limpiar(); }, 10 * 60 * 1000);
  if (timer.unref) timer.unref();

  return { rateLimit, bloqueadoPorFallos, anotarFallo, peticiones, fallos };
}

module.exports = { valorProxyConfiable, crearContador, crearLimitador, ipDe, rutaDe };
