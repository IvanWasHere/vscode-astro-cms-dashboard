// Config/data file editing, against a temporary copy of the example site.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const d = require('../dist/test/dataFiles.cjs');

const site = path.resolve(__dirname, '../example');
let root;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SITE = 'src/data/site.ts';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-data-'));
  fs.cpSync(path.join(site, 'src'), path.join(root, 'src'), { recursive: true });
});

test('finds config files and skips content/pages', () => {
  const files = d.findDataFiles(root).map((f) => f.file);
  assert.deepStrictEqual(files, ['src/data/emergency.yaml', 'src/data/faq.json', 'src/data/site.ts', 'src/i18n/translations.ts']);
});

test('edits only the changed literals, keeping comments and quotes', () => {
  const before = read(SITE);
  d.saveDataFile(root, SITE, [
    { path: ['practice', 'email'], value: "office@o'example.com" },
    { path: ['hours', 0, 'slots', 1, 'to'], value: '17:30' },
    { path: ['hours', 5, 'slots', 0, 'to'], value: '13:00' },
    { path: ['hero', 'headline', 'es'], value: 'Line one\nline two' },
  ]);
  const after = read(SITE);
  assert.match(after, /email: 'office@o\\'example\.com',/);
  assert.match(after, /\{ day: 1, slots: \[\{ from: '08:00', to: '12:00' \}, \{ from: '13:00', to: '17:30' \}\] \}/);
  assert.match(after, /\{ day: 6, slots: \[\{ from: '09:00', to: '13:00' \}\] \}/);
  assert.match(after, /es: `Line one\nline two`,/);
  assert.match(after, /\/\/ Online booking link\. Leave empty to hide/);
  // nothing else changed
  const kept = new Set(after.split('\n'));
  const removed = before.split('\n').filter((l) => !kept.has(l));
  assert.ok(removed.length >= 3 && removed.length <= 5, removed.join('\n')); // only the edited lines
  const f = d.readDataFile(root, SITE);
  assert.strictEqual(f.data.find((x) => x.name === 'practice').node.entries.find((e) => e.key === 'email').node.value, "office@o'example.com");
});

test('list operations: duplicate, move, remove, add', () => {
  const froms = () => d.readDataFile(root, SITE).data.find((x) => x.name === 'closures').node.items.map((i) => i.entries[0].node.value);
  const start = froms();
  assert.deepStrictEqual(start, ['2026-11-26', '2026-12-24']);
  d.saveDataFile(root, SITE, [], { op: 'duplicate', path: ['closures', 1] });
  d.saveDataFile(root, SITE, [{ path: ['closures', 2, 'from'], value: 'New' }], { op: 'up', path: ['closures', 2] });
  assert.deepStrictEqual(froms(), ['2026-11-26', 'New', '2026-12-24']);
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['closures', 1] });
  assert.deepStrictEqual(froms(), start);
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['closures', 0] });
  assert.deepStrictEqual(froms(), ['2026-12-24']);
  d.saveDataFile(root, 'src/i18n/translations.ts', [], { op: 'add', path: ['days', 'en'] });
  assert.match(read('src/i18n/translations.ts'), /'Saturday', 'Sunday', ''\]/);
  d.saveDataFile(root, 'src/i18n/translations.ts', [], { op: 'remove', path: ['days', 'en', 8] });
  // inline single-element list → remove leaves []
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['hours', 5, 'slots', 0] });
  assert.match(read(SITE), /\{ day: 6, slots: \[\] \}/);
  assert.throws(() => d.saveDataFile(root, SITE, [], { op: 'add', path: ['hours', 5, 'slots'] }), /non-empty list/);
});

test('refuses to overwrite code and never writes broken files', () => {
  assert.throws(() => d.saveDataFile(root, SITE, [{ path: ['hero', 'image'], value: 'x' }]), /not found|is code/);
  assert.throws(() => d.saveDataFile(root, SITE, [{ path: ['nope'], value: 'x' }]), /not found/);
});

test('JSON and YAML data files', () => {
  fs.writeFileSync(path.join(root, 'src/data/links.json'), JSON.stringify({ title: 'Links', items: [{ label: 'A', url: 'a' }] }, null, 2));
  fs.writeFileSync(path.join(root, 'src/data/menu.yaml'), '# main menu\ntitle: Menu\nitems:\n  - home\n  - about\n');
  assert.ok(d.findDataFiles(root).some((f) => f.file === 'src/data/links.json'));
  d.saveDataFile(root, 'src/data/links.json', [{ path: ['default', 'title'], value: 'My links' }], { op: 'duplicate', path: ['default', 'items', 0] });
  assert.deepStrictEqual(JSON.parse(read('src/data/links.json')), { title: 'My links', items: [{ label: 'A', url: 'a' }, { label: 'A', url: 'a' }] });
  d.saveDataFile(root, 'src/data/menu.yaml', [{ path: ['default', 'title'], value: 'Main menu' }]);
  assert.strictEqual(read('src/data/menu.yaml'), '# main menu\ntitle: Main menu\nitems:\n  - home\n  - about\n');
});
