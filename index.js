require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const cron = require('node-cron');
const db = require('./database');
const { rastrearPedidoShalom } = require('./scraper');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Manejador global para evitar que el bot crashee por errores de red
bot.catch((err, ctx) => {
  console.error('[ERROR GLOBAL]:', err.message || err);
});

// Cola de promesas para respetar el límite de 3 imágenes por minuto de Groq
let procesadorCola = Promise.resolve();

// 1. Recepción y procesamiento de comprobantes
bot.on('photo', async (ctx) => {
  await ctx.reply('⏳ Imagen en cola. Procesando de forma secuencial para no saturar la red...');

  procesadorCola = procesadorCola.then(async () => {
    try {
      const photo = ctx.message.photo.pop();
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);

      const response = await fetch(fileLink.href);
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const imageUrl = `data:image/jpeg;base64,${base64Data}`;

      const prompt = `Analiza esta guía de Shalom. Extrae únicamente estos 4 campos en formato JSON puro (sin texto adicional ni markdown). Las claves deben ser exactamente: numero_orden, codigo_orden, remitente, destinatario.`;

      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }
        ],
        model: "qwen/qwen3.8-27b",
        temperature: 0,
        max_tokens: 150, 
      });

      const textoRespuesta = chatCompletion.choices[0].message.content;
      
      const cleanJson = textoRespuesta.replace(/```json|```/g, '').trim();
      const jsonStart = cleanJson.indexOf('{');
      const jsonEnd = cleanJson.lastIndexOf('}') + 1;
      const datos = JSON.parse(cleanJson.slice(jsonStart, jsonEnd));

      // Verificación de duplicados en BD
      db.get(
        `SELECT id, estado, destinatario FROM pedidos WHERE numero_orden = ?`,
        [datos.numero_orden],
        (err, pedidoExistente) => {
          if (err) return console.error('Error en BD:', err);

          if (pedidoExistente) {
            ctx.reply(`⚠️ Guía ya registrada previamente:\n📦 Orden: ${datos.numero_orden}\n📌 Estado: ${pedidoExistente.estado}`);
          } else {
            db.run(
              `INSERT INTO pedidos (numero_orden, codigo_orden, remitente, destinatario, chat_id) VALUES (?, ?, ?, ?, ?)`,
              [datos.numero_orden, datos.codigo_orden, datos.remitente, datos.destinatario, ctx.chat.id],
              function (insertErr) {
                if (insertErr) return console.error('Error al insertar:', insertErr);
                ctx.reply(`✅ Guía registrada:\n\n📦 Orden: ${datos.numero_orden}\n🔑 Código: ${datos.codigo_orden}\n👤 De: ${datos.remitente}\n🎯 Para: ${datos.destinatario}`);
              }
            );
          }
        }
      );

      // Pausa obligatoria de 20s para evadir límite de ITPM de Groq
      await new Promise(resolve => setTimeout(resolve, 20000));

    } catch (error) {
      console.error('\n[ERROR EN PROCESAMIENTO DE IMAGEN]:', error.message || error);
      ctx.reply('❌ No se pudo procesar la imagen actual. Asegúrate de que el texto sea legible.');
    }
  }).catch(err => console.error("[ERROR EN COLA]:", err));
});

// 2. Alarma Diaria para rastreo en web (Playwright)
cron.schedule('0 15 * * *', async () => {
  console.log('--- Iniciando chequeo diario de pedidos pendientes ---');

  db.all(`SELECT * FROM pedidos WHERE estado != 'En destino'`, async (err, pedidos) => {
    if (err) return console.error(err);

    for (const pedido of pedidos) {
      console.log(`Verificando orden: ${pedido.numero_orden}`);
      const nuevoEstado = await rastrearPedidoShalom(pedido.numero_orden, pedido.codigo_orden);

      if (nuevoEstado && nuevoEstado !== pedido.estado) {
        db.run(`UPDATE pedidos SET estado = ? WHERE id = ?`, [nuevoEstado, pedido.id]);

        if (nuevoEstado === 'En destino') {
          bot.telegram.sendMessage(
            pedido.chat_id,
            `🎉 ¡Tu pedido ha llegado a destino!\n\n📦 Orden: ${pedido.numero_orden}\n🎯 Destinatario: ${pedido.destinatario}`
          );
        }
      }
      
      // Pausa de 3 segundos entre consultas web para no saturar a Shalom
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  });
});

// 3. Inicialización
bot.launch().then(() => {
  console.log('🤖 Bot en línea y listo para producción.');
});

// Apagado seguro
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));