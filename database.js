const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'pedidos.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_orden TEXT,
    codigo_orden TEXT,
    remitente TEXT,
    destinatario TEXT,
    estado TEXT DEFAULT 'Pendiente',
    chat_id TEXT,
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

module.exports = db;