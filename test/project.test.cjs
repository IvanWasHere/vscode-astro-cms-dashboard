// Runs the core logic against a temporary copy of the example Astro site in ../example.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AstroProject, writeFrontmatter } = require('../dist/test/project.cjs');

const site = path.resolve(__dirname, '../example');
let root, p;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'astro-dash-'));
  // .astro/collections only exists after `astro sync`; the tests work with or without it
  for (const f of ['astro.config.mjs', 'package.json', 'src', '.astro/collections', 'public']) {
    if (fs.existsSync(path.join(site, f))) fs.cpSync(path.join(site, f), path.join(root, f), { recursive: true });
  }
  p = new AstroProject(root);
});

test('reads site info and collections', () => {
  const info = p.siteInfo();
  assert.deepStrictEqual(info.locales, ['en', 'es']);
  assert.strictEqual(info.defaultLocale, 'en');
  assert.strictEqual(info.base, '');
  assert.deepStrictEqual(p.collections().map((c) => c.name), ['news', 'services', 'team']);
  const news = p.collection('news');
  assert.ok(news.localized);
  assert.deepStrictEqual(news.fields.map((f) => f.name), ['title', 'date', 'summary', 'cover', 'tags', 'important', 'draft']);
  assert.strictEqual(news.fields.find((f) => f.name === 'cover').type, 'image');
  const services = p.collection('services');
  assert.deepStrictEqual(services.fields.find((f) => f.name === 'icon').options, ['stethoscope', 'heart', 'syringe', 'lab', 'video', 'leaf']);
  const team = p.collection('team');
  assert.strictEqual(team.kind, 'data');
  assert.ok(!team.localized);
  assert.strictEqual(team.fields.find((f) => f.name === 'photo').type, 'image');
});

test('lists entries with locale and draft state', () => {
  const news = p.entries('news');
  assert.strictEqual(news.length, 6);
  assert.ok(news.find((e) => e.id === 'en/2026-11-new-provider').draft);
  // English-only post: no Spanish translation yet
  assert.ok(news.some((e) => e.id === 'en/2026-11-holiday-hours'));
  assert.ok(!news.some((e) => e.id === 'es/2026-11-holiday-hours'));
  assert.deepStrictEqual(
    p.entries('team').map((e) => e.title).sort(),
    ['Daniel Reyes, MD', 'Maria Lopez', 'Priya Shah, FNP-C', 'Sarah Mitchell, MD'],
  );
});

test('save keeps YAML formatting and drops default booleans', () => {
  const id = 'en/2026-10-flu-shots';
  const before = p.entry('news', id);
  p.saveEntry('news', { id, slug: before.slug, locale: 'en', data: { ...before.data, important: false }, body: before.body });
  const src = fs.readFileSync(path.join(root, before.file), 'utf8');
  assert.match(src, /^---\ntitle: Flu shots are now available\ndate: 2026-10-20\n/);
  assert.doesNotMatch(src, /important/);
  p.saveEntry('news', { id, slug: before.slug, locale: 'en', data: { ...before.data, important: true }, body: before.body });
  assert.match(fs.readFileSync(path.join(root, before.file), 'utf8'), /important: true/);
});

test('create, rename slug, translate and delete', () => {
  const r = p.saveEntry('news', { slug: 'Extended Hours', locale: 'en', data: { title: 'New', date: '2026-11-04', summary: 'S' }, body: 'Hallo **Welt**' });
  assert.strictEqual(r.id, 'en/extended-hours');
  const r2 = p.saveEntry('news', { id: r.id, slug: 'evening-hours', locale: 'en', data: { title: 'New', date: '2026-11-04', summary: 'S' }, body: 'x' });
  assert.ok(!fs.existsSync(path.join(root, 'src/content/news/en/extended-hours.md')));
  const t = p.duplicateEntry('news', r2.id, 'es');
  assert.strictEqual(t.id, 'es/evening-hours');
  const d = p.duplicateEntry('news', r2.id);
  assert.strictEqual(d.id, 'en/evening-hours-2');
  assert.throws(() => p.saveEntry('news', { slug: 'evening-hours', locale: 'en', data: { title: 'x' }, body: '' }), /already exists/);
  p.deleteEntry('news', d.id);
  assert.ok(!p.entries('news').some((e) => e.id === d.id));
});

test('saves data collection entries as YAML', () => {
  const r = p.saveEntry('team', {
    slug: 'Ana Torres',
    locale: null,
    data: { name: 'Ana Torres', role: 'front-office', position: { en: 'Front office coordinator', es: 'Coordinadora de recepción' }, order: '5' },
    body: '',
  });
  assert.strictEqual(r.file, 'src/content/team/ana-torres.yaml');
  const src = fs.readFileSync(path.join(root, r.file), 'utf8');
  assert.match(src, /^name: Ana Torres\nrole: front-office\nposition:\n  en: Front office coordinator\n  es: Coordinadora de recepción\norder: 5\n/);
  assert.doesNotMatch(src, /^---/);
  p.deleteEntry('team', r.id);
});

