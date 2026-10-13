// Servidor de pruebas con la sesion OBLIGATORIA, como en produccion.
process.env.PORT='3011';
process.env.STORAGE='sqlite';
process.env.DATA_DIR=require('path').join(__dirname,'data-prueba');
process.env.SQLITE_PATH=require('path').join(__dirname,'data-prueba','millar.db');
process.env.AUTH_ENFORCE='true';
process.env.SESSION_SECRET='local';
process.env.RESET_PASS='local';
require('./server.js');
