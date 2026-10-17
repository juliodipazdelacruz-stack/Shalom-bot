const { chromium } = require('playwright');

async function rastrearPedidoShalom(numeroOrden, codigoOrden) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://shalom.com.pe/rastrea', { timeout: 30000, waitUntil: 'networkidle' });

    await page.fill('input[placeholder="N° de Orden"]', String(numeroOrden));
    await page.fill('input[placeholder="Código de Orden"]', String(codigoOrden));

    await page.click('button:has-text("Buscar")');

    await page.waitForTimeout(4000);

    // 1. Buscamos el elemento exacto que contiene el estado principal
    const estadoLocator = page.locator('div.text-4xl.font-bold');
    let textoObtenido = '';

    // Si el elemento existe, extraemos solo su texto (ej. "En tránsito"). 
    // Si no existe, extraemos el body entero (útil para atrapar errores como "Datos incorrectos").
    if (await estadoLocator.count() > 0) {
      textoObtenido = await estadoLocator.first().innerText();
    } else {
      textoObtenido = await page.innerText('body');
    }
    
    // 2. Pasamos todo a mayúsculas para hacer una comparación más segura
    const estadoLimpio = textoObtenido.toUpperCase();

    if (estadoLimpio.includes('ENTREGADO') || estadoLimpio.includes('EN DESTINO')) {
      return 'En destino';
    } else if (estadoLimpio.includes('EN TRÁNSITO') || estadoLimpio.includes('TRÁNSITO')) {
      return 'En tránsito';
    } else if (estadoLimpio.includes('NO SE ENCONTRARON') || estadoLimpio.includes('INCORRECTO')) {
      return 'Datos incorrectos';
    }

    return 'Pendiente';
  } catch (error) {
    console.error(`Error al rastrear orden ${numeroOrden}:`, error.message);
    return null;
  } finally {
    await browser.close();
  }
}

module.exports = { rastrearPedidoShalom };