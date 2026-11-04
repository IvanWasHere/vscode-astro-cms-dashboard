// Runs the core logic against a temporary copy of the parent Astro site.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AstroProject, writeFrontmatter } = require('../dist/test/project.cjs');

const site = path.resolve(__dirname, '../..');
let root, p;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-dash-'));
  for (const f of ['astro.config.mjs', 'package.json', 'src', '.astro/collections', 'public']) {
    fs.cpSync(path.join(site, f), path.join(root, f), { recursive: true });
  }
  p = new AstroProject(root);
});

test('reads site info and collections', () => {
  const info = p.siteInfo();
  assert.deepStrictEqual(info.locales, ['de', 'en']);
  assert.strictEqual(info.base, '/astroDoctor');
  const [c] = p.collections();
  assert.strictEqual(c.name, 'aktuelles');
  assert.ok(c.localized);
  assert.deepStrictEqual(c.fields.map((f) => f.name), ['title', 'date', 'summary', 'important', 'draft']);
});

test('save keeps YAML formatting and drops default booleans', () => {
  const id = 'de/2026-10-grippeimpfung';
  const before = p.entry('aktuelles', id);
  p.saveEntry('aktuelles', { id, slug: before.slug, locale: 'de', data: { ...before.data, important: false }, body: before.body });
  const src = fs.readFileSync(path.join(root, before.file), 'utf8');
  assert.match(src, /^---\ntitle: Grippeimpfstoff ist da\ndate: 2026-10-26\n/);
  assert.doesNotMatch(src, /important/);
  p.saveEntry('aktuelles', { id, slug: before.slug, locale: 'de', data: { ...before.data, important: true }, body: before.body });
  assert.match(fs.readFileSync(path.join(root, before.file), 'utf8'), /important: true/);
});

test('create, rename slug, translate and delete', () => {
  const r = p.saveEntry('aktuelles', { slug: 'Neue Öffnungszeiten', locale: 'de', data: { title: 'Neu', date: '2026-11-04', summary: 'S' }, body: 'Hallo **Welt**' });
  assert.strictEqual(r.id, 'de/neue-oeffnungszeiten');
  const r2 = p.saveEntry('aktuelles', { id: r.id, slug: 'neue-zeiten', locale: 'de', data: { title: 'Neu', date: '2026-11-04', summary: 'S' }, body: 'x' });
  assert.ok(!fs.existsSync(path.join(root, 'src/content/aktuelles/de/neue-oeffnungszeiten.md')));
  const t = p.duplicateEntry('aktuelles', r2.id, 'en');
  assert.strictEqual(t.id, 'en/neue-zeiten');
  const d = p.duplicateEntry('aktuelles', r2.id);
  assert.strictEqual(d.id, 'de/neue-zeiten-2');
  assert.throws(() => p.saveEntry('aktuelles', { slug: 'neue-zeiten', locale: 'de', data: { title: 'x' }, body: '' }), /already exists/);
  p.deleteEntry('aktuelles', d.id);
  assert.ok(!p.entries('aktuelles').some((e) => e.id === d.id));
});

test('adds a new collection to content.config.ts', () => {
  p.addCollection({
    name: 'team',
    kind: 'content',
    locales: ['de', 'en'],
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'role', type: 'enum', required: true, options: ['Ärztin', 'MFA'] },
      { name: 'photo', type: 'image', required: false },
      { name: 'order', type: 'number', required: false },
      { name: 'active', type: 'boolean', required: false },
    ],
  });
  const cfg = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.match(cfg, /export const collections = \{ aktuelles, team \}/);
  assert.match(cfg, /photo: image\(\)\.optional\(\)/);
  assert.ok(fs.existsSync(path.join(root, 'src/content/team/en/.gitkeep')));
  const team = p.collection('team');
  assert.strictEqual(team.schemaSource, 'config');
  assert.deepStrictEqual(team.fields.find((f) => f.name === 'role').options, ['Ärztin', 'MFA']);
  assert.strictEqual(team.fields.find((f) => f.name === 'photo').type, 'image');
  assert.throws(() => p.addCollection({ name: 'team', kind: 'content', fields: [] }), /already exists/);
  const e = p.saveEntry('team', { slug: 'dr-horst', locale: 'de', data: { name: 'Dr. Horst', role: 'Ärztin', order: '2', active: true }, body: '' });
  assert.match(fs.readFileSync(path.join(root, e.file), 'utf8'), /order: 2\n/);
});

