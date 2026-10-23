const { run, db } = require('./database');

run(`
  DELETE FROM pedidos
  WHERE id NOT IN (
    SELECT MIN(id)
    FROM pedidos
    GROUP BY numero_orden
  )
`)
  .then((result) => {
    console.log(`✅ Limpieza completada. Filas duplicadas eliminadas: ${result.changes}`);
  })
  .catch((err) => {
    console.error('❌ Error al intentar borrar:', err);
  })
  .finally(() => {
    db.close();
  });
