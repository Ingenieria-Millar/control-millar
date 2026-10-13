'use strict';
/* Configuración y validación de las luces Pick-to-Light (MQTT → ESP32). Lógica pura: no se conecta a nada.

   Antes el servidor publicaba en broker.hivemq.com (público, cualquiera puede leer y escribir) con el tema
   fijo "millar/luces" y sin usuario ni clave: cualquiera en internet podía encender o apagar las luces, o
   escuchar qué ubicaciones se consultaban.

   Ahora la conexión sale de variables de entorno:
     MQTT_BROKER_URL   mqtts://tu-broker:8883   (mqtt:// también vale, pero va sin cifrar: solo red privada)
     MQTT_USER / MQTT_PASS   usuario y clave del broker (los dos son obligatorios)
     MQTT_TOPIC_LUCES  tema difícil de adivinar, ej. millar/luces/Xk29fQ7w1pAa  (mínimo 12 caracteres, sin comodines)
     MQTT_CANAL_MAX    opcional, el canal más alto que existe (por defecto 255)
   Si MQTT_BROKER_URL está definida pero algo falta o es inseguro, las luces quedan APAGADAS (no se publica nada)
   y el motivo sale en el registro: falla cerrado, nunca vuelve al broker público.

   TRANSICIÓN: mientras no haya broker propio, si NO hay MQTT_BROKER_URL se mantiene el comportamiento de
   antes (broker público) con un aviso fuerte, para no dejar sin luces a Ubicación Lotes de golpe. Con
   MQTT_LUCES_LEGACY=false queda apagado. Cuando exista el broker propio: definir las variables de arriba. */

const ACCIONES = new Set(['encender', 'apagar']);
const CANAL_MAX_DEFECTO = 255;
const BROKERS_PUBLICOS = ['broker.hivemq.com', 'test.mosquitto.org', 'broker.emqx.io', 'mqtt.eclipseprojects.io', 'public.mqtthq.com'];
const TOPIC_OK = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;      // sin comodines (# +) ni espacios
const LEGACY = { url: 'mqtt://broker.hivemq.com:1883', topic: 'millar/luces' };

const apagado = motivo => ({ modo: 'apagado', motivo });

function leerConfigLuces(env = process.env) {
  const url = String(env.MQTT_BROKER_URL || '').trim();
  const legacyOff = ['false', '0', 'no'].includes(String(env.MQTT_LUCES_LEGACY || '').trim().toLowerCase());

  if (!url) {
    if (legacyOff) return apagado('MQTT_BROKER_URL no está definida y MQTT_LUCES_LEGACY=false: las luces están apagadas.');
    return { modo: 'legacy', url: LEGACY.url, topic: LEGACY.topic, opciones: {}, canalMax: CANAL_MAX_DEFECTO,
      aviso: 'Las luces usan el broker PÚBLICO broker.hivemq.com con el tema fijo "millar/luces", sin clave: cualquiera en internet puede encenderlas o apagarlas. Define MQTT_BROKER_URL, MQTT_USER, MQTT_PASS y MQTT_TOPIC_LUCES (ver mqtt-luces.js).' };
  }

  let u;
  try { u = new URL(url); } catch (e) { return apagado('MQTT_BROKER_URL no es una dirección válida.'); }
  if (!['mqtt:', 'mqtts:'].includes(u.protocol)) return apagado('MQTT_BROKER_URL debe empezar por mqtts:// (o mqtt:// en red privada).');
  if (!u.hostname) return apagado('MQTT_BROKER_URL no tiene servidor.');
  if (BROKERS_PUBLICOS.includes(u.hostname.toLowerCase())) return apagado('MQTT_BROKER_URL apunta a un broker público (' + u.hostname + '): no se permite.');
  if (u.username || u.password) return apagado('No pongas usuario y clave dentro de la dirección: usa MQTT_USER y MQTT_PASS.');

  const user = String(env.MQTT_USER || ''), pass = String(env.MQTT_PASS || '');
  if (!user || !pass) return apagado('Faltan MQTT_USER y/o MQTT_PASS: no se conecta a un broker sin autenticación.');

  const topic = String(env.MQTT_TOPIC_LUCES || '').trim();
  if (!topic) return apagado('Falta MQTT_TOPIC_LUCES.');
  if (!TOPIC_OK.test(topic) || topic.length > 128) return apagado('MQTT_TOPIC_LUCES no es válido (solo letras, números, guion, guion bajo y "/"; sin comodines).');
  if (topic.length < 12 || topic.toLowerCase() === LEGACY.topic) return apagado('MQTT_TOPIC_LUCES es muy fácil de adivinar: usa uno largo, ej. millar/luces/Xk29fQ7w1pAa.');

  let canalMax = parseInt(env.MQTT_CANAL_MAX, 10);
  if (!Number.isInteger(canalMax) || canalMax < 1 || canalMax > 4096) canalMax = CANAL_MAX_DEFECTO;

  const cifrado = u.protocol === 'mqtts:';
  return { modo: 'configurado', url, topic, canalMax, cifrado,
    host: u.host,
    opciones: { username: user, password: pass, reconnectPeriod: 5000, rejectUnauthorized: true },
    aviso: cifrado ? null : 'El broker va SIN cifrar (mqtt://): usuario y clave viajan en claro. Úsalo solo en una red privada.' };
}

// Lo único que se puede publicar: un canal entero 1..canalMax y una acción conocida.
function validarOrden(canal, accion, canalMax = CANAL_MAX_DEFECTO) {
  const c = typeof canal === 'string' && /^\d{1,5}$/.test(canal.trim()) ? Number(canal) : canal;
  if (!Number.isInteger(c) || c < 1 || c > canalMax) return { ok: false, motivo: 'canal fuera de rango (1 a ' + canalMax + ')' };
  if (!ACCIONES.has(accion)) return { ok: false, motivo: 'acción no permitida (solo encender o apagar)' };
  return { ok: true, canal: c, accion, payload: { modulo: 'PICK_TO_LIGHT_MILLAR', accion, ubicacion: c } };
}

// La dirección para mostrar en el registro: nunca lleva usuario ni clave.
const direccionSegura = cfg => cfg.host ? (cfg.cifrado ? 'mqtts://' : 'mqtt://') + cfg.host : cfg.url;

module.exports = { leerConfigLuces, validarOrden, direccionSegura, ACCIONES, BROKERS_PUBLICOS };
