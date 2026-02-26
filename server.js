const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── Rutas de archivos de datos ────────────────────────────────────
const DATA_DIR          = path.join(__dirname, 'data');
const IA_STATE_FILE     = path.join(DATA_DIR, 'ia_state.json');
const IA_RECORDS_FILE   = path.join(DATA_DIR, 'ia_records.json');

// Crear carpeta data si no existe
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Helpers de persistencia ───────────────────────────────────────
function readJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('Error leyendo', filePath, e.message);
  }
  return defaultValue;
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error('Error escribiendo', filePath, e.message);
  }
}

// ── Estado Control de Piso (en memoria) ──────────────────────────
const MODULES = ['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
                 'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
                 'M21','M22','M23','M24','M25','M26','M27'];

const states  = {};
const lastMec = {};
MODULES.forEach(id => { states[id] = 'green'; lastMec[id] = ''; });

// ── Estado Control de Asistencia (en disco) ───────────────────────
const IA_INITIAL_STATE = {
  supervisors: [
    { id:'maria_pineda',  name:'María Pineda',  pass:'1234',  isAdmin:false, areas:['M01','M02','M03','M04','M05','M06','M07','M08','M09'] },
    { id:'yurany_zapata', name:'Yurany Zapata', pass:'1234',  isAdmin:false, areas:['M10','M15','M16','M17','M18','M19','M20','M21'] },
    { id:'mery_tabares',  name:'Mery Tabares',  pass:'1234',  isAdmin:false, areas:['M22','M23','M24','M25','M26','M27'] },
    { id:'leidy_galeano', name:'Leidy Galeano', pass:'1234',  isAdmin:false, areas:['M01','M02','M03','M04','M05','M06','M07','M08','M09','M10','M11','M12','M13','M14','M15','M16','M17','M18','M19','M20','M21','M22','M23','M24','M25','M26','M27'] },
    { id:'beiro',         name:'Beiro',          pass:'B1234', isAdmin:true,  areas:[] }
  ],
  employees: [
    {id:'e1',name:'ADRIANA MARIA RODRIGUEZ CORREA',supId:'maria_pineda'},{id:'e2',name:'ALBA LUCIA POSSO GIRALDO',supId:'maria_pineda'},{id:'e3',name:'ALEXANDRA MARIA RENDON GRISALES',supId:'maria_pineda'},{id:'e4',name:'AMANDA MEJIA GARCIA',supId:'maria_pineda'},{id:'e5',name:'ANA CATALINA MESA BETANCUR',supId:'maria_pineda'},{id:'e6',name:'ANA RAQUEL MARTINEZ PATIÑO',supId:'maria_pineda'},{id:'e7',name:'ANGELA MARIA GIRALDO ROJAS',supId:'maria_pineda'},{id:'e8',name:'ASTRID YURANY RAMIREZ ARCILA',supId:'maria_pineda'},{id:'e9',name:'BRILLIN ESTEFANI BOLAÑOS SEPULVEDA',supId:'maria_pineda'},{id:'e10',name:'CELENY PATRICIA TUBERQUIA PINO',supId:'maria_pineda'},{id:'e11',name:'DANEXY LISBETH PALENCIA ROMERO',supId:'maria_pineda'},{id:'e12',name:'DEISY ALEJANDRA VILLA YEPES',supId:'maria_pineda'},{id:'e13',name:'DEISY JULIANA RUIZ CESPEDES',supId:'maria_pineda'},{id:'e14',name:'DIANA CRISTINA GIRALDO MORA',supId:'maria_pineda'},{id:'e15',name:'DIANA MILENA MAZO GUERRA',supId:'maria_pineda'},{id:'e16',name:'DIDIER HERNAN CEBALLOS CIFUENTES',supId:'maria_pineda'},{id:'e17',name:'EDILMARY AREIZA AREIZA',supId:'maria_pineda'},{id:'e18',name:'EDISSON ALONSO ARISTIZABAL SALAZAR',supId:'maria_pineda'},{id:'e19',name:'ELIANA MARÍA JARAMILLO LÓPEZ',supId:'maria_pineda'},{id:'e20',name:'ESTEFANIA ZAPATA SIERRA',supId:'maria_pineda'},{id:'e21',name:'EVELIN DAYANA MARIN CARO',supId:'maria_pineda'},{id:'e22',name:'FLOR EDILIA OSPINA MORENO',supId:'maria_pineda'},{id:'e23',name:'FLOR EMILSE JIMENEZ SUCERQUIA',supId:'maria_pineda'},{id:'e24',name:'GLADYS AMANDA DIOSA GONZALEZ',supId:'maria_pineda'},{id:'e25',name:'GLORIA YANETH URREGO CATAÑO',supId:'maria_pineda'},{id:'e26',name:'GRETTYS MARIA ALVEAR ARIAS',supId:'maria_pineda'},{id:'e27',name:'HILDA NURY GIRALDO ZULUAGA',supId:'maria_pineda'},{id:'e28',name:'ISABEL CRISTINA MESA MORALES',supId:'maria_pineda'},{id:'e29',name:'JOHANNA CRISTINA LOPEZ ESTRADA',supId:'maria_pineda'},{id:'e30',name:'JORGE ANDRES TABORDA TORRES',supId:'maria_pineda'},{id:'e31',name:'KATHERNIE FLOREZ CORTES',supId:'maria_pineda'},{id:'e32',name:'KELLY ALEXANDRA SANCHEZ ARROYAVE',supId:'maria_pineda'},{id:'e33',name:'KELLY KATHERINE CHAVERRA AMAYA',supId:'maria_pineda'},{id:'e34',name:'LAURA FERNANDA ROMAÑA MORENO',supId:'maria_pineda'},{id:'e35',name:'LEIDY ALEJANDRA SALAS QUINTANA',supId:'maria_pineda'},{id:'e36',name:'LEIDY YOHANA CANO LOPEZ',supId:'maria_pineda'},{id:'e37',name:'LEYDI YOHANA OSPINA URREGO',supId:'maria_pineda'},{id:'e38',name:'LILIANA JANETH MONTOYA VELASQUEZ',supId:'maria_pineda'},{id:'e39',name:'LILIANA MARIA CRESPO MONCADA',supId:'maria_pineda'},{id:'e40',name:'LILLIANA MONCADA ESTRADA',supId:'maria_pineda'},{id:'e41',name:'LISNEY ALVENIS ESTRADA CARDONA',supId:'maria_pineda'},{id:'e42',name:'LUZ AMPARO HENAO BETANCUR',supId:'maria_pineda'},{id:'e43',name:'LUZ ESTELLA MONTOYA MEJIA',supId:'maria_pineda'},{id:'e44',name:'LUZ UBITER URREGO GOEZ',supId:'maria_pineda'},{id:'e45',name:'MARCELA ROMAN GRAJALES',supId:'maria_pineda'},{id:'e46',name:'MARGARITA MARIA GIL QUIROZ',supId:'maria_pineda'},{id:'e47',name:'MARIA CATALINA AGUDELO MONSALVE',supId:'maria_pineda'},{id:'e48',name:'MARIA NOHEMY GRACIANO MORALES',supId:'maria_pineda'},{id:'e49',name:'MARIA TERESA ESPINOSA ALVAREZ',supId:'maria_pineda'},{id:'e50',name:'MARIBEL AGUIRRE TORRES',supId:'maria_pineda'},{id:'e51',name:'MARIELA YARCE OROZCO',supId:'maria_pineda'},{id:'e52',name:'MARTHA CECILIA CAÑAS MEDINA',supId:'maria_pineda'},{id:'e53',name:'MONICA ALEJANDRA OSORIO GOMEZ',supId:'maria_pineda'},{id:'e54',name:'NANCY ESTELA OCHOA RIVERA',supId:'maria_pineda'},{id:'e55',name:'NEYLA ALVAREZ CALLEJAS',supId:'maria_pineda'},{id:'e56',name:'NORA MILENA RIOS HURTADO',supId:'maria_pineda'},{id:'e57',name:'NUBIA DEL SOCORRO ARAQUE SANCHEZ',supId:'maria_pineda'},{id:'e58',name:'OLGA CECILIA HIGUITA ARIAS',supId:'maria_pineda'},{id:'e59',name:'OLGA LILIANA BEDOYA HENAO',supId:'maria_pineda'},{id:'e60',name:'OLGA PATRICIA RINCON HERNANDEZ',supId:'maria_pineda'},{id:'e61',name:'PAULA ANDREA AGUDELO BUSTAMANTE',supId:'maria_pineda'},{id:'e62',name:'PAULA ANDREA CASTRILLON USUGA',supId:'maria_pineda'},{id:'e63',name:'SANDRA MARIA PALACIOS CORDOBA',supId:'maria_pineda'},{id:'e64',name:'SANDRA MILENA BURITICA RIOS',supId:'maria_pineda'},{id:'e65',name:'SANDRA PATRICIA ROJAS YEPES',supId:'maria_pineda'},{id:'e66',name:'SANDRA YULIETH LOPEZ LLANO',supId:'maria_pineda'},{id:'e67',name:'SILVIA ELENA BEDOYA USMA',supId:'maria_pineda'},{id:'e68',name:'SONIA LUZ HOYOS GARCES',supId:'maria_pineda'},{id:'e69',name:'SONIA PATRICIA URAN VELASQUEZ',supId:'maria_pineda'},{id:'e70',name:'SORMALIS MARIN ROMAN',supId:'maria_pineda'},{id:'e71',name:'VALENTINA PARDO MACHADO',supId:'maria_pineda'},{id:'e72',name:'VALERIA ACEVEDO GRAJALES',supId:'maria_pineda'},{id:'e73',name:'VANESA ALEJANDRA SILVA GARCIA',supId:'maria_pineda'},{id:'e74',name:'VERONICA ANDREA GARCIA GOMEZ',supId:'maria_pineda'},{id:'e75',name:'WENDY JOHANA MELO CARVALI',supId:'maria_pineda'},{id:'e76',name:'WILDER ALEJANDRO MARIN GALEANO',supId:'maria_pineda'},{id:'e77',name:'YANCELLY ZAPATA MUÑOZ',supId:'maria_pineda'},{id:'e78',name:'YANEIRI DEL VALLE ANGARITA RUIZ',supId:'maria_pineda'},{id:'e79',name:'YENY ANDREA CELADA YEPES',supId:'maria_pineda'},{id:'e80',name:'YESICA ALEXANDRA ALGARIN CABEZAS',supId:'maria_pineda'},{id:'e81',name:'FABIAN ESTEBAN SOSA CARDENAS',supId:'maria_pineda'},{id:'e82',name:'KATHERINE LONDOÑO TORO',supId:'maria_pineda'},
    {id:'e83',name:'ALDERIS DEL SOCORRO GARCIA GODOY',supId:'yurany_zapata'},{id:'e84',name:'ALICIA RODRIGUEZ RIOS',supId:'yurany_zapata'},{id:'e85',name:'ANDRES FELIPE LOPEZ CORREA',supId:'yurany_zapata'},{id:'e86',name:'ASTRID FERNANDA ESCOBAR CHAGUENDO',supId:'yurany_zapata'},{id:'e87',name:'BEATRIZ ELENA LEZCANO HERNANDEZ',supId:'yurany_zapata'},{id:'e88',name:'BLANCA OLIVA OQUENDO GIRALDO',supId:'yurany_zapata'},{id:'e89',name:'CRISTIAN CAMILO ORREGO BOHORQUEZ',supId:'yurany_zapata'},{id:'e90',name:'DALIA MILDREY LORA FIGUEROA',supId:'yurany_zapata'},{id:'e91',name:'ELSY BEATRIZ PINO MAZO',supId:'yurany_zapata'},{id:'e92',name:'ERICA MARCELA HOLGUIN SUAZA',supId:'yurany_zapata'},{id:'e93',name:'GLORIA INES JARAMILLO CUERVO',supId:'yurany_zapata'},{id:'e94',name:'ISABEL CRISTINA PEREZ GALLEGO',supId:'yurany_zapata'},{id:'e95',name:'JOHANA ANDREA GIL',supId:'yurany_zapata'},{id:'e96',name:'JOHNNY ALEXANDER CESPEDES RAMIREZ',supId:'yurany_zapata'},{id:'e97',name:'CRISTIAN CAMILO ARANGO CARDONA',supId:'yurany_zapata'},{id:'e98',name:'KELLY YACETH MENA PALACIO',supId:'yurany_zapata'},{id:'e99',name:'KEYLA EDITH HOYOS LOPEZ',supId:'yurany_zapata'},{id:'e100',name:'KIMBERLY LONDOÑO VELEZ',supId:'yurany_zapata'},{id:'e101',name:'LEIDY JOHANA MAZO JARAMILLO',supId:'yurany_zapata'},{id:'e102',name:'LEIDY JULEY ZULUAGA DAVILA',supId:'yurany_zapata'},{id:'e103',name:'LEIDY MILENA RAMIREZ RAMIREZ',supId:'yurany_zapata'},{id:'e104',name:'LEIDY PAOLA GOMEZ VELASQUEZ',supId:'yurany_zapata'},{id:'e105',name:'LICED CAMILA RODRIGUEZ ARANGO',supId:'yurany_zapata'},{id:'e106',name:'LINA MARCELA HIGUITA FRANCO',supId:'yurany_zapata'},{id:'e107',name:'LUZ DARY GARCIA BOTERO',supId:'yurany_zapata'},{id:'e108',name:'LUZ ELENA MONTOYA ACEVEDO',supId:'yurany_zapata'},{id:'e109',name:'MARCELA PEREZ RIOS',supId:'yurany_zapata'},{id:'e110',name:'MARIA EUGENIA CHANCI MISAS',supId:'yurany_zapata'},{id:'e111',name:'MARIA ISABEL TAMAYO PUERTA',supId:'yurany_zapata'},{id:'e112',name:'MARIA JOSE SALCEDO PALACINO',supId:'yurany_zapata'},{id:'e113',name:'MARISOL OTALVARO CLAVIJO',supId:'yurany_zapata'},{id:'e114',name:'MARISOL SAENZ RESTREPO',supId:'yurany_zapata'},{id:'e115',name:'MARTHA VALLE CARVAJAL',supId:'yurany_zapata'},{id:'e116',name:'MONICA ISABEL QUIROZ LOAIZA',supId:'yurany_zapata'},{id:'e117',name:'MONICA MARIA HOLGUIN SUAZA',supId:'yurany_zapata'},{id:'e118',name:'NATALIA ANDREA TORRES USUGA',supId:'yurany_zapata'},{id:'e119',name:'NORA ELENA MAZO JARAMILLO',supId:'yurany_zapata'},{id:'e120',name:'PAULA YECENIA VELASQUEZ OSPINA',supId:'yurany_zapata'},{id:'e121',name:'REDY MARIA RIVERA LORA',supId:'yurany_zapata'},{id:'e122',name:'RUVIELA MORENO MORENO',supId:'yurany_zapata'},{id:'e123',name:'SINDY PAOLA GARCIA GARCES',supId:'yurany_zapata'},{id:'e124',name:'VERONICA ALEJANDRA VARELAS LOPEZ',supId:'yurany_zapata'},{id:'e125',name:'YENNY ANDREA CAÑAS MADRID',supId:'yurany_zapata'},{id:'e126',name:'YENNY MILENA ARBOLEDA LOAIZA',supId:'yurany_zapata'},{id:'e127',name:'YORMAN ESTIVEN CEBALLOS CIFUENTES',supId:'yurany_zapata'},{id:'e128',name:'YUDY MILENA DAVID',supId:'yurany_zapata'},{id:'e129',name:'YULIETH DAMARIS ASPRILLA CARDONA',supId:'yurany_zapata'},{id:'e130',name:'YULY JANETH CAÑAS MADRID',supId:'yurany_zapata'},{id:'e131',name:'YURLEY CAROLINA RESTREPO TORO',supId:'yurany_zapata'},{id:'e132',name:'ZORELLIZ KARINA GUILLEN HERNANDEZ',supId:'yurany_zapata'},{id:'e133',name:'DIVER ALEXIS YEPES GOMEZ',supId:'yurany_zapata'},{id:'e134',name:'MARIA TERESA RODRIGUEZ ARELLANO',supId:'yurany_zapata'},{id:'e135',name:'HILIAN BAILARIN BAILARIN',supId:'yurany_zapata'},{id:'e136',name:'LEIDY DIANA BOLIVAR SEPULVEDA',supId:'yurany_zapata'},{id:'e137',name:'ELIANA ACENED AREIZA AREIZA',supId:'yurany_zapata'},{id:'e138',name:'JOSE ALEJANDRO SILVA VARGAS',supId:'yurany_zapata'},{id:'e139',name:'LEIDY TATIANA GUTIERREZ OSPINA',supId:'yurany_zapata'},{id:'e140',name:'DIANA MARCELA URIBE JIMENEZ',supId:'yurany_zapata'},{id:'e141',name:'MANUELA ALVAREZ RESTREPO',supId:'yurany_zapata'},{id:'e142',name:'MARIA CECILIA VERGARA',supId:'yurany_zapata'},{id:'e143',name:'MARIA GABRIELA REYES NOGUERA',supId:'yurany_zapata'},{id:'e144',name:'YENIFER USUGA USUGA',supId:'yurany_zapata'},{id:'e145',name:'CRISTIAN CAMILO MESA ARROYAVE',supId:'yurany_zapata'},
    {id:'e146',name:'ADRIANA JANNET ARENAS OSORNO',supId:'mery_tabares'},{id:'e147',name:'ALEJANDRO CARO VELASQUEZ',supId:'mery_tabares'},{id:'e148',name:'ANA CECILIA CORREA ORTIZ',supId:'mery_tabares'},{id:'e149',name:'ANA JOSEFINA ESPINEL GOMEZ',supId:'mery_tabares'},{id:'e150',name:'ANA MILENA PINO LOPEZ',supId:'mery_tabares'},{id:'e151',name:'ANDERSON ALEXIS AGUDELO RODRIGUEZ',supId:'mery_tabares'},{id:'e152',name:'ANGELA MILENA RESTREPO AGUILAR',supId:'mery_tabares'},{id:'e153',name:'ANNY YOHANA GUISAO MONSALVE',supId:'mery_tabares'},{id:'e154',name:'BEATRIZ ELENA ARIAS CORREA',supId:'mery_tabares'},{id:'e155',name:'BETY ANDREA GALLEGO RODRIGUEZ',supId:'mery_tabares'},{id:'e156',name:'CAROLINA GIRALDO RODRIGUEZ',supId:'mery_tabares'},{id:'e157',name:'CATALINA MARIA RAMOS IDARRAGA',supId:'mery_tabares'},{id:'e158',name:'CLAUDIA PATRICIA RUIZ ALCARAZ',supId:'mery_tabares'},{id:'e159',name:'CLAUDIA YANINN JARAMILLO RESTREPO',supId:'mery_tabares'},{id:'e160',name:'DEICY YULIETH MARTINEZ CARDONA',supId:'mery_tabares'},{id:'e161',name:'DIOSELINA MARIA BEDOYA SUAREZ',supId:'mery_tabares'},{id:'e162',name:'ERMIS BELL VALLE CARVAJAL',supId:'mery_tabares'},{id:'e163',name:'ESTEFANY RESTREPO PALACIO',supId:'mery_tabares'},{id:'e164',name:'FERNANDA HERNANDEZ BOTERO',supId:'mery_tabares'},{id:'e165',name:'JUAN DIEGO RODRIGUEZ MORA',supId:'mery_tabares'},{id:'e166',name:'KAREN ELIZABETH ZULETA',supId:'mery_tabares'},{id:'e167',name:'KAROL EDITH CASTAÑO SOTO',supId:'mery_tabares'},{id:'e168',name:'LEIDY ALEXANDRA JARAMILLO MARTINEZ',supId:'mery_tabares'},{id:'e169',name:'LEIDY YOHANA BUITRAGO PELAEZ',supId:'mery_tabares'},{id:'e170',name:'LINA MARCELA CARVALLO',supId:'mery_tabares'},{id:'e171',name:'LINA MARIA RESTREPO JIMENEZ',supId:'mery_tabares'},{id:'e172',name:'LINA MARIA RUIZ MURILLO',supId:'mery_tabares'},{id:'e173',name:'LUZ DARLIN PALACIOS VALENCIA',supId:'mery_tabares'},{id:'e174',name:'LUZ DARY RODRIGUEZ SUAREZ',supId:'mery_tabares'},{id:'e175',name:'LUZ MARLENY PRECIADO MESA',supId:'mery_tabares'},{id:'e176',name:'LUZ NELLY GIRALDO ARCILA',supId:'mery_tabares'},{id:'e177',name:'LUZ NELLY OSPINA TUBERQUIA',supId:'mery_tabares'},{id:'e178',name:'MANUEL ALEJANDRO HOLGUIN CASTAÑO',supId:'mery_tabares'},{id:'e179',name:'MARIA ALEJANDRA TORRES RUIZ',supId:'mery_tabares'},{id:'e180',name:'MARIA IRENE GIRALDO TOBON',supId:'mery_tabares'},{id:'e181',name:'MARIA LILIANA GOMEZ RUIZ',supId:'mery_tabares'},{id:'e182',name:'MARIANA SANCHEZ MARTINEZ',supId:'mery_tabares'},{id:'e183',name:'MIRIAN ROSA AGUDELO TUBERQUIA',supId:'mery_tabares'},{id:'e184',name:'NANCY DEL PILAR ZAPATA MARULANDA',supId:'mery_tabares'},{id:'e185',name:'NARLY NAUDITH SUAREZ MARCELO',supId:'mery_tabares'},{id:'e186',name:'NATALIA PATRICIA MORALES MUÑOZ',supId:'mery_tabares'},{id:'e187',name:'NURY DURLEY GOMEZ FRANCO',supId:'mery_tabares'},{id:'e188',name:'OSMEDO DE JESUS HOYOS RIVERA',supId:'mery_tabares'},{id:'e189',name:'PAULA ANDREA MUÑOZ ALZATE',supId:'mery_tabares'},{id:'e190',name:'SANDRA MARCELA ALVAREZ JARAMILLO',supId:'mery_tabares'},{id:'e191',name:'SINDY CATERINE GOMEZ ESPINAL',supId:'mery_tabares'},{id:'e192',name:'YENY PATRICIA RAMIREZ ARBOLEDA',supId:'mery_tabares'},{id:'e193',name:'JORGE ANDRES AGUDELO VELASQUEZ',supId:'mery_tabares'},{id:'e194',name:'ANDRES FELIPE YEPES DURANGO',supId:'mery_tabares'},{id:'e195',name:'HECTOR ALBEIRO MONTOYA PORRAS',supId:'mery_tabares'},{id:'e196',name:'ERIKA PATRICIA PEREZ TORRES',supId:'mery_tabares'},
    {id:'e197',name:'ANGELA MARIA VANEGAS MARIN',supId:'leidy_galeano'},{id:'e198',name:'HELLEN VANESSA GUERRA MUNERA',supId:'leidy_galeano'},{id:'e199',name:'DIANA CAROLINA CORREA CARDONA',supId:'leidy_galeano'},{id:'e200',name:'MARIA CAMILA ROMERO TABARES',supId:'leidy_galeano'},{id:'e201',name:'JOHANA ASTRID HERNANDEZ HERRERA',supId:'leidy_galeano'},{id:'e202',name:'JORGE ANDRES ALVAREZ',supId:'leidy_galeano'},{id:'e203',name:'LAURA RESTREPO COLORADO',supId:'leidy_galeano'},{id:'e204',name:'LUZ MARINA CARDONA VANEGAS',supId:'leidy_galeano'},{id:'e205',name:'MARTA RUBY VALENCIA JIMENEZ',supId:'leidy_galeano'},{id:'e206',name:'PAULA DEL CARMEN VELASQUEZ RAMIREZ',supId:'leidy_galeano'},{id:'e207',name:'SANDRA PATRICIA VELASQUEZ ATEHORTUA',supId:'leidy_galeano'},{id:'e208',name:'SARA DEL CARMEN SEPULVEDA HOYOS',supId:'leidy_galeano'},{id:'e209',name:'WILSON GIRALDO HENAO',supId:'leidy_galeano'},{id:'e210',name:'YOCEDYS DEL CARMEN SALCEDO CORDERO',supId:'leidy_galeano'},{id:'e211',name:'YHULID CRISTINA LONDOÑO MUÑOZ',supId:'leidy_galeano'},{id:'e212',name:'YURY LIZETH CARDENAS PEREZ',supId:'leidy_galeano'},{id:'e213',name:'TOMAS ZAPATA ARROYAVE',supId:'leidy_galeano'},{id:'e214',name:'YEISON ALEXANDER POSSO BETANCOURT',supId:'leidy_galeano'},{id:'e215',name:'LADYS PATRICIA ALVAREZ ACEVEDO',supId:'leidy_galeano'},{id:'e216',name:'LINA MARIA LOAIZA ALVAREZ',supId:'leidy_galeano'},{id:'e217',name:'NELLYS CRISTINA ALVAREZ ACEVEDO',supId:'leidy_galeano'},{id:'e218',name:'DORIS DE LA TRINIDAD MURILLO HENAO',supId:'leidy_galeano'},{id:'e219',name:'MARY LUZ LOPEZ JIMENEZ',supId:'leidy_galeano'},{id:'e220',name:'JENIFFER CAROLINA RESTREPO SANCHEZ',supId:'leidy_galeano'}
  ]
};

