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

      const prompt = `Analiza esta guía de Shalom. Extrae únicamente estos 4 campos en formato JSON puro (sin texto adicional ni markdown). Las claves deben ser exactamente: numero_orden, codigo_orden, remitente, destinatario.`;

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

const opcionesCron = { timezone: 'America/Lima' };
cron.schedule('0 9 * * *', chequearPedidosPendientes, opcionesCron);
cron.schedule('0 15 * * *', chequearPedidosPendientes, opcionesCron);

bot.launch().then(() => {
  console.log('🤖 Bot en línea y listo para producción.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
