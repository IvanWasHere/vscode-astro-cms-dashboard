// Regenerates the README screenshots in images/ from the example site.
//
//   (cd example && npm run dev)     # optional: shows "Dev server running" in the shots
//   npm run screenshots              # or: npm run screenshots -- media entry
//
// Starts server.cjs (the real dashboard webview, served to a browser) and headless Chrome, then
// opens each view at 1360×820 @2x and saves a PNG. Uses the Chrome DevTools protocol directly,
// so there is nothing extra to install. Set CHROME=/path/to/chrome if Chrome isn't found.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '../..');
const PORT = 4400;
const DEBUG_PORT = 9333;
const SIZE = { width: 1360, height: 820, deviceScaleFactor: 2 };
const CHROME =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

const click = (sel) => `document.querySelector(${JSON.stringify(sel)}).click()`;
const type = (sel, text) =>
  `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`;

// name → dashboard state (view + params), plus optional steps run after the view has loaded
const SHOTS = {
  overview: { state: { view: 'overview' } },
  collection: { state: { view: 'collection', params: { collection: 'news' } } },
  entry: { state: { view: 'entry', params: { collection: 'news', id: 'en/2026-10-flu-shots' } } },
  'data-entry': { state: { view: 'entry', params: { collection: 'team', id: 'daniel-reyes' } } },
  'link-picker': {
    state: { view: 'entry', params: { collection: 'news', id: 'en/2026-11-holiday-hours' } },
    steps: [click('[data-md="link"]')],
  },
  'new-collection': {
    state: { view: 'new-collection' },
    steps: [type('input[name="name"]', 'downloads'), type('#fields tr:nth-child(3) .fname', 'summary')],
  },
  media: { state: { view: 'media' }, steps: [click('.tile[data-file="src/assets/team/daniel-reyes.svg"]')] },
  pages: { state: { view: 'pages' } },
  config: { state: { view: 'data', params: { file: 'src/data/site.ts' } } },
  translations: { state: { view: 'data', params: { file: 'src/i18n/translations.ts' } } },
  settings: { state: { view: 'settings' } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready yet */
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const opened = new Promise((r) => (ws.onopen = r));
  return { send, opened, close: () => ws.close() };
}

async function main() {
  if (!CHROME) throw new Error('Chrome not found. Set CHROME=/path/to/chrome.');
  const only = process.argv.slice(2);
  const names = only.length ? only : Object.keys(SHOTS);
  for (const n of names) if (!SHOTS[n]) throw new Error(`Unknown screenshot "${n}". Known: ${Object.keys(SHOTS).join(', ')}`);

  const server = spawn(process.execPath, [path.join(__dirname, 'server.cjs'), path.join(repo, 'example'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-dash-shots-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--force-color-profile=srgb', '--lang=en-US', 'about:blank'], { stdio: 'ignore' });

  try {
    await waitFor(() => fetch(`http://localhost:${PORT}/bridge.js`).then((r) => r.ok), 'the dashboard server');
    const targets = await waitFor(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json()), 'Chrome');
    const page = cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await page.opened;
    await page.send('Emulation.setDeviceMetricsOverride', { ...SIZE, mobile: false });
    await page.send('Emulation.setLocaleOverride', { locale: 'en-US' }); // date inputs and formats
    const evaluate = async (expression) => (await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

    for (const name of names) {
      const shot = SHOTS[name];
      await page.send('Page.navigate', { url: `http://localhost:${PORT}/?state=${encodeURIComponent(JSON.stringify(shot.state))}` });
      await waitFor(() => evaluate(`!!document.querySelector('.layout .main') && !document.querySelector('.main .loading') && document.querySelector('.main').children.length > 0`), `the ${name} view`).catch(async (e) => {
        throw new Error(`${e.message}. Page shows: ${(await evaluate('document.body.innerText')).slice(0, 300)}`);
      });
      await sleep(400);
      for (const step of shot.steps ?? []) {
        await evaluate(step);
        await sleep(400);
      }
      await waitFor(() => evaluate(`[...document.images].every((i) => i.complete)`), 'images');
      await sleep(300);
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(repo, 'images', `${name}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`✓ images/${name}.png`);
    }
    page.close();
  } finally {
    server.kill();
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