test('adds a new collection to content.config.ts', () => {
  p.addCollection({
    name: 'downloads',
    kind: 'content',
    locales: ['en', 'es'],
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'kind', type: 'enum', required: true, options: ['Form', 'Handout'] },
      { name: 'preview', type: 'image', required: false },
      { name: 'order', type: 'number', required: false },
      { name: 'public', type: 'boolean', required: false },
    ],
  });
  const cfg = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.match(cfg, /export const collections = \{ news, services, team, downloads \}/);
  assert.match(cfg, /preview: image\(\)\.optional\(\)/);
  assert.ok(fs.existsSync(path.join(root, 'src/content/downloads/es/.gitkeep')));
  const c = p.collection('downloads');
  assert.strictEqual(c.schemaSource, 'config');
  assert.deepStrictEqual(c.fields.find((f) => f.name === 'kind').options, ['Form', 'Handout']);
  assert.strictEqual(c.fields.find((f) => f.name === 'preview').type, 'image');
  assert.throws(() => p.addCollection({ name: 'downloads', kind: 'content', fields: [] }), /already exists/);
  const e = p.saveEntry('downloads', { slug: 'registration', locale: 'en', data: { title: 'New patient form', kind: 'Form', order: '2', public: true }, body: '' });
  assert.match(fs.readFileSync(path.join(root, e.file), 'utf8'), /order: 2\n/);
});

test('media upload, reference, rename, delete', () => {
  const f = p.uploadMedia('src/assets', 'My Photo (1).png', new Uint8Array([1, 2, 3]));
  assert.strictEqual(f, 'src/assets/My-Photo-1-.png');
  assert.strictEqual(p.uploadMedia('src/assets', 'My Photo (1).png', new Uint8Array([1])), 'src/assets/My-Photo-1--2.png');
  assert.strictEqual(p.mediaReference(f, 'src/content/news/en/x.md', ''), '../../../assets/My-Photo-1-.png');
  assert.strictEqual(p.mediaReference('public/favicon.svg', null, ''), '/favicon.svg');
  const r = p.renameMedia(f, 'photo.png');
  assert.strictEqual(r, 'src/assets/photo.png');
  p.deleteMedia(r);
  assert.ok(!p.media(['src/assets']).some((m) => m.file === r));
  assert.throws(() => p.deleteMedia('../outside.txt'), /outside the project/);
});

test('finds which media is used and which is not', () => {
  const media = p.media(['src/assets', 'public']);
  const used = (f) => media.find((m) => m.file === f).usedIn.length > 0;
  assert.ok(used('src/assets/hero.svg'));
  assert.ok(used('src/assets/team/sarah-mitchell.svg'));
  assert.ok(used('public/downloads/new-patient-form.pdf'));
  assert.ok(!used('src/assets/open-house-2019.svg'));
});

test('entry routes follow imports to getCollection', () => {
  assert.strictEqual(p.entryRoute('news', { slug: 'x', locale: 'en' }), '/news/x/');
  assert.strictEqual(p.entryRoute('news', { slug: 'x', locale: 'es' }), '/es/noticias/x/');
  // services and team have no detail pages
  assert.strictEqual(p.entryRoute('services', { slug: 'x', locale: 'en' }), null);
  assert.strictEqual(p.entryRoute('team', { slug: 'x', locale: null }), null);
});

test('lists pages, dynamic routes and endpoints', () => {
  const pages = p.pages();
  const byRoute = (r) => pages.find((x) => x.route === r);
  assert.strictEqual(byRoute('/services/').title, 'Services');
  assert.strictEqual(byRoute('/es/horario/').locale, 'es');
  assert.strictEqual(byRoute('/news/[id]/').kind, 'dynamic');
  assert.strictEqual(byRoute('/api/hours.json').kind, 'endpoint');
});

test('writeFrontmatter creates frontmatter for new files', () => {
  assert.strictEqual(writeFrontmatter(null, { title: 'Hi', tags: ['a', 'b'] }, 'Body'), '---\ntitle: Hi\ntags:\n  - a\n  - b\n---\n\nBody\n');
});

test('enableDrafts adds a draft field once, and drafts round-trip', () => {
  // services has no draft field
  fs.rmSync(path.join(root, '.astro/collections/services.schema.json'), { force: true });
  const r = p.enableDrafts('services');
  assert.ok(r.changed);
  const cfg = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.match(cfg, /order: z\.number\(\)\.default\(0\),\n    draft: z\.boolean\(\)\.default\(false\),\n  \}\),/);
  assert.strictEqual(p.enableDrafts('services').changed, false);
  assert.ok(p.collection('services').fields.some((f) => f.name === 'draft' && f.type === 'boolean'));

  const id = 'en/vaccinations';
  const e = p.entry('services', id);
  p.saveEntry('services', { id, slug: e.slug, locale: 'en', data: { ...e.data, draft: true }, body: e.body });
  assert.strictEqual(p.entry('services', id).draft, true);
  // publishing again removes the key (false is the default)
  p.saveEntry('services', { id, slug: e.slug, locale: 'en', data: { ...e.data, draft: false }, body: e.body });
  assert.doesNotMatch(fs.readFileSync(path.join(root, e.file), 'utf8'), /draft/);
});

test('renaming the file name moves the entry', () => {
  const id = 'es/2026-07-new-patient-portal';
  const e = p.entry('news', id);
  const r = p.saveEntry('news', { id, slug: 'portal-del-paciente', locale: 'es', data: e.data, body: e.body });
  assert.strictEqual(r.file, 'src/content/news/es/portal-del-paciente.md');
  assert.ok(!fs.existsSync(path.join(root, e.file)));
});

test('link targets list pages and entries with their URLs', () => {
  const t = p.linkTargets();
  const team = t.find((x) => x.route === '/es/equipo/');
  assert.ok(team && team.group === 'Pages' && team.locale === 'es' && team.title === 'Equipo');
  assert.ok(t.some((x) => x.group === 'news' && x.route === '/news/2026-10-flu-shots/' && x.locale === 'en'));
  assert.ok(!t.some((x) => x.group === 'services'));
  assert.ok(!t.some((x) => /\[|404/.test(x.route)));
});
