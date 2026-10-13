// Arranque local para probar en el navegador. No se usa en el servidor.
// Apunta a data-prueba/ (una copia de los datos reales) para no tocar nada.
process.env.PORT         = '3010';
process.env.STORAGE      = 'sqlite';
process.env.DATA_DIR     = require('path').join(__dirname, 'data-prueba');
process.env.SQLITE_PATH  = require('path').join(__dirname, 'data-prueba', 'millar.db');
process.env.UPLOADS_DIR  = require('path').join(__dirname, 'data-prueba', 'uploads');
process.env.TZ           = 'America/Bogota';
process.env.AUTH_ENFORCE = 'false';
process.env.SESSION_SECRET = 'local';
process.env.RESET_PASS   = 'local';
require('./server.js');
