const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'pedidos.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

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

  db.run(`
    DELETE FROM pedidos
    WHERE id NOT IN (
      SELECT MIN(id) FROM pedidos GROUP BY numero_orden
    )
  `);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_numero_orden ON pedidos(numero_orden)`);
});

module.exports = { db, run, get, all };
