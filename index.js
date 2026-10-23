require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const cron = require('node-cron');
const { get, run, all } = require('./database');
const { rastrearPedidoShalom, crearNavegador } = require('./scraper');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

bot.catch((err) => {
  console.error('[ERROR GLOBAL]:', err.message || err);
});

let procesadorCola = Promise.resolve();

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elegirFoto(photos) {
  const ordenadas = [...photos].sort((a, b) => (a.width || 0) - (b.width || 0));
  const suficiente = [...ordenadas].reverse().find((p) => (p.width || 0) <= 800);
  return suficiente || ordenadas[ordenadas.length - 1];
}

function extraerJson(texto) {
  const limpio = String(texto || '').replace(/```json|```/g, '').trim();
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}') + 1;
  if (inicio === -1 || fin <= inicio) {
    throw new Error('La respuesta no contiene JSON válido');
  }
  return JSON.parse(limpio.slice(inicio, fin));
}

function mensajeLlegada(pedido) {
  return `📦 *¡Tu paquete ya está en agencia SHALOM!*\n\nHola *${pedido.destinatario}*, te informamos que tu producto está listo para ser retirado.\n\n📋 *Datos de tu envío:*\n▫️ *Nro. Orden:* ${pedido.numero_orden}\n▫️ *Código:* ${pedido.codigo_orden}\n\n⚠️ *IMPORTANTE:* Para poder brindarte la clave de retiro, es necesario realizar el abono del saldo pendiente.\n_(Verificamos pagos de 8:00 AM a 6:00 PM. Fuera de este horario, se procesan al día siguiente)._\n\n⏳ Recuerda que tienes un plazo máximo de *2 días* para recogerlo. Pasado este tiempo, el producto retornará al almacén sin opción a reembolso.\n\n📍 *Rastrea tu pedido aquí:* https://rastrea.shalom.pe\n\n🙌🏼 ¡Gracias por confiar en nosotros!\n*(Si ya realizaste el pago, puedes omitir este mensaje).*`;
}

let rastreoEnCurso = false;

async function chequearPedidosPendientes() {
  if (rastreoEnCurso) {
    console.log('Chequeo omitido: ya hay un rastreo en curso.');
    return;
  }

  rastreoEnCurso = true;
  console.log('--- Iniciando chequeo de pedidos pendientes ---');

  let browser;
  try {
    const pedidos = await all(`SELECT * FROM pedidos WHERE estado != 'En destino'`);
    if (!pedidos.length) return;

    browser = await crearNavegador();

    for (const pedido of pedidos) {
      console.log(`Verificando orden: ${pedido.numero_orden}`);
      const page = await browser.newPage();
      try {
        const nuevoEstado = await rastrearPedidoShalom(pedido.numero_orden, pedido.codigo_orden, page);

        if (nuevoEstado && nuevoEstado !== pedido.estado) {
          await run(`UPDATE pedidos SET estado = ? WHERE id = ?`, [nuevoEstado, pedido.id]);

          if (nuevoEstado === 'En destino') {
            await bot.telegram.sendMessage(pedido.chat_id, mensajeLlegada(pedido), {
              parse_mode: 'Markdown',
            });
          }
        }
      } finally {
        await page.close();
      }

      await dormir(3000);
    }
  } catch (err) {
    console.error('Error en chequeo diario:', err.message || err);
  } finally {
    if (browser) await browser.close();
    rastreoEnCurso = false;
  }
}

