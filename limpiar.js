const db = require('./database');

// La consulta mantiene el ID mínimo (el original) de cada grupo y borra los demás
const query = `
  DELETE FROM pedidos 
  WHERE id NOT IN (
    SELECT MIN(id) 
    FROM pedidos 
    GROUP BY numero_orden
  )
`;

db.run(query, function (err) {
  if (err) {
    console.error('❌ Error al intentar borrar:', err);
  } else {
    console.log(`✅ Limpieza completada. Filas duplicadas eliminadas: ${this.changes}`);
  }
});