// Cargar datos de asistencia desde disco (o usar inicial)
let iaState   = readJSON(IA_STATE_FILE,   null);
let iaRecords = readJSON(IA_RECORDS_FILE, []);

// Si no hay state guardado, usar el inicial y persistirlo
if (!iaState) {
  iaState = JSON.parse(JSON.stringify(IA_INITIAL_STATE));
  writeJSON(IA_STATE_FILE, iaState);
  writeJSON(IA_RECORDS_FILE, iaRecords);
}

function saveIaState()   { writeJSON(IA_STATE_FILE,   iaState);   }
function saveIaRecords() { writeJSON(IA_RECORDS_FILE, iaRecords); }

// ── Servidor HTTP ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

// Ping/pong para mantener conexión viva en Render (evita timeout de 60s)
const PING_INTERVAL = 30000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Enviar estado completo al nuevo cliente
  ws.send(JSON.stringify({
    type:     'init',
    states:   { ...states },
    lastMec:  { ...lastMec },
    iaState:  iaState,
    iaRecords: iaRecords
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // ── Control de Piso: cambio de módulo ──────────────────────
      if (msg.type === 'change' && states[msg.id] !== undefined) {
        states[msg.id] = msg.state;
        if (msg.state === 'red') lastMec[msg.id] = '';
        else if (msg.mecanico)  lastMec[msg.id] = msg.mecanico;

        const broadcast = JSON.stringify({
          type:     'change',
          id:       msg.id,
          state:    msg.state,
          mecanico: msg.mecanico || ''
        });
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === 1) c.send(broadcast);
        });
      }

      // ── Control de Asistencia: nuevo registro ──────────────────
      else if (msg.type === 'ia_add_record') {
        // Eliminar registro previo del mismo empleado/fecha/supervisor
        iaRecords = iaRecords.filter(r =>
          !(r.empName === msg.record.empName &&
            r.date     === msg.record.date    &&
            r.supervisor === msg.record.supervisor)
        );
        iaRecords.push(msg.record);
        saveIaRecords();

        // Broadcast a todos los demás
        const bcast = JSON.stringify({ type: 'ia_add_record', record: msg.record });
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === 1) c.send(bcast);
        });
      }

      // ── Control de Asistencia: eliminar registro ───────────────
      else if (msg.type === 'ia_delete_record') {
        iaRecords = iaRecords.filter(r => r.id !== msg.id);
        saveIaRecords();

        const bcast = JSON.stringify({ type: 'ia_delete_record', id: msg.id });
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === 1) c.send(bcast);
        });
      }

      // ── Control de Asistencia: editar registro ─────────────────
      else if (msg.type === 'ia_edit_record') {
        const idx = iaRecords.findIndex(r => r.id === msg.record.id);
        if (idx > -1) iaRecords[idx] = msg.record;
        saveIaRecords();

        const bcast = JSON.stringify({ type: 'ia_edit_record', record: msg.record });
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === 1) c.send(bcast);
        });
      }

      // ── Control de Asistencia: guardar estado (supervisores, empleados, áreas) ──
      else if (msg.type === 'ia_save_state') {
        iaState = msg.state;
        saveIaState();

        const bcast = JSON.stringify({ type: 'ia_save_state', state: iaState });
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === 1) c.send(bcast);
        });
      }

    } catch (e) {
      console.error('Error procesando mensaje:', e);
    }
  });

  ws.on('close', () => {});
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