bot.on('photo', async (ctx) => {
  await ctx.reply('⏳ Imagen en cola. Procesando de forma secuencial para no saturar la red...');

  procesadorCola = procesadorCola.then(async () => {
    try {
      const photo = elegirFoto(ctx.message.photo);
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);

      const response = await fetch(fileLink.href);
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      const imageUrl = `data:image/jpeg;base64,${base64Data}`;

      const prompt = `Analiza detalladamente esta guía de Shalom de arriba a abajo. Extrae únicamente estos 4 campos en formato JSON puro (sin texto adicional ni markdown). Las claves deben ser exactamente: numero_orden, codigo_orden, remitente, destinatario.

      REGLAS CRÍTICAS DE EXTRACCIÓN:
      1. NÚMERO DE ORDEN: Los números de orden de Shalom tienen una longitud fija y completa. Fíjate muy bien en los bordes y el final del texto impreso. ¡No omitas ningún dígito del final!
      2. PRECISIÓN EN DÍGITOS (6 vs 8): En los tickets térmicos, los números "6" y "8" pueden parecerse por la borrosidad de la tinta. Analiza la estructura del carácter: si el círculo superior o inferior está abierto, es un 6; si está completamente sellado en ambos lados, es un 8. Evita confundir el 6 con el 8.
      3. PEGADOS COMUNES: Si el número de orden y la palabra "CÓDIGO" están juntos (ej: "100070441CÓDIGO"), sepáralos correctamente e ignora la C
      4. NOMBRES COMPLETOS: Extrae el nombre del remitente y del destinatario completos, sin recortar letras al final de las líneas.`;
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        model: 'qwen/qwen3.8-27b',
        temperature: 0,
        max_tokens: 150,
      });

      const datos = extraerJson(chatCompletion.choices[0].message.content);
      const pedidoExistente = await get(
        `SELECT id, estado, destinatario FROM pedidos WHERE numero_orden = ?`,
        [datos.numero_orden]
      );

      if (pedidoExistente) {
        await ctx.reply(
          `⚠️ Guía ya registrada previamente:\n📦 Orden: ${datos.numero_orden}\n📌 Estado: ${pedidoExistente.estado}`
        );
      } else {
        await run(
          `INSERT INTO pedidos (numero_orden, codigo_orden, remitente, destinatario, chat_id) VALUES (?, ?, ?, ?, ?)`,
          [datos.numero_orden, datos.codigo_orden, datos.remitente, datos.destinatario, ctx.chat.id]
        );
        await ctx.reply(
          `✅ Guía registrada:\n\n📦 Orden: ${datos.numero_orden}\n🔑 Código: ${datos.codigo_orden}\n👤 De: ${datos.remitente}\n🎯 Para: ${datos.destinatario}`
        );
      }

      await dormir(20000);
    } catch (error) {
      console.error('\n[ERROR EN PROCESAMIENTO DE IMAGEN]:', error.message || error);
      await ctx.reply('❌ No se pudo procesar la imagen actual. Asegúrate de que el texto sea legible.');
    }
  }).catch((err) => console.error('[ERROR EN COLA]:', err));
});

async function procesarPedidosPendientes() {
  console.log('--- Iniciando chequeo programado de pedidos ---');
  
  db.all(`SELECT * FROM pedidos WHERE estado != 'En destino'`, async (err, pedidos) => {
    if (err) return console.error(err);

    for (const pedido of pedidos) {
      console.log(`Verificando orden: ${pedido.numero_orden}`);
      const nuevoEstado = await rastrearPedidoShalom(pedido.numero_orden, pedido.codigo_orden);

      if (nuevoEstado && nuevoEstado !== pedido.estado) {
        db.run(`UPDATE pedidos SET estado = ? WHERE id = ?`, [nuevoEstado, pedido.id]);

        if (nuevoEstado === 'En destino') {
          const mensajeLlegada = `📦 *¡Tu paquete ya está en agencia SHALOM!*\n\nHola *${pedido.destinatario}*, te informamos que tu producto está listo para ser retirado.\n\n📋 *Datos de tu envío:*\n▫️ *Nro. Orden:* ${pedido.numero_orden}\n▫️ *Código:* ${pedido.codigo_orden}\n\n⚠️ *IMPORTANTE:* Para poder brindarte la clave de retiro, es necesario realizar el abono del saldo pendiente.\n_(Verificamos pagos de 8:00 AM a 6:00 PM. Fuera de este horario, se procesan al día siguiente)._\n\n⏳ Recuerda que tienes un plazo máximo de *2 días* para recogerlo. Pasado este tiempo, el producto retornará al almacén sin opción a reembolso.\n\n📍 *Rastrea tu pedido aquí:* https://rastrea.shalom.pe\n\n🙌🏼 ¡Gracias por confiar en nosotros!\n*(Si ya realizaste el pago, puedes omitir este mensaje).*`;

          bot.telegram.sendMessage(pedido.chat_id, mensajeLlegada, { parse_mode: 'Markdown' });
        }
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  });
}

// Horario 1: Todos los días a las 10:30 AM
cron.schedule('30 10 * * *', procesarPedidosPendientes);

// Horario 2: Todos los días a las 3:00 PM (15:00)
cron.schedule('0 15 * * *', procesarPedidosPendientes);

// 3. Inicialización
bot.launch().then(() => {
  console.log('🤖 Bot en línea y listo para producción.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
