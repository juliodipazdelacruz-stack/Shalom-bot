const { chromium } = require('playwright');

const LAUNCH_OPTIONS = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--no-first-run',
    '--renderer-process-limit=1',
  ],
};

async function crearNavegador() {
  return chromium.launch(LAUNCH_OPTIONS);
}

async function rastrearPedidoShalom(numeroOrden, codigoOrden, pageExterna) {
  const browser = pageExterna ? null : await crearNavegador();
  const page = pageExterna || await browser.newPage();

  try {
    await page.goto('https://shalom.com.pe/rastrea', {
      timeout: 30000,
      waitUntil: 'domcontentloaded',
    });

    await page.fill('input[placeholder="N° de Orden"]', String(numeroOrden));
    await page.fill('input[placeholder="Código de Orden"]', String(codigoOrden));
    await page.click('button:has-text("Buscar")');

    const estadoLocator = page.locator('div.text-4xl.font-bold');
    await estadoLocator.first().waitFor({ timeout: 8000 }).catch(() => {});

    let textoObtenido = '';
    if (await estadoLocator.count() > 0) {
      textoObtenido = await estadoLocator.first().innerText();
    } else {
      textoObtenido = await page.innerText('body');
    }

    const estadoLimpio = textoObtenido.toUpperCase();

    if (estadoLimpio.includes('ENTREGADO') || estadoLimpio.includes('EN DESTINO')) {
      return 'En destino';
    }
    if (estadoLimpio.includes('EN TRÁNSITO') || estadoLimpio.includes('TRÁNSITO')) {
      return 'En tránsito';
    }
    if (estadoLimpio.includes('NO SE ENCONTRARON') || estadoLimpio.includes('INCORRECTO')) {
      return 'Datos incorrectos';
    }

    return 'Pendiente';
  } catch (error) {
    console.error(`Error al rastrear orden ${numeroOrden}:`, error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { rastrearPedidoShalom, crearNavegador };
