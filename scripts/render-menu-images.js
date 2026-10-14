// Renders the menu pages to PNG images (public/menu/<service>-<n>.png) for WhatsApp.
// One-time setup:  npm i -D playwright && npx playwright install chromium
// Then, after every menu change:  npm run menu-images

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Menu } = require('../src/menu');
const { Business } = require('../src/business');
const { menuDocument } = require('../src/menu-page');

(async () => {
  const outDir = path.join(__dirname, '..', 'public', 'menu');
  fs.mkdirSync(outDir, { recursive: true });
  const menu = new Menu();
  const business = new Business();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 1 });
  for (const service of ['takeaway', 'delivery']) {
    await page.setContent(menuDocument(menu, business, service), { waitUntil: 'load' });
    const pages = await page.$$('.page');
    for (let i = 0; i < pages.length; i++) {
      const file = path.join(outDir, `${service}-${i + 1}.png`);
      await pages[i].screenshot({ path: file });
      console.log('wrote', path.relative(process.cwd(), file));
    }
  }
  await browser.close();
})();
