// Config/data file editing, against a temporary copy of the parent site.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const d = require('../dist/test/dataFiles.cjs');

const site = path.resolve(__dirname, '../..');
let root;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SITE = 'src/data/site.ts';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-data-'));
  fs.cpSync(path.join(site, 'src'), path.join(root, 'src'), { recursive: true });
});

test('finds config files and skips content/pages', () => {
  const files = d.findDataFiles(root).map((f) => f.file);
  assert.deepStrictEqual(files, ['src/data/site.ts', 'src/i18n/index.ts']);
});

test('edits only the changed literals, keeping comments and quotes', () => {
  const before = read(SITE);
  d.saveDataFile(root, SITE, [
    { path: ['site', 'email'], value: "praxis@o'example.de" },
    { path: ['hours', 0, 'slots', 1, 'to'], value: '17:30' },
    { path: ['hours', 2, 'slots', 0, 'who'], value: 'Dr. Horst' },
    { path: ['team', 0, 'role', 'en'], value: 'Line one\nline two' },
  ]);
  const after = read(SITE);
  assert.match(after, /email: 'praxis@o\\'example\.de',/);
  assert.match(after, /\{ from: '13:00', to: '17:30', who: null \}/);
  assert.match(after, /\{ day: 3, slots: \[\{ from: '07:30', to: '12:00', who: 'Dr\. Horst' \}\] \}/);
  assert.match(after, /en: `Line one\nline two`,/);
  assert.match(after, /\/\/ KIM-Adresse für elektronische Arztbriefe/);
  // nothing else changed
  const kept = new Set(after.split('\n'));
  const removed = before.split('\n').filter((l) => !kept.has(l));
  assert.ok(removed.length >= 3 && removed.length <= 5, removed.join('\n')); // only the edited lines
  const f = d.readDataFile(root, SITE);
  assert.strictEqual(f.data.find((x) => x.name === 'site').node.entries.find((e) => e.key === 'email').node.value, "praxis@o'example.de");
});

test('list operations: duplicate, move, remove, add', () => {
  const names = () => d.readDataFile(root, SITE).data.find((x) => x.name === 'team').node.items.map((i) => i.entries[0].node.value);
  const start = names();
  const n = start.length;
  d.saveDataFile(root, SITE, [], { op: 'duplicate', path: ['team', n - 1] });
  assert.deepStrictEqual(names(), [...start, start[n - 1]]);
  d.saveDataFile(root, SITE, [{ path: ['team', n, 'name'], value: 'Neu' }], { op: 'up', path: ['team', n] });
  assert.deepStrictEqual(names(), [...start.slice(0, n - 1), 'Neu', start[n - 1]]);
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['team', n - 1] });
  assert.deepStrictEqual(names(), start);
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['team', 0] });
  assert.deepStrictEqual(names(), start.slice(1));
  d.saveDataFile(root, SITE, [], { op: 'add', path: ['navKeys'] });
  assert.match(read(SITE), /navKeys: RouteKey\[\] = \['practice', 'team', 'services', 'hours', 'news', 'contact', ''\];/);
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['navKeys', 6] });
  // inline single-element list → remove leaves []
  d.saveDataFile(root, SITE, [], { op: 'remove', path: ['hours', 2, 'slots', 0] });
  assert.match(read(SITE), /\{ day: 3, slots: \[\] \}/);
  assert.throws(() => d.saveDataFile(root, SITE, [], { op: 'add', path: ['team', 0, 'cv'] }), /non-empty list/);
});

test('refuses to overwrite code and never writes broken files', () => {
  assert.throws(() => d.saveDataFile(root, SITE, [{ path: ['team', 0, 'photo'], value: 'x' }]), /not found|is code/);
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