test('media upload, reference, rename, delete', () => {
  const f = p.uploadMedia('src/assets', 'My Photo (1).png', new Uint8Array([1, 2, 3]));
  assert.strictEqual(f, 'src/assets/My-Photo-1-.png');
  assert.strictEqual(p.uploadMedia('src/assets', 'My Photo (1).png', new Uint8Array([1])), 'src/assets/My-Photo-1--2.png');
  assert.strictEqual(p.mediaReference(f, 'src/content/aktuelles/de/x.md', '/astroDoctor'), '../../../assets/My-Photo-1-.png');
  assert.strictEqual(p.mediaReference('public/favicon.svg', null, '/astroDoctor'), '/astroDoctor/favicon.svg');
  const r = p.renameMedia(f, 'photo.png');
  assert.strictEqual(r, 'src/assets/photo.png');
  p.deleteMedia(r);
  assert.ok(!p.media(['src/assets']).some((m) => m.file === r));
  assert.throws(() => p.deleteMedia('../outside.txt'), /outside the project/);
});

test('entry routes follow imports to getCollection', () => {
  assert.strictEqual(p.entryRoute('aktuelles', { slug: 'x', locale: 'de' }), '/astroDoctor/aktuelles/x/');
  assert.strictEqual(p.entryRoute('aktuelles', { slug: 'x', locale: 'en' }), '/astroDoctor/en/news/x/');
});

test('writeFrontmatter creates frontmatter for new files', () => {
  assert.strictEqual(writeFrontmatter(null, { title: 'Hi', tags: ['a', 'b'] }, 'Body'), '---\ntitle: Hi\ntags:\n  - a\n  - b\n---\n\nBody\n');
});

test('enableDrafts adds a draft field once, and drafts round-trip', () => {
  // start from a schema without drafts
  const cfgFile = path.join(root, 'src/content.config.ts');
  fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, 'utf8').replace(/\n\s*draft: z\.boolean\(\)\.default\(false\),/, ''));
  fs.rmSync(path.join(root, '.astro/collections/aktuelles.schema.json'), { force: true });
  const r = p.enableDrafts('aktuelles');
  assert.ok(r.changed);
  const cfg = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.match(cfg, /important: z\.boolean\(\)\.default\(false\),\n    draft: z\.boolean\(\)\.default\(false\),\n  \}\),/);
  assert.strictEqual(p.enableDrafts('aktuelles').changed, false);
  assert.ok(p.collection('aktuelles').fields.some((f) => f.name === 'draft' && f.type === 'boolean'));

  const id = 'de/2025-01-terminsprechstunde';
  const e = p.entry('aktuelles', id);
  p.saveEntry('aktuelles', { id, slug: e.slug, locale: 'de', data: { ...e.data, draft: true }, body: e.body });
  assert.strictEqual(p.entry('aktuelles', id).draft, true);
  // publishing again removes the key (false is the default)
  p.saveEntry('aktuelles', { id, slug: e.slug, locale: 'de', data: { ...e.data, draft: false }, body: e.body });
  assert.doesNotMatch(fs.readFileSync(path.join(root, e.file), 'utf8'), /draft/);
});

test('renaming the file name moves the entry', () => {
  const id = 'en/2025-01-terminsprechstunde';
  const e = p.entry('aktuelles', id);
  const r = p.saveEntry('aktuelles', { id, slug: 'appointments', locale: 'en', data: e.data, body: e.body });
  assert.strictEqual(r.file, 'src/content/aktuelles/en/appointments.md');
  assert.ok(!fs.existsSync(path.join(root, e.file)));
});

test('link targets list pages and entries with their URLs', () => {
  const t = p.linkTargets();
  const team = t.find((x) => x.route === '/astroDoctor/en/team/');
  assert.ok(team && team.group === 'Pages' && team.locale === 'en' && team.title === 'Team');
  assert.ok(t.some((x) => x.group === 'aktuelles' && x.route === '/astroDoctor/aktuelles/2026-10-grippeimpfung/' && x.locale === 'de'));
  assert.ok(!t.some((x) => /\[|404/.test(x.route)));
});
