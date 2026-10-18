import { chromium } from 'playwright';
const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const out = process.argv[2];
const shots = [
  ['signin', null, 700], ['webhooks', async (p) => { await p.click('[data-action=use-servers]'); await p.waitForTimeout(400); await p.click('[data-action=toggle-remove]'); }, 1200], ['choose', null, 1400],
  ['choose-some', async (p) => p.click('[data-action=users-some]'), 1500],
  ['template', async (p) => p.click('text=Next'), 1000],
  ['main', null, 1000], ['review', async (p) => p.click('[data-action=open-webhooks]'), 2400],
  ['edit', async (p) => p.click('[data-action=edit][data-id=s-1]'), 1700],
  ['remove', async (p) => { await p.click('[data-action=edit][data-id=s-4]'); await p.click('[data-action=delete]'); }, 1500],
  ['advanced', async (p) => { await p.click('[data-action=tab][data-id=advanced]'); await p.click('[data-action=load-report]'); }, 1900],
  ['ended', null, 1300],
  ['nopass-adv', async (p) => p.click('[data-action=tab][data-id=advanced]'), 2000],
  ['reset', async (p) => { await p.click('[data-action=tab][data-id=advanced]'); await p.click('[data-action=toggle-open][data-id=reset]'); await p.click('[data-action=reset-plugin]'); }, 2100],
  ['settings-open', async (p) => { await p.click('[data-action=tab][data-id=advanced]'); await p.click('[data-action=toggle-open][data-id=advanced]'); }, 2200],
  ['commands', async (p) => { await p.click('[data-action=tab][data-id=advanced]'); await p.click('[data-action=toggle-open][data-id=advanced]'); await p.click('[data-action=test-command][data-id=c-1]'); }, 2600],
  ['edit-cmd', async (p) => p.click('[data-action=edit][data-id=s-1]'), 1800],
  ['recipes', async (p) => p.click('[data-action=tab][data-id=recipes]'), 1400],
  ['preset-choice', async (p) => { await p.click('[data-action=toggle-presets]'); await p.click('[data-action=pick-preset][data-id=credits]'); }, 1400],
  ['preset-list', async (p) => p.click('[data-action=toggle-presets]'), 1400],
  ['edit-credits', async (p) => p.click('[data-action=edit][data-id=s-4]'), 1700],
  ['edit-media', async (p) => { await p.click('[data-action=edit][data-id=s-6]'); await p.click('[data-action=now-playing]'); await p.waitForTimeout(200); }, 2400],
  ['restart', null, 900],
];
const query = { restart: '&runtime=stale&port=free' };
const base = (s) => ({ 'preset-choice': 'main', 'preset-list': 'main', 'edit-credits': 'main', 'edit-media': 'main', restart: 'main',  'settings-open': 'advanced', reset: 'advanced', webhooks: 'server', 'choose-some': 'choose', template: 'choose', review: 'main', remove: 'edit' }[s] ?? s);
const errors = [];
const titles = [];
for (const [s, act, h] of shots) {
  for (const dark of [false, true]) {

    const page = await browser.newPage({ viewport: { width: 820, height: h } });
    page.on('pageerror', (e) => errors.push(`${s}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${s}: ${m.text()}`));
    await page.goto(`http://localhost:8765/?s=${base(s)}${query[s] ?? ''}${dark ? '&dark=1' : ''}`);
    await page.waitForTimeout(400);
    if (act) { await act(page); await page.waitForTimeout(300); }
    titles.push(`${s}${dark ? '-dark' : ''}: ${await page.title()}`);
    await page.screenshot({ path: `${out}/${s}${dark ? '-dark' : ''}.png`, fullPage: true });
    await page.close();
  }
}
const phone = await browser.newPage({ viewport: { width: 390, height: 900 } });
await phone.goto('http://localhost:8765/?s=choose'); await phone.waitForTimeout(400);
await phone.screenshot({ path: `${out}/phone-choose.png`, fullPage: true });
console.log(errors.join('\n') || 'no errors'); console.log(titles.join('\n'));
await browser.close();
