// Astro Dashboard webview UI. Talks to the extension through call(type, payload).
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  // ---------- messaging ----------
  let seq = 0;
  const pending = new Map();
  function call(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      vscode.postMessage({ id, type, payload });
    });
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    } else if (m.type === 'changed') {
      onExternalChange();
    } else if (m.type === 'navigate') {
      openView(m.view);
    }
  });

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const fmtDate = (d) => {
    if (!d) return '—';
    const date = new Date(d);
    return isNaN(date) ? esc(d) : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const ago = (ms) => {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
    return fmtDate(ms);
  };
  const humanize = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const slugify = (s) =>
    String(s)
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  const icon = (name) => `<span class="codicon">${ICONS[name] ?? ''}</span>`;
  const ICONS = {
    dashboard: '▦',
    content: '✎',
    media: '▣',
    pages: '☰',
    add: '+',
    settings: '⚙',
    config: '⛭',
    globe: '◍',
  };

  function toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }
  const fail = (e) => toast(e.message || String(e), 'error');

  /** Small modal (window.confirm is not available in webviews). */
  function dialog(title, bodyHtml, buttons) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2><div class="modal-body">${bodyHtml}</div>
        <div class="modal-actions">${buttons
          .map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-i="${i}">${esc(b.label)}</button>`)
          .join('')}</div></div>`;
      document.body.appendChild(wrap);
      const close = (v) => {
        wrap.remove();
        resolve(v);
      };
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close(null);
        const i = e.target.closest('[data-i]')?.dataset.i;
        if (i !== undefined) close(buttons[i].value ?? buttons[i].label);
      });
      wrap.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
      (wrap.querySelector('input,select,textarea') || wrap.querySelector('.btn.primary'))?.focus();
    });
  }

  // ---------- state ----------
  const saved = vscode.getState() || {};
  let state = { view: saved.view || 'overview', params: saved.params || {} };
  let data = { collections: [], site: null };
  let editor = null; // current entry editor state
  let mediaCache = null;

  function setView(view, params = {}) {
    state = { view, params };
    vscode.setState(state);
    render();
  }

  async function guardDirty() {
    if (!editor?.dirty) return true;
    const r = await dialog('Unsaved changes', '<p>You have unsaved changes. Discard them?</p>', [
      { label: 'Keep editing', value: false },
      { label: 'Discard', value: true, danger: true },
    ]);
    return !!r;
  }

  async function go(view, params) {
    if (!(await guardDirty())) return;
    editor = null;
    setView(view, params);
  }

  function openView(v) {
    if (!v) return;
    if (v.startsWith('new-entry:')) go('entry', { collection: v.slice(10), isNew: true });
    else go(v);
  }

  let changeTimer;
  function onExternalChange() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      mediaCache = null;
      await loadOverview();
      if (state.view === 'entry' || (state.view === 'data' && editor?.dirty)) renderSidebar();
      else render();
    }, 150);
  }

  async function loadOverview() {
    try {
      data = await call('overview');
    } catch (e) {
      fail(e);
    }
  }

  // ---------- layout ----------
  function render() {
    if (!app.querySelector('.layout')) {
      app.innerHTML = `<div class="layout"><nav class="sidebar"></nav><main class="main"></main></div>`;
    }
    renderSidebar();
    const main = $('.main');
    main.scrollTop = 0;
    const views = { overview, collection: collectionView, entry: entryView, media: mediaView, pages: pagesView, 'new-collection': newCollectionView, settings: settingsView, data: dataView };
    (views[state.view] || overview)(main);
  }

  function renderSidebar() {
    const nav = $('.sidebar');
    if (!nav) return;
    const active = (v, c) => (state.view === v && (c === undefined || state.params.collection === c) ? 'active' : '');
    const collectionActive = (c) => (['collection', 'entry'].includes(state.view) && state.params.collection === c ? 'active' : '');
    nav.innerHTML = `
      <div class="brand"><span class="logo">A</span><div><strong>${esc(data.site?.name ?? 'Astro site')}</strong><small>Astro ${esc(data.site?.astroVersion ?? '')}</small></div></div>
      <a class="nav-item ${active('overview')}" data-go="overview">${icon('dashboard')} Dashboard</a>
      <div class="nav-label">Content</div>
      ${data.collections
        .map(
          (c) => `<a class="nav-item ${collectionActive(c.name)}" data-go="collection" data-collection="${esc(c.name)}">${icon('content')} ${esc(humanize(c.name))}<span class="count">${c.entryCount}</span></a>
          ${collectionActive(c.name) ? `<a class="nav-sub ${state.view === 'collection' ? 'active' : ''}" data-go="collection" data-collection="${esc(c.name)}">All entries</a><a class="nav-sub ${state.view === 'entry' && state.params.isNew ? 'active' : ''}" data-go="entry" data-collection="${esc(c.name)}" data-new="1">Add new</a>` : ''}`,
        )
        .join('')}
      <a class="nav-item subtle ${active('new-collection')}" data-go="new-collection">${icon('add')} New collection</a>
      <div class="nav-label">Site</div>
      <a class="nav-item ${active('media')}" data-go="media">${icon('media')} Media<span class="count">${data.mediaCount ?? ''}</span></a>
      <a class="nav-item ${active('pages')}" data-go="pages">${icon('pages')} Pages<span class="count">${data.pageCount ?? ''}</span></a>
      <a class="nav-item ${active('settings')}" data-go="settings">${icon('settings')} Settings</a>
      ${(data.dataFiles ?? []).length ? `<div class="nav-label">Config</div>${data.dataFiles
        .map((f) => `<a class="nav-item ${state.view === 'data' && state.params.file === f.file ? 'active' : ''}" data-go="data" data-file="${esc(f.file)}" title="${esc(f.file)}">${icon('config')} ${esc(f.label)}<span class="count">${esc(f.file.split('/').pop())}</span></a>`)
        .join('')}` : ''}
      <div class="nav-footer">
        <span class="dot ${data.devServer ? 'on' : ''}"></span>${data.devServer ? 'Dev server running' : 'Dev server stopped'}
        ${data.devServer ? `<span class="footer-links"><a data-action="view-site">View site</a> · <a data-action="stop-dev">Stop</a></span>` : `<a data-action="dev">Start</a>`}
      </div>`;
  }

  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-go]');
    if (nav) {
      e.preventDefault();
      const params = {};
      if (nav.dataset.collection) params.collection = nav.dataset.collection;
      if (nav.dataset.id) params.id = nav.dataset.id;
      if (nav.dataset.new) params.isNew = true;
      if (nav.dataset.locale) params.locale = nav.dataset.locale;
      if (nav.dataset.file) params.file = nav.dataset.file;
      return go(nav.dataset.go, params);
    }
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    try {
      if (act === 'open-file') await call('openFile', { file: a.dataset.file, beside: e.altKey, line: a.dataset.line ? Number(a.dataset.line) : undefined });
      else if (act === 'dev') {
        await call('devServer');
        toast('Starting dev server in the terminal…');
        setTimeout(async () => {
          data.devServer = await call('devStatus');
          if (state.view === 'overview') render();
          else renderSidebar();
        }, 4000);
      } else if (act === 'stop-dev') {
        a.classList.add('busy');
        const r = await call('stopDevServer');
        data.devServer = await call('devStatus');
        if (r.stopped) toast('Dev server stopped', 'success');
        else if (r.message) toast(r.message, 'error');
        if (state.view === 'overview') render();
        else renderSidebar();
      } else if (act === 'view-site') await call('preview', { route: `${data.site?.base ?? ''}/` });
      else if (act === 'preview') await call('preview', { route: a.dataset.route, external: e.altKey });
      else if (act === 'copy') await call('copy', { text: a.dataset.text });
      else if (act === 'reveal') await call('reveal', { file: a.dataset.file });
      else if (act === 'settings') await call('settings');
    } catch (err) {
      fail(err);
    }
  });

  // ---------- overview ----------
  function overview(main) {
    const site = data.site || {};
    const total = data.collections.reduce((s, c) => s + c.entryCount, 0);
    main.innerHTML = `
      <header class="page-header"><div><h1>Dashboard</h1><p class="muted">${esc(site.site ?? '')}${esc(site.base ?? '')}</p></div>
        <div class="actions">${data.devServer ? `<button class="btn" data-action="stop-dev">Stop dev server</button><button class="btn" data-action="view-site">View site</button>` : `<button class="btn" data-action="dev">Start dev server</button>`}</div></header>
      <section class="welcome card">
        <h2>Welcome to your site dashboard</h2>
        <p class="muted">Manage content collections, media and pages of <strong>${esc(site.name)}</strong> without leaving VS Code. Everything is saved as normal files in your project.</p>
        <div class="welcome-cols">
          <div><h4>Get started</h4>${
            data.collections[0]
              ? `<button class="btn primary" data-go="entry" data-collection="${esc(data.collections[0].name)}" data-new="1">Write a new ${esc(humanize(data.collections[0].name))} entry</button>`
              : `<button class="btn primary" data-go="new-collection">Create your first collection</button>`
          }</div>
          <div><h4>Next steps</h4><ul class="links"><li><a data-go="media">Upload media</a></li><li><a data-go="new-collection">Add a content type</a></li><li><a data-go="pages">Browse pages</a></li></ul></div>
          <div><h4>More</h4><ul class="links"><li><a data-action="open-file" data-file="${esc(site.configFile ?? '')}">Edit ${esc(site.configFile ?? 'astro config')}</a></li>${site.contentConfigFile ? `<li><a data-action="open-file" data-file="${esc(site.contentConfigFile)}">Edit content schema</a></li>` : ''}${(data.dataFiles ?? []).map((f) => `<li><a data-go="data" data-file="${esc(f.file)}">Edit ${esc(f.label.toLowerCase())} config</a></li>`).join('')}<li><a data-action="settings">Dashboard settings</a></li></ul></div>
        </div>
      </section>
      <div class="grid-2">
        <section class="card"><h3>At a glance</h3>
          <div class="stats">
            <a class="stat" data-go="${data.collections[0] ? 'collection' : 'new-collection'}" ${data.collections[0] ? `data-collection="${esc(data.collections[0].name)}"` : ''}><b>${total}</b><span>Entries</span></a>
            <a class="stat" data-go="new-collection"><b>${data.collections.length}</b><span>Collections</span></a>
            <a class="stat" data-go="media"><b>${data.mediaCount}</b><span>Media files · ${fmtSize(data.mediaSize || 0)}</span></a>
            <a class="stat" data-go="pages"><b>${data.pageCount}</b><span>Pages</span></a>
          </div>
          <ul class="glance">${data.collections
            .map((c) => `<li><a data-go="collection" data-collection="${esc(c.name)}">${c.entryCount} ${esc(humanize(c.name))}</a>${c.localized ? `<span class="badge">${c.locales.map(esc).join(' · ')}</span>` : ''}</li>`)
            .join('')}</ul>
          ${site.locales?.length ? `<p class="muted small">Languages: ${site.locales.map((l) => `<span class="badge">${esc(l)}${l === site.defaultLocale ? ' (default)' : ''}</span>`).join(' ')}</p>` : ''}
        </section>
        <section class="card"><h3>Quick draft</h3>
          ${
            data.collections.length
              ? `<form id="quick-draft" class="form">
              <label>Collection<select name="collection">${data.collections.filter((c) => c.kind === 'content').map((c) => `<option>${esc(c.name)}</option>`).join('')}</select></label>
              ${site.locales?.length ? `<label>Language<select name="locale">${site.locales.map((l) => `<option>${esc(l)}</option>`).join('')}</select></label>` : ''}
              <label>Title<input name="title" required placeholder="What's new?"></label>
              <label>Content<textarea name="body" rows="4" placeholder="Write something…"></textarea></label>
              <button class="btn primary">Continue editing</button></form>`
              : '<p class="muted">Create a collection first.</p>'
          }
        </section>
        <section class="card"><h3>Recently edited</h3>
          ${
            data.recent.length
              ? `<ul class="activity">${data.recent
                  .map(
                    (r) => `<li><span class="muted">${ago(r.mtime)}</span><a data-go="entry" data-collection="${esc(r.collection)}" data-id="${esc(r.id)}">${esc(r.title)}</a><span>${r.draft ? '<span class="badge warn">Draft</span> ' : ''}${r.locale ? `<span class="badge">${esc(r.locale)}</span>` : ''}</span><span class="muted small">${esc(humanize(r.collection))}</span></li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted">Nothing yet.</p>'
          }
        </section>
        <section class="card"><h3>Recent media</h3>
          ${data.recentMedia?.length ? `<div class="thumbs">${data.recentMedia.map((m) => `<a data-go="media" title="${esc(m.file)}"><img src="${esc(m.uri)}" alt=""></a>`).join('')}</div>` : '<p class="muted">No images yet.</p>'}
          <p><a data-go="media">Go to media library →</a></p>
        </section>
      </div>`;

    $('#quick-draft')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      go('entry', { collection: f.get('collection'), isNew: true, locale: f.get('locale') || undefined, draft: { title: f.get('title'), body: f.get('body') } });
    });
  }

  // ---------- collection list ----------
  async function collectionView(main) {
    const c = data.collections.find((x) => x.name === state.params.collection);
    if (!c) return overview(main);
    main.innerHTML = `<header class="page-header"><div><h1>${esc(humanize(c.name))}</h1><p class="muted">${esc(c.baseRel)} · ${esc(c.pattern)}</p></div>
      <div class="actions"><button class="btn primary" data-go="entry" data-collection="${esc(c.name)}" data-new="1">Add new</button></div></header>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search ${esc(humanize(c.name))}…" value="${esc(state.params.q ?? '')}">
        ${c.localized ? `<select id="loc"><option value="">All languages</option>${c.locales.map((l) => `<option ${state.params.filterLocale === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
        ${draftField(c) ? `<select id="st"><option value="">All statuses</option><option value="published">Published</option><option value="draft">Drafts</option></select>` : ''}
        <span class="spacer"></span><span class="muted small">Schema from ${esc(c.schemaSource === 'json-schema' ? 'Astro (generated)' : c.schemaSource === 'config' ? 'content config' : 'existing entries')}</span>
      </div>
      <div id="list"><div class="loading">Loading…</div></div>`;
    let entries;
    try {
      entries = await call('entries', { collection: c.name });
    } catch (e) {
      return fail(e);
    }
    const list = $('#list');
    const draw = () => {
      const q = $('#q').value.toLowerCase();
      const loc = $('#loc')?.value || '';
      const st = $('#st')?.value || '';
      const match = (e) => (!q || e.title.toLowerCase().includes(q) || e.slug.includes(q)) && (!loc || e.locale === loc) && (!st || (st === 'draft') === e.draft);
      if (c.localized) {
        // one row per slug with a column per language (like Polylang/WPML)
        const groups = new Map();
        for (const e of entries) {
          if (!groups.has(e.slug)) groups.set(e.slug, {});
          groups.get(e.slug)[e.locale ?? '_'] = e;
        }
        const rows = [...groups.entries()].filter(([, g]) => Object.values(g).some(match));
        list.innerHTML = rows.length
          ? `<table class="table"><thead><tr><th>Title</th>${c.locales.map((l) => `<th class="lang">${esc(l)}</th>`).join('')}<th>Date</th><th></th></tr></thead><tbody>${rows
              .map(([slug, g]) => {
                const main = g[data.site.defaultLocale] ?? Object.values(g)[0];
                return `<tr><td><a class="row-title" data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(main.id)}">${esc(main.title)}</a>${main.draft ? ' <span class="badge warn">Draft</span>' : ''}
                  <div class="row-actions"><a data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(main.id)}">Edit</a> · <a data-entry-act="dup" data-id="${esc(main.id)}">Duplicate</a> · <a data-action="open-file" data-file="${esc(main.file)}">Open file</a> · <a class="danger" data-entry-act="del" data-id="${esc(main.id)}">Delete</a></div>
                  <div class="muted small">${esc(slug)}</div></td>
                  ${c.locales
                    .map((l) =>
                      g[l]
                        ? g[l].draft
                          ? `<td class="lang"><a class="lang-draft" title="Draft (${esc(l)}): ${esc(g[l].title)}" data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(g[l].id)}">✎</a></td>`
                          : `<td class="lang"><a class="lang-ok" title="Edit ${esc(l)}: ${esc(g[l].title)}" data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(g[l].id)}">✓</a></td>`
                        : `<td class="lang"><a class="lang-add" title="Add ${esc(l)} translation" data-entry-act="translate" data-id="${esc(main.id)}" data-locale="${esc(l)}">+</a></td>`,
                    )
                    .join('')}
                  <td>${fmtDate(main.date)}</td><td class="muted small">${ago(Math.max(...Object.values(g).map((x) => x.mtime)))}</td></tr>`;
              })
              .join('')}</tbody></table>`
          : empty(c);
      } else {
        const rows = entries.filter(match);
        list.innerHTML = rows.length
          ? `<table class="table"><thead><tr><th>Title</th><th>Date</th><th>Modified</th></tr></thead><tbody>${rows
              .map(
                (e) => `<tr><td><a class="row-title" data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(e.id)}">${esc(e.title)}</a>${e.draft ? ' <span class="badge warn">Draft</span>' : ''}
                <div class="row-actions"><a data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(e.id)}">Edit</a> · <a data-entry-act="dup" data-id="${esc(e.id)}">Duplicate</a> · <a data-action="open-file" data-file="${esc(e.file)}">Open file</a> · <a class="danger" data-entry-act="del" data-id="${esc(e.id)}">Delete</a></div>
                <div class="muted small">${esc(e.file)}</div></td><td>${fmtDate(e.date)}</td><td class="muted small">${ago(e.mtime)}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : empty(c);
      }
    };
    const empty = (c) => `<div class="empty card"><p>No entries found.</p><button class="btn primary" data-go="entry" data-collection="${esc(c.name)}" data-new="1">Create the first one</button></div>`;
    draw();
    $('#q').addEventListener('input', (e) => {
      state.params.q = e.target.value;
      vscode.setState(state);
      draw();
    });
    $('#st')?.addEventListener('change', draw);
    $('#loc')?.addEventListener('change', (e) => {
      state.params.filterLocale = e.target.value;
      vscode.setState(state);
      draw();
    });
    list.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-entry-act]');
      if (!a) return;
      try {
        if (a.dataset.entryAct === 'del') {
          const r = await call('deleteEntry', { collection: c.name, id: a.dataset.id });
          if (r.deleted) toast('Entry deleted');
        } else if (a.dataset.entryAct === 'dup') {
          const r = await call('duplicateEntry', { collection: c.name, id: a.dataset.id });
          toast('Duplicated');
          go('entry', { collection: c.name, id: r.id });
        } else if (a.dataset.entryAct === 'translate') {
          const r = await call('duplicateEntry', { collection: c.name, id: a.dataset.id, locale: a.dataset.locale });
          toast(`Created ${a.dataset.locale} version — translate it now`);
          go('entry', { collection: c.name, id: r.id });
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  // ---------- entry editor ----------
  async function entryView(main) {
    const c = data.collections.find((x) => x.name === state.params.collection);
    if (!c) return overview(main);
    const isNew = !!state.params.isNew;
    let entry;
    if (isNew) {
      const d = {};
      for (const f of c.fields) {
        if (f.default !== undefined) d[f.name] = f.default;
        if (f.type === 'date' && /^(date|pubDate|publishDate)$/.test(f.name)) d[f.name] = new Date().toISOString().slice(0, 10);
      }
      if (state.params.draft?.title) d.title = state.params.draft.title;
      entry = { data: d, body: state.params.draft?.body ?? '', slug: '', locale: state.params.locale ?? (c.localized ? data.site.defaultLocale : null), file: null };
    } else {
      main.innerHTML = '<div class="loading">Loading…</div>';
      try {
        entry = await call('entry', { collection: c.name, id: state.params.id });
      } catch (e) {
        fail(e);
        return go('collection', { collection: c.name });
      }
    }
    const statusField = draftField(c);
    const isDraft = statusField ? (statusField.name === 'draft' ? entry.data.draft === true : entry.data.published === false) : false;
    editor = { c, entry, isNew, dirty: false, slugTouched: !isNew, statusField, isDraft };
    const titleField = c.fields.find((f) => f.name === 'title') ?? c.fields.find((f) => f.name === 'name');
    const otherFields = c.fields.filter((f) => f !== titleField && f !== statusField);
    const ext = entry.file ? entry.file.split('.').pop() : c.extensions.includes('md') ? 'md' : c.extensions[0];
    const buttons = !statusField
      ? `<button class="btn primary" type="submit" data-status="keep">${isNew ? 'Publish' : 'Update'}</button>`
      : isNew || isDraft
        ? `<span class="row"><button class="btn" type="submit" data-status="draft">Save draft</button><button class="btn primary" type="submit" data-status="published">Publish</button></span>`
        : `<span class="row"><button class="btn" type="submit" data-status="draft" title="Hide this entry from the live site">Switch to draft</button><button class="btn primary" type="submit" data-status="published">Update</button></span>`;

    main.innerHTML = `
      <header class="page-header"><div><h1>${isNew ? `Add new ${esc(humanize(c.name))}` : `Edit ${esc(humanize(c.name))}`}</h1>
        <p class="muted"><a data-go="collection" data-collection="${esc(c.name)}">← All ${esc(humanize(c.name))}</a></p></div>
        <div class="actions"><span class="dirty-flag" hidden>Unsaved changes</span></div></header>
      <form id="entry-form" class="editor" autocomplete="off">
        <div class="editor-main">
          ${titleField ? `<input class="title-input" name="${esc(titleField.name)}" placeholder="Add title" value="${esc(entry.data[titleField.name] ?? '')}" ${titleField.required ? 'required' : ''}>` : ''}
          <div class="permalink">
            <span class="muted">File name:</span>
            <span class="fn-view"><code class="fn-text"></code><button type="button" class="icon-btn fn-edit" title="Edit file name">✎</button></span>
            <span class="fn-form" hidden><input class="fn-input" placeholder="my-entry" aria-label="File name"><span class="muted">.${esc(ext)}</span><button type="button" class="icon-btn fn-ok" title="OK (Enter)">✓</button><button type="button" class="icon-btn fn-cancel" title="Cancel (Esc)">✕</button></span>
            <input type="hidden" name="__slug" value="${esc(entry.slug)}">
            ${entry.route ? `<a data-action="preview" data-route="${esc(entry.route)}" title="Alt+click: open in browser">View on site ↗</a>` : ''}
          </div>
          ${
            c.kind === 'content'
              ? `<div class="md-editor">
            <div class="md-toolbar">
              <button type="button" data-md="h2" title="Heading">H</button><button type="button" data-md="bold" title="Bold"><b>B</b></button><button type="button" data-md="italic" title="Italic"><i>I</i></button>
              <button type="button" data-md="link" title="Insert link to a page (⌘K)">🔗 Link</button><button type="button" data-md="ul" title="List">•</button><button type="button" data-md="ol" title="Numbered list">1.</button><button type="button" data-md="quote" title="Quote">❝</button>
              <button type="button" data-md="image" title="Insert media">Add media</button>
              <span class="spacer"></span>
              <button type="button" class="tab active" data-tab="write">Write</button><button type="button" class="tab" data-tab="preview">Preview</button>
            </div>
            <textarea name="__body" class="md-body" spellcheck="true" placeholder="Start writing (Markdown)…">${esc(entry.body)}</textarea>
            <div class="md-preview" hidden></div>
          </div>`
              : ''
          }
        </div>
        <aside class="editor-side">
          <div class="card box"><h3>Publish</h3>
            <p class="status-row">Status: ${
              statusField
                ? isNew
                  ? '<strong>New</strong>'
                  : isDraft
                    ? '<span class="badge warn">Draft</span> <span class="muted small">hidden on the live site</span>'
                    : '<span class="badge ok">Published</span>'
                : `<span class="badge ok">Published</span> <a class="small" data-enable-drafts title="Adds a draft field to the schema">Enable drafts</a>`
            }</p>
            ${c.localized ? `<label>Language<select name="__locale">${c.locales.map((l) => `<option ${entry.locale === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
            ${entry.file ? `<p class="muted small file-path"><a data-action="open-file" data-file="${esc(entry.file)}" title="Open in editor (Alt+click: beside)">${esc(entry.file)}</a></p>` : `<p class="muted small">Will be saved to <code class="target-path"></code></p>`}
            <div class="box-actions">
              ${!isNew ? `<a class="danger" data-entry-del>Delete</a>` : '<span></span>'}
              ${buttons}
            </div>
            <p class="muted small">⌘S / Ctrl+S to save</p>
          </div>
          ${!isNew && c.localized ? translationsBox(c, entry) : ''}
          ${otherFields.length ? `<div class="card box"><h3>Fields</h3>${otherFields.map((f) => fieldInput(f, entry)).join('')}</div>` : ''}
        </aside>
      </form>`;

    const form = $('#entry-form');
    const markDirty = () => {
      editor.dirty = true;
      $('.dirty-flag').hidden = false;
      updateTarget();
    };
    const updateTarget = () => {
      $('.fn-text').textContent = `${form.elements.__slug.value || 'untitled'}.${ext}`;
      const t = $('.target-path');
      if (!t) return;
      const loc = form.elements.__locale?.value;
      t.textContent = `${c.baseRel}/${loc ? loc + '/' : ''}${form.elements.__slug.value || '…'}.${ext}`;
    };
    updateTarget();

    // file name: shown as text, editable via the pencil
    const fnView = $('.fn-view'), fnForm = $('.fn-form'), fnInput = $('.fn-input');
    const openFn = () => {
      fnInput.value = form.elements.__slug.value;
      fnView.hidden = true;
      fnForm.hidden = false;
      fnInput.focus();
      fnInput.select();
    };
    const closeFn = (apply) => {
      if (apply) {
        const v = fnInput.value.trim().replace(new RegExp(`\\.${ext}$`), '').split('/').map(slugify).filter(Boolean).join('/');
        if (!v) return toast('File name cannot be empty', 'error');
        if (v !== form.elements.__slug.value) {
          form.elements.__slug.value = v;
          editor.slugTouched = true;
          markDirty();
        }
      }
      fnForm.hidden = true;
      fnView.hidden = false;
    };
    $('.fn-edit').addEventListener('click', openFn);
    $('.fn-ok').addEventListener('click', () => closeFn(true));
    $('.fn-cancel').addEventListener('click', () => closeFn(false));
    fnInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeFn(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFn(false);
      }
    });

    form.addEventListener('input', (e) => {
      if (e.target === fnInput) return;
      if (titleField && e.target.name === titleField.name && !editor.slugTouched) form.elements.__slug.value = slugify(e.target.value);
      markDirty();
    });
    form.addEventListener('change', (e) => e.target !== fnInput && markDirty());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!fnForm.hidden) closeFn(true);
      save(e.submitter?.dataset.status ?? 'keep');
    });
    $('[data-enable-drafts]', form)?.addEventListener('click', async () => {
      if (!(await guardDirty())) return;
      try {
        await call('enableDrafts', { collection: c.name });
        await loadOverview();
        editor = null;
        toast('Drafts enabled for this collection', 'success');
        render();
      } catch (e) {
        fail(e);
      }
    });

    // markdown toolbar
    const ta = form.elements.__body;
    $$('[data-md]', form).forEach((b) =>
      b.addEventListener('click', async () => {
        const kind = b.dataset.md;
        if (kind === 'image') {
          const m = await pickMedia();
          if (!m) return;
          const from = entry.file ?? $('.target-path')?.textContent;
          const ref = await call('mediaReference', { media: m.file, from });
          const alt = m.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
          insertMd(ta, m.kind === 'image' ? `![${alt}](${ref})` : `[${m.name}](${ref})`, '');
        } else if (kind === 'link') {
          if (!(await insertLink(ta))) return;
        } else mdAction(ta, kind);
        markDirty();
      }),
    );
    $$('[data-tab]', form).forEach((b) =>
      b.addEventListener('click', () => {
        $$('[data-tab]', form).forEach((x) => x.classList.toggle('active', x === b));
        const prev = b.dataset.tab === 'preview';
        ta.hidden = prev;
        const pv = $('.md-preview', form);
        pv.hidden = !prev;
        if (prev) pv.innerHTML = renderMarkdown(ta.value);
      }),
    );

    // image fields
    $$('[data-pick-image]', form).forEach((b) =>
      b.addEventListener('click', async () => {
        const m = await pickMedia('image');
        if (!m) return;
        const name = b.dataset.pickImage;
        const from = entry.file ?? $('.target-path')?.textContent;
        form.elements[name].value = await call('mediaReference', { media: m.file, from });
        const img = $(`[data-preview-for="${name}"]`, form);
        img.src = m.uri;
        img.hidden = false;
        markDirty();
      }),
    );
    $$('[data-clear-image]', form).forEach((b) =>
      b.addEventListener('click', () => {
        const name = b.dataset.clearImage;
        form.elements[name].value = '';
        $(`[data-preview-for="${name}"]`, form).hidden = true;
        markDirty();
      }),
    );

    $('[data-entry-del]', form)?.addEventListener('click', async () => {
      try {
        const r = await call('deleteEntry', { collection: c.name, id: state.params.id });
        if (r.deleted) {
          editor = null;
          toast('Entry deleted');
          setView('collection', { collection: c.name });
        }
      } catch (e) {
        fail(e);
      }
    });
    (titleField && isNew ? form.elements[titleField.name] : null)?.focus();
  }

  function translationsBox(c, entry) {
    // sibling entries are found via the cached overview? fetch lazily
    setTimeout(async () => {
      const box = $('#translations');
      if (!box) return;
      const all = await call('entries', { collection: c.name });
      box.innerHTML = c.locales
        .map((l) => {
          const t = all.find((x) => x.slug === entry.slug && x.locale === l);
          if (l === entry.locale) return `<li><span class="badge">${esc(l)}</span> <strong>this version</strong></li>`;
          return t
            ? `<li><span class="badge">${esc(l)}</span> <a data-go="entry" data-collection="${esc(c.name)}" data-id="${esc(t.id)}">${esc(t.title)}</a></li>`
            : `<li><span class="badge">${esc(l)}</span> <a data-translate="${esc(l)}">+ Add translation</a></li>`;
        })
        .join('');
      $$('[data-translate]', box).forEach((a) =>
        a.addEventListener('click', async () => {
          if (!(await guardDirty())) return;
          try {
            const r = await call('duplicateEntry', { collection: c.name, id: state.params.id, locale: a.dataset.translate });
            editor = null;
            toast(`Created ${a.dataset.translate} version — translate it now`);
            setView('entry', { collection: c.name, id: r.id });
          } catch (e) {
            fail(e);
          }
        }),
      );
    });
    return `<div class="card box"><h3>Translations</h3><ul class="plain" id="translations"><li class="muted">Loading…</li></ul></div>`;
  }

  function fieldInput(f, entry) {
    const v = entry.data[f.name];
    const id = `f-${f.name}`;
    const label = `<span>${esc(humanize(f.name))}${f.required ? ' <span class="req">*</span>' : ''}${f.extra ? ' <span class="badge" title="Not in the schema">extra</span>' : ''}</span>`;
    const req = f.required ? 'required' : '';
    switch (f.type) {
      case 'boolean':
        return `<label class="check"><input type="checkbox" name="${esc(f.name)}" ${v === true ? 'checked' : ''}> ${label}</label>`;
      case 'number':
        return `<label for="${id}">${label}<input id="${id}" type="number" step="any" name="${esc(f.name)}" value="${esc(v ?? '')}" ${req}></label>`;
      case 'date': {
        const s = v ? String(v) : '';
        const withTime = /T\d/.test(s);
        return `<label for="${id}">${label}<input id="${id}" type="${withTime ? 'datetime-local' : 'date'}" name="${esc(f.name)}" value="${esc(withTime ? s.slice(0, 16) : s.slice(0, 10))}" ${req}></label>`;
      }
      case 'enum':
        return `<label for="${id}">${label}<select id="${id}" name="${esc(f.name)}" ${req}>${f.required ? '' : '<option value="">—</option>'}${(f.options ?? [])
          .map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`)
          .join('')}</select></label>`;
      case 'tags':
        return `<label for="${id}">${label}<input id="${id}" name="${esc(f.name)}" data-type="tags" value="${esc(Array.isArray(v) ? v.join(', ') : v ?? '')}" placeholder="comma, separated"></label>`;
      case 'text':
        return `<label for="${id}">${label}<textarea id="${id}" name="${esc(f.name)}" rows="3" ${req}>${esc(v ?? '')}</textarea></label>`;
      case 'image': {
        const uri = entry.imageUris?.[f.name];
        return `<div class="image-field"><label for="${id}">${label}<input id="${id}" name="${esc(f.name)}" value="${esc(v ?? '')}" ${req}></label>
          <img data-preview-for="${esc(f.name)}" src="${esc(uri ?? '')}" alt="" ${uri ? '' : 'hidden'}>
          <div class="row"><button type="button" class="btn small" data-pick-image="${esc(f.name)}">Choose image</button><button type="button" class="btn small ghost" data-clear-image="${esc(f.name)}">Remove</button></div></div>`;
      }
      case 'json':
        return `<label for="${id}">${label}<textarea id="${id}" class="mono" data-type="json" name="${esc(f.name)}" rows="4">${esc(v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</textarea></label>`;
      default:
        return `<label for="${id}">${label}<input id="${id}" name="${esc(f.name)}" value="${esc(v ?? '')}" ${req}></label>`;
    }
  }

  /** The boolean field that marks drafts: `draft: true` or `published: false`. */
  function draftField(c) {
    return c.fields.find((f) => f.type === 'boolean' && (f.name === 'draft' || f.name === 'published'));
  }

  async function save(status = 'keep') {
    if (!editor) return;
    const { c, isNew, statusField } = editor;
    const form = $('#entry-form');
    if (!form.reportValidity()) return;
    if (!form.elements.__slug.value) return toast('Please add a title or a file name', 'error');
    const values = {};
    for (const f of c.fields) {
      const el = form.elements[f.name];
      if (!el) continue;
      if (f.type === 'boolean') values[f.name] = el.checked;
      else if (f.type === 'number') values[f.name] = el.value === '' ? '' : Number(el.value);
      else if (f.type === 'tags') values[f.name] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      else if (f.type === 'json') {
        try {
          values[f.name] = el.value.trim() ? JSON.parse(el.value) : '';
        } catch {
          return toast(`"${f.name}" is not valid JSON`, 'error');
        }
      } else values[f.name] = el.value;
      if (Array.isArray(values[f.name]) && !values[f.name].length && !f.required) values[f.name] = '';
    }
    const draft = status === 'keep' ? editor.isDraft : status === 'draft';
    if (statusField) values[statusField.name] = statusField.name === 'draft' ? draft : !draft;
    // keep frontmatter keys the form doesn't know about
    for (const [k, v] of Object.entries(editor.entry.data)) if (!(k in values) && !c.fields.some((f) => f.name === k)) values[k] = v;
    try {
      const r = await call('saveEntry', {
        collection: c.name,
        id: isNew ? undefined : state.params.id,
        slug: form.elements.__slug.value,
        locale: form.elements.__locale?.value ?? (c.localized ? editor.entry.locale : null),
        data: values,
        body: form.elements.__body?.value ?? '',
      });
      editor.dirty = false;
      $('.dirty-flag').hidden = true;
      const msg = !statusField ? (isNew ? 'Published' : 'Updated') : draft ? (editor.isDraft || isNew ? 'Draft saved' : 'Moved to drafts') : editor.isDraft || isNew ? 'Published' : 'Updated';
      toast(msg, 'success');
      if (isNew || r.id !== state.params.id || draft !== editor.isDraft) {
        editor = null;
        setView('entry', { collection: c.name, id: r.id });
      }
    } catch (e) {
      fail(e);
    }
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.view === 'entry') {
      e.preventDefault();
      save();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'k' && e.target.matches?.('.md-body')) {
      e.preventDefault();
      insertLink(e.target).then((ok) => {
        if (ok && editor) {
          editor.dirty = true;
          $('.dirty-flag').hidden = false;
        }
      });
    } else if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.view === 'data') {
      e.preventDefault();
      editor?.save?.();
    }
  });

  /** Opens the link picker and puts [text](url) at the cursor (selected text becomes the link text). */
  async function insertLink(ta) {
    const { selectionStart: s, selectionEnd: en } = ta;
    const selected = ta.value.slice(s, en);
    const locale = $('#entry-form')?.elements.__locale?.value ?? editor?.entry?.locale ?? null;
    const r = await pickLink({ text: selected.trim(), locale });
    if (!r) {
      ta.focus();
      return false;
    }
    const md = `[${r.text.replace(/[[\]]/g, '')}](${r.url})`;
    ta.value = ta.value.slice(0, s) + md + ta.value.slice(en);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + md.length;
    return true;
  }

  function insertMd(ta, before, after = '', placeholder = '') {
    const { selectionStart: s, selectionEnd: en, value } = ta;
    const sel = value.slice(s, en) || placeholder;
    ta.value = value.slice(0, s) + before + sel + after + value.slice(en);
    ta.focus();
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
  }
  function prefixLines(ta, fn) {
    const { selectionStart: s, selectionEnd: en, value } = ta;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const lines = value.slice(start, en).split('\n').map(fn);
    ta.value = value.slice(0, start) + lines.join('\n') + value.slice(en);
    ta.focus();
  }
  function mdAction(ta, kind) {
    if (kind === 'bold') insertMd(ta, '**', '**', 'bold text');
    else if (kind === 'italic') insertMd(ta, '_', '_', 'italic text');
    else if (kind === 'link') insertMd(ta, '[', '](https://)', 'link text');
    else if (kind === 'h2') prefixLines(ta, (l) => `## ${l.replace(/^#+\s*/, '')}`);
    else if (kind === 'ul') prefixLines(ta, (l) => `- ${l}`);
    else if (kind === 'ol') prefixLines(ta, (l, i) => `${i + 1}. ${l}`);
    else if (kind === 'quote') prefixLines(ta, (l) => `> ${l}`);
  }

  /** Minimal markdown → HTML for the preview tab. */
  function renderMarkdown(md) {
    const inline = (s) =>
      esc(s)
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="img-ph">🖼 $1</span>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a title="$2">$1</a>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w])_([^_]+)_/g, '$1<em>$2</em>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    const out = [];
    let list = null;
    let code = null;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of md.split('\n')) {
      if (code !== null) {
        if (/^```/.test(line)) {
          out.push(`<pre><code>${esc(code)}</code></pre>`);
          code = null;
        } else code += line + '\n';
        continue;
      }
      let m;
      if (/^```/.test(line)) {
        flush();
        code = '';
      } else if ((m = /^(#{1,6})\s+(.*)/.exec(line))) {
        flush();
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      } else if ((m = /^\s*[-*+]\s+(.*)/.exec(line)) || (m = /^\s*\d+\.\s+(.*)/.exec(line))) {
        const type = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
        if (para.length) flush();
        if (list !== type) {
          if (list) out.push(`</${list}>`);
          out.push(`<${type}>`);
          list = type;
        }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = /^>\s?(.*)/.exec(line))) {
        flush();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if (!line.trim()) flush();
      else {
        if (list) flush();
        para.push(line);
      }
    }
    flush();
    return out.join('\n') || '<p class="muted">Nothing to preview.</p>';
  }

  // ---------- media ----------
  async function loadMedia() {
    if (!mediaCache) mediaCache = await call('media');
    return mediaCache;
  }

  async function mediaView(main) {
    main.innerHTML = `<header class="page-header"><div><h1>Media Library</h1><p class="muted">Files in ${esc((data.mediaFolders || []).join(', '))}</p></div>
      <div class="actions"><select id="upload-folder" title="Upload to"></select><button class="btn primary" id="upload-btn">Add new media</button></div></header>
      <div class="dropzone" id="dropzone">Drop files here to upload</div>
      <div class="toolbar"><input type="search" id="mq" placeholder="Search media…"><select id="mkind"><option value="">All media</option><option value="image">Images</option><option value="video">Video</option><option value="audio">Audio</option><option value="document">Documents</option><option value="other">Other</option></select>
      <select id="mfolder"><option value="">All folders</option></select><label class="check small"><input type="checkbox" id="munused"> Unused only</label><span class="spacer"></span><span class="muted small" id="mcount"></span></div>
      <div class="media-layout"><div class="media-grid" id="grid"><div class="loading">Loading…</div></div><aside class="media-details" id="details" hidden></aside></div>`;
    let lib;
    try {
      lib = await loadMedia();
    } catch (e) {
      return fail(e);
    }
    const folders = [...new Set(lib.items.map((m) => m.file.split('/').slice(0, -1).join('/')))].sort();
    const uploadTargets = [...new Set([lib.uploadFolder, ...lib.folders, ...folders])];
    $('#upload-folder').innerHTML = uploadTargets.map((f) => `<option>${esc(f)}</option>`).join('');
    $('#mfolder').innerHTML += folders.map((f) => `<option>${esc(f)}</option>`).join('');
    let selected = state.params.selected;

    const draw = () => {
      const q = $('#mq').value.toLowerCase();
      const kind = $('#mkind').value;
      const folder = $('#mfolder').value;
      const unused = $('#munused').checked;
      const items = lib.items.filter(
        (m) => (!q || m.file.toLowerCase().includes(q)) && (!kind || m.kind === kind) && (!folder || m.file.startsWith(folder + '/')) && (!unused || !m.usedIn.length),
      );
      $('#mcount').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
      $('#grid').innerHTML = items.length
        ? items
            .map(
              (m) => `<button class="tile ${m.file === selected ? 'selected' : ''}" data-file="${esc(m.file)}" title="${esc(m.file)}">
              ${m.kind === 'image' ? `<img src="${esc(m.uri)}" alt="" loading="lazy">` : `<span class="file-icon">${esc(m.ext.toUpperCase())}</span>`}
              <span class="tile-name">${esc(m.name)}</span>${m.usedIn.length ? '' : '<span class="unused" title="Not referenced in src/">unused</span>'}</button>`,
            )
            .join('')
        : '<p class="muted">No media found.</p>';
      showDetails();
    };
    const showDetails = () => {
      const d = $('#details');
      const m = lib.items.find((x) => x.file === selected);
      if (!m) return (d.hidden = true);
      d.hidden = false;
      const importName = m.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^\d/, '_$&');
      const isPublic = m.file.startsWith('public/');
      const url = isPublic ? `${data.site?.base ?? ''}/${m.file.slice(7)}` : null;
      d.innerHTML = `<div class="details-head"><h3>Attachment details</h3><button class="icon-btn" id="close-details" title="Close">✕</button></div>
        ${m.kind === 'image' ? `<img class="details-img" src="${esc(m.uri)}" alt="" id="details-img">` : m.kind === 'video' ? `<video class="details-img" src="${esc(m.uri)}" controls></video>` : m.kind === 'audio' ? `<audio src="${esc(m.uri)}" controls></audio>` : `<div class="file-icon big">${esc(m.ext.toUpperCase())}</div>`}
        <dl class="meta"><dt>File</dt><dd>${esc(m.name)}</dd><dt>Folder</dt><dd>${esc(m.file.split('/').slice(0, -1).join('/'))}</dd><dt>Size</dt><dd>${fmtSize(m.size)}</dd>
        <dt>Dimensions</dt><dd id="dims">—</dd><dt>Modified</dt><dd>${fmtDate(m.mtime)}</dd>
        <dt>Used in</dt><dd>${m.usedIn.length ? m.usedIn.map((u) => `<a data-action="open-file" data-file="${esc(u)}">${esc(u)}</a>`).join('<br>') : '<span class="muted">Not referenced in src/</span>'}</dd></dl>
        <label class="small">Path<input readonly value="${esc(m.file)}"></label>
        <div class="details-actions">
          <button class="btn small" data-action="copy" data-text="${esc(m.file)}">Copy path</button>
          ${url ? `<button class="btn small" data-action="copy" data-text="${esc(url)}">Copy URL</button>` : `<button class="btn small" data-action="copy" data-text="${esc(`import ${importName} from '~/${m.file.replace(/^src\//, '')}';`)}" title="Needs a ~ alias; otherwise use a relative path">Copy import</button>`}
          ${m.kind === 'image' && !isPublic ? `<button class="btn small" data-action="copy" data-text="${esc(`<Image src={${importName}} alt="" />`)}">Copy &lt;Image&gt;</button>` : ''}
          <button class="btn small" data-action="reveal" data-file="${esc(m.file)}">Reveal</button>
        </div>
        <div class="details-actions"><a id="rename">Rename</a> · <a class="danger" id="delete">Delete permanently</a></div>`;
      const img = $('#details-img');
      if (img) img.onload = () => ($('#dims').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`);
      $('#close-details').onclick = () => {
        selected = null;
        draw();
      };
      $('#rename').onclick = async () => {
        try {
          const r = await call('renameMedia', { file: m.file, usedIn: m.usedIn });
          if (r.file) {
            selected = r.file;
            await reload();
          }
        } catch (e) {
          fail(e);
        }
      };
      $('#delete').onclick = async () => {
        try {
          const r = await call('deleteMedia', { file: m.file, usedIn: m.usedIn });
          if (r.deleted) {
            selected = null;
            toast('Deleted');
            await reload();
          }
        } catch (e) {
          fail(e);
        }
      };
    };
    const reload = async () => {
      mediaCache = null;
      lib = await loadMedia();
      draw();
    };
    $('#grid').addEventListener('click', (e) => {
      const t = e.target.closest('.tile');
      if (!t) return;
      selected = t.dataset.file;
      state.params.selected = selected;
      vscode.setState(state);
      $$('.tile').forEach((x) => x.classList.toggle('selected', x === t));
      showDetails();
    });
    ['mq', 'mkind', 'mfolder', 'munused'].forEach((id) => $('#' + id).addEventListener('input', draw));
    $('#upload-btn').addEventListener('click', async () => {
      try {
        const r = await call('pickMedia', { folder: $('#upload-folder').value });
        if (r.saved.length) {
          toast(`Uploaded ${r.saved.length} file(s)`, 'success');
          selected = r.saved[0];
          await reload();
        }
      } catch (e) {
        fail(e);
      }
    });
    setupDropzone($('.main'), $('#dropzone'), async (files) => {
      const r = await uploadFiles(files, $('#upload-folder').value);
      selected = r.saved[0];
      await reload();
    });
    draw();
  }

  function setupDropzone(target, zone, onDone) {
    let depth = 0;
    target.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      zone.classList.add('active');
    });
    target.addEventListener('dragleave', () => {
      if (--depth <= 0) zone.classList.remove('active');
    });
    target.addEventListener('dragover', (e) => e.preventDefault());
    target.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('active');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return toast('Hold Shift while dropping files from outside VS Code', 'info');
      try {
        await onDone(files);
      } catch (err) {
        fail(err);
      }
    });
  }

  async function uploadFiles(files, folder) {
    const payload = await Promise.all(
      files.map(
        (f) =>
          new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res({ name: f.name, data: String(r.result).split(',')[1] ?? '' });
            r.onerror = () => rej(r.error);
            r.readAsDataURL(f);
          }),
      ),
    );
    const r = await call('uploadMedia', { folder, files: payload });
    toast(`Uploaded ${r.saved.length} file(s)`, 'success');
    mediaCache = null;
    return r;
  }

  /** Modal media picker used by the editor. Resolves to a media item or null. */
  async function pickMedia(kind) {
    let lib = await loadMedia();
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `<div class="modal wide"><div class="details-head"><h2>Select media</h2><button class="icon-btn" data-close>✕</button></div>
        <div class="toolbar"><input type="search" placeholder="Search…" class="pq"><span class="spacer"></span><button class="btn" data-upload>Upload files</button></div>
        <div class="dropzone">Drop files here to upload</div>
        <div class="media-grid picker"></div>
        <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-choose disabled>Insert</button></div></div>`;
      document.body.appendChild(wrap);
      let chosen = null;
      const grid = $('.media-grid', wrap);
      const draw = () => {
        const q = $('.pq', wrap).value.toLowerCase();
        const items = lib.items.filter((m) => (!kind || m.kind === kind) && (!q || m.file.toLowerCase().includes(q)));
        grid.innerHTML = items.length
          ? items
              .map(
                (m) =>
                  `<button class="tile ${chosen?.file === m.file ? 'selected' : ''}" data-file="${esc(m.file)}" title="${esc(m.file)}">${m.kind === 'image' ? `<img src="${esc(m.uri)}" alt="" loading="lazy">` : `<span class="file-icon">${esc(m.ext.toUpperCase())}</span>`}<span class="tile-name">${esc(m.name)}</span></button>`,
              )
              .join('')
          : '<p class="muted">No media yet — upload some.</p>';
      };
      const close = (v) => {
        wrap.remove();
        resolve(v);
      };
      wrap.addEventListener('click', async (e) => {
        if (e.target === wrap || e.target.closest('[data-close]')) return close(null);
        const t = e.target.closest('.tile');
        if (t) {
          chosen = lib.items.find((m) => m.file === t.dataset.file);
          $$('.tile', wrap).forEach((x) => x.classList.toggle('selected', x === t));
          $('[data-choose]', wrap).disabled = false;
          if (e.detail === 2) close(chosen);
        }
        if (e.target.closest('[data-choose]') && chosen) close(chosen);
        if (e.target.closest('[data-upload]')) {
          try {
            const r = await call('pickMedia', {});
            if (r.saved.length) {
              mediaCache = null;
              lib = await loadMedia();
              chosen = lib.items.find((m) => m.file === r.saved[0]);
              $('[data-choose]', wrap).disabled = !chosen;
              draw();
            }
          } catch (err) {
            fail(err);
          }
        }
      });
      setupDropzone(wrap, $('.dropzone', wrap), async (files) => {
        const r = await uploadFiles(files);
        lib = await loadMedia();
        chosen = lib.items.find((m) => m.file === r.saved[0]);
        $('[data-choose]', wrap).disabled = !chosen;
        draw();
      });
      $('.pq', wrap).addEventListener('input', draw);
      wrap.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
      draw();
      $('.pq', wrap).focus();
    });
  }

  /** Modal for inserting a link to a page or entry of this site (or any URL). Resolves to { text, url } or null. */
  async function pickLink({ text = '', locale = null } = {}) {
    let targets = [];
    try {
      targets = await call('linkTargets');
    } catch (e) {
      fail(e);
    }
    const locales = data.site?.locales ?? [];
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `<div class="modal wide link-modal" role="dialog" aria-modal="true">
        <div class="details-head"><h2>Insert link</h2><button class="icon-btn" data-close title="Close">✕</button></div>
        <div class="toolbar"><input type="search" class="lq" placeholder="Search pages and posts…">
          ${locales.length ? `<select class="ll"><option value="">All languages</option>${locales.map((l) => `<option ${l === locale ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}</div>
        <div class="link-list"></div>
        <div class="link-fields">
          <label>Link text<input class="lt" value="${esc(text)}" placeholder="e.g. team page"></label>
          <label>URL<input class="lu" placeholder="/page/ or https://…"></label>
        </div>
        <div class="modal-actions"><span class="muted small preview-md"></span><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" data-insert disabled>Insert link</button></div></div>`;
      document.body.appendChild(wrap);
      const $w = (s) => wrap.querySelector(s);
      let textTouched = !!text;
      let chosen = null;
      const update = () => {
        const url = $w('.lu').value.trim();
        const t = $w('.lt').value.trim() || chosen?.title || url;
        $w('[data-insert]').disabled = !url;
        $w('.preview-md').textContent = url ? `[${t}](${url})` : '';
      };
      const draw = () => {
        const q = $w('.lq').value.toLowerCase();
        const l = $w('.ll')?.value ?? '';
        const items = targets.filter((x) => (!l || !x.locale || x.locale === l) && (!q || `${x.title} ${x.route}`.toLowerCase().includes(q)));
        const groups = [...new Set(items.map((x) => x.group))];
        $w('.link-list').innerHTML = items.length
          ? groups
              .map(
                (g) => `<div class="link-group">${esc(g === 'Pages' ? 'Pages' : humanize(g))}</div>${items
                  .filter((x) => x.group === g)
                  .map(
                    (x) => `<button type="button" class="link-row ${chosen?.route === x.route ? 'selected' : ''}" data-route="${esc(x.route)}">
                      <span class="link-title">${esc(x.title)}${x.draft ? ' <span class="badge warn">Draft</span>' : ''}</span>
                      ${x.locale && !l ? `<span class="badge">${esc(x.locale)}</span>` : ''}<code>${esc(x.route)}</code></button>`,
                  )
                  .join('')}`,
              )
              .join('')
          : '<p class="muted">Nothing found. You can still type any URL below.</p>';
      };
      const close = (v) => {
        wrap.remove();
        resolve(v);
      };
      const insert = () => {
        const url = $w('.lu').value.trim();
        if (!url) return;
        close({ text: $w('.lt').value.trim() || chosen?.title || url, url });
      };
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap || e.target.closest('[data-close]')) return close(null);
        if (e.target.closest('[data-insert]')) return insert();
        const row = e.target.closest('.link-row');
        if (!row) return;
        chosen = targets.find((x) => x.route === row.dataset.route);
        $w('.lu').value = chosen.route;
        if (!textTouched) $w('.lt').value = chosen.title;
        wrap.querySelectorAll('.link-row').forEach((r) => r.classList.toggle('selected', r === row));
        update();
        if (e.detail === 2) insert();
      });
      $w('.lq').addEventListener('input', draw);
      $w('.ll')?.addEventListener('change', draw);
      $w('.lt').addEventListener('input', () => {
        textTouched = !!$w('.lt').value;
        update();
      });
      $w('.lu').addEventListener('input', () => {
        chosen = targets.find((x) => x.route === $w('.lu').value.trim()) ?? null;
        update();
      });
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !$w('[data-insert]').disabled) {
          e.preventDefault();
          insert();
        }
      });
      draw();
      update();
      $w('.lq').focus();
    });
  }

  // ---------- pages ----------
  async function pagesView(main) {
    main.innerHTML = `<header class="page-header"><div><h1>Pages</h1><p class="muted">Routes from src/pages</p></div></header>
      <div class="toolbar"><input type="search" id="pq" placeholder="Search pages…"><select id="pk"><option value="">All types</option><option value="page">Static pages</option><option value="dynamic">Dynamic routes</option><option value="endpoint">Endpoints</option></select>
      ${data.site?.locales?.length ? `<select id="pl"><option value="">All languages</option>${data.site.locales.map((l) => `<option>${esc(l)}</option>`).join('')}</select>` : ''}</div>
      <div id="plist"><div class="loading">Loading…</div></div>`;
    let pages;
    try {
      pages = await call('pages');
    } catch (e) {
      return fail(e);
    }
    const draw = () => {
      const q = $('#pq').value.toLowerCase();
      const k = $('#pk').value;
      const l = $('#pl')?.value;
      const rows = pages.filter((p) => (!q || (p.route + p.file + (p.title ?? '')).toLowerCase().includes(q)) && (!k || p.kind === k) && (!l || p.locale === l));
      $('#plist').innerHTML = `<table class="table"><thead><tr><th>Page</th><th>Route</th>${data.site?.locales?.length ? '<th>Lang</th>' : ''}<th>Type</th></tr></thead><tbody>${rows
        .map(
          (p) => `<tr><td><a class="row-title" data-action="open-file" data-file="${esc(p.file)}">${esc(p.title ?? p.file.replace(/^src\/pages\//, ''))}</a>
          <div class="row-actions"><a data-action="open-file" data-file="${esc(p.file)}">Edit</a>${p.kind === 'page' ? ` · <a data-action="preview" data-route="${esc(p.route)}" title="Alt+click: open in browser">View</a>` : ''} · <a data-action="copy" data-text="${esc(p.route)}">Copy URL</a></div>
          <div class="muted small">${esc(p.file)}</div></td><td><code>${esc(p.route)}</code></td>${data.site?.locales?.length ? `<td>${p.locale ? `<span class="badge">${esc(p.locale)}</span>` : ''}</td>` : ''}<td>${p.kind === 'page' ? 'Page' : p.kind === 'dynamic' ? '<span class="badge">Dynamic</span>' : '<span class="badge">Endpoint</span>'}</td></tr>`,
        )
        .join('')}</tbody></table>`;
    };
    ['pq', 'pk', 'pl'].forEach((id) => $('#' + id)?.addEventListener('input', draw));
    draw();
  }

  // ---------- new collection (custom post type) ----------
  const FIELD_TYPES = [
    ['string', 'Text (short)'],
    ['text', 'Text (long)'],
    ['number', 'Number'],
    ['boolean', 'Yes / No'],
    ['date', 'Date'],
    ['enum', 'Choice (select)'],
    ['tags', 'List of text (tags)'],
    ['image', 'Image'],
  ];

  function newCollectionView(main) {
    const locales = data.site?.locales ?? [];
    main.innerHTML = `<header class="page-header"><div><h1>New collection</h1><p class="muted">A collection is like a custom post type: a folder of entries that share the same fields.</p></div></header>
      <form id="nc" class="nc-layout">
        <div>
          <div class="card box form">
            <label>Name <span class="muted small">(used in code: <code>getCollection('…')</code>)</span><input name="name" required pattern="[a-zA-Z_][a-zA-Z0-9_]*" placeholder="e.g. blog, team, services"></label>
            <label>Folder<input name="folder" placeholder="src/content/…"></label>
            <label>Entry type<select name="kind"><option value="content">Markdown documents (fields + body text)</option><option value="data">Data only (JSON/YAML, no body)</option></select></label>
            ${locales.length ? `<label class="check"><input type="checkbox" name="localized" checked> Translatable — create a subfolder per language (${locales.map(esc).join(', ')})</label>` : ''}
          </div>
          <div class="card box"><h3>Fields</h3>
            <table class="table fields"><thead><tr><th>Field name</th><th>Type</th><th>Required</th><th></th></tr></thead><tbody id="fields"></tbody></table>
            <button type="button" class="btn" id="add-field">+ Add field</button>
          </div>
        </div>
        <aside>
          <div class="card box"><h3>Create</h3><p class="muted small">Adds the collection to <code>${esc(data.site?.contentConfigFile ?? 'src/content.config.ts')}</code> and creates the folder.</p>
            <button class="btn primary" type="submit">Create collection</button></div>
          <div class="card box"><h3>Code preview</h3><pre class="code" id="code"></pre></div>
        </aside>
      </form>`;
    const tbody = $('#fields');
    const addRow = (f = { name: '', type: 'string', required: false }) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><input class="fname" value="${esc(f.name)}" placeholder="fieldName" pattern="[a-zA-Z_][a-zA-Z0-9_]*" required></td>
        <td><select class="ftype">${FIELD_TYPES.map(([v, l]) => `<option value="${v}" ${v === f.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input class="fopts" placeholder="option1, option2" ${f.type === 'enum' ? '' : 'hidden'}></td>
        <td><input type="checkbox" class="freq" ${f.required ? 'checked' : ''}></td><td><button type="button" class="icon-btn" title="Remove">✕</button></td>`;
      tr.querySelector('.icon-btn').onclick = () => {
        tr.remove();
        preview();
      };
      tr.querySelector('.ftype').onchange = (e) => (tr.querySelector('.fopts').hidden = e.target.value !== 'enum');
      tbody.appendChild(tr);
    };
    [
      { name: 'title', type: 'string', required: true },
      { name: 'date', type: 'date', required: true },
      { name: 'description', type: 'text', required: false },
      { name: 'draft', type: 'boolean', required: false },
    ].forEach(addRow);
    $('#add-field').onclick = () => {
      addRow();
      tbody.lastElementChild.querySelector('.fname').focus();
    };

    const form = $('#nc');
    const def = () => ({
      name: form.elements.name.value.trim(),
      folder: form.elements.folder.value.trim() || undefined,
      kind: form.elements.kind.value,
      locales: form.elements.localized?.checked ? locales : [],
      fields: $$('tr', tbody)
        .map((tr) => ({
          name: tr.querySelector('.fname').value.trim(),
          type: tr.querySelector('.ftype').value,
          required: tr.querySelector('.freq').checked,
          options: tr.querySelector('.fopts').value.split(',').map((s) => s.trim()).filter(Boolean),
        }))
        .filter((f) => f.name),
    });
    const zod = (f) =>
      ({ number: 'z.number()', boolean: 'z.boolean()', date: 'z.coerce.date()', tags: 'z.array(z.string())', image: 'image()', enum: `z.enum([${f.options.map((o) => JSON.stringify(o)).join(', ')}])` })[f.type] ?? 'z.string()';
    const preview = () => {
      const d = def();
      const n = d.name || 'name';
      const folder = d.folder || `src/content/${n}`;
      const lines = d.fields.map((f) => `    ${f.name}: ${zod(f)}${f.type === 'boolean' ? '.default(false)' : f.required ? '' : '.optional()'},`).join('\n');
      $('#code').textContent = `const ${n} = defineCollection({\n  loader: glob({ pattern: '${d.kind === 'content' ? '**/*.{md,mdx}' : '**/*.{json,yaml,yml}'}', base: './${folder}' }),\n  schema: ${d.fields.some((f) => f.type === 'image') ? '({ image }) => ' : ''}z.object({\n${lines}\n  }),\n});`;
      form.elements.folder.placeholder = `src/content/${d.name || '…'}`;
    };
    form.addEventListener('input', preview);
    preview();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = def();
      const names = d.fields.map((f) => f.name);
      if (new Set(names).size !== names.length) return toast('Field names must be unique', 'error');
      if (d.fields.some((f) => f.type === 'enum' && !f.options.length)) return toast('Add options for each choice field', 'error');
      try {
        await call('addCollection', d);
        await loadOverview();
        toast(`Collection "${d.name}" created`, 'success');
        setView('collection', { collection: d.name });
      } catch (err) {
        fail(err);
      }
    });
    form.elements.name.focus();
  }

  // ---------- config / data files (e.g. src/data/site.ts) ----------
  const TITLE_KEYS = ['name', 'title', 'label', 'heading', 'id', 'key', 'slug'];

  function isLangGroup(n) {
    if (n.kind !== 'object' || !n.entries.length || n.entries.length > 6) return false;
    if (!n.entries.every((e) => e.node.kind === 'string')) return false;
    const locales = data.site?.locales ?? [];
    return n.entries.every((e) => locales.includes(e.key)) || n.entries.every((e) => e.key.length <= 3);
  }

  function nodeText(n) {
    if (!n) return '';
    if (n.kind === 'string' || n.kind === 'number' || n.kind === 'boolean') return String(n.value);
    if (n.kind === 'object' && isLangGroup(n)) {
      const def = n.entries.find((e) => e.key === data.site?.defaultLocale) ?? n.entries[0];
      return def.node.value;
    }
    return '';
  }

  function itemTitle(n, i) {
    if (n.kind !== 'object') return `Item ${i + 1}`;
    if (isLangGroup(n)) return nodeText(n) || `Item ${i + 1}`;
    for (const k of TITLE_KEYS) {
      const e = n.entries.find((x) => x.key === k);
      const t = e && nodeText(e.node);
      if (t) return t;
    }
    const first = n.entries.find((e) => nodeText(e.node));
    return first ? `${humanize(first.key)}: ${nodeText(first.node)}` : `Item ${i + 1}`;
  }

  const pathAttr = (p) => esc(JSON.stringify(p));

  function primitiveInput(n, id) {
    const p = pathAttr(n.path);
    if (n.kind === 'boolean') return `<input type="checkbox" id="${id}" data-path="${p}" data-kind="boolean" data-orig="${n.value}" ${n.value ? 'checked' : ''}>`;
    if (n.kind === 'number') return `<input type="number" step="any" id="${id}" data-path="${p}" data-kind="number" data-orig="${n.value}" value="${n.value}">`;
    if (n.kind === 'null') return `<input id="${id}" data-path="${p}" data-kind="null" data-orig="" value="" placeholder="empty (null)">`;
    const v = n.value;
    if (v.length > 70 || v.includes('\n'))
      return `<textarea id="${id}" rows="${Math.min(8, Math.max(2, Math.ceil(v.length / 90) + (v.match(/\n/g)?.length ?? 0)))}" data-path="${p}" data-kind="string" data-orig="${esc(v)}">${esc(v)}</textarea>`;
    return `<input id="${id}" data-path="${p}" data-kind="string" data-orig="${esc(v)}" value="${esc(v)}">`;
  }

  let fieldSeq = 0;
  function renderData(n, key, depth, file) {
    const label = typeof key === 'number' ? `#${key + 1}` : humanize(key);
    const help = n.comment ? `<small class="help">${esc(n.comment)}</small>` : '';
    const search = esc(`${key} ${n.comment ?? ''}`.toLowerCase());
    const id = `df-${++fieldSeq}`;
    if (n.kind === 'code') {
      return `<div class="field code-field" data-search="${search}"><label>${esc(label)}</label>${help}
        <div class="code-value">${n.imageUri ? `<img src="${esc(n.imageUri)}" alt="">` : ''}<code title="${esc(n.text)}">${esc(n.text)}</code>
        <a data-action="open-file" data-file="${esc(file)}" data-line="${n.line}" title="This value is code, edit it in the file">Edit in file</a></div></div>`;
    }
    if (n.kind === 'object' && isLangGroup(n)) {
      return `<div class="field lang-field" data-search="${search}"><label>${esc(label)}</label>${help}<div class="lang-inputs">${n.entries
        .map((e) => `<div class="lang-input"><span class="badge">${esc(e.key)}</span>${primitiveInput(e.node, `df-${++fieldSeq}`)}</div>`)
        .join('')}</div></div>`;
    }
    if (n.kind === 'object') {
      const body = n.entries.map((e) => renderData(e.node, e.key, depth + 1, file)).join('');
      if (depth === 0) return body;
      return `<details class="group" data-path="${pathAttr(n.path)}" ${depth < 2 ? 'open' : ''}><summary>${esc(label)}${help}</summary><div class="group-body">${body}</div></details>`;
    }
    if (n.kind === 'array') {
      const primitive = n.items.every((i) => ['string', 'number', 'boolean', 'null'].includes(i.kind));
      const actions = (item, i) => `<span class="item-actions">
          <button type="button" class="icon-btn" data-op="up" data-path="${pathAttr(item.path)}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-op="down" data-path="${pathAttr(item.path)}" title="Move down" ${i === n.items.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="icon-btn" data-op="duplicate" data-path="${pathAttr(item.path)}" title="Duplicate">⧉</button>
          <button type="button" class="icon-btn danger" data-op="remove" data-path="${pathAttr(item.path)}" title="Remove">✕</button></span>`;
      const items = primitive
        ? n.items.map((item, i) => `<div class="list-row">${primitiveInput(item, `df-${++fieldSeq}`)}${actions(item, i)}</div>`).join('')
        : n.items
            .map(
              (item, i) => `<details class="item" data-path="${pathAttr(item.path)}"><summary><span class="item-title">${esc(itemTitle(item, i))}</span>${actions(item, i)}</summary>
              <div class="group-body">${item.kind === 'object' && !isLangGroup(item) ? renderData(item, i, 0, file) : renderData(item, i, 1, file)}</div></details>`,
            )
            .join('');
      const add = n.canAdd
        ? `<button type="button" class="btn small" data-op="add" data-path="${pathAttr(n.path)}" title="${primitive ? 'Add an empty item' : 'Adds a copy of the last item'}">+ Add ${primitive ? 'item' : 'item (copy of last)'}</button>`
        : `<span class="muted small">Empty list — add the first item in the file.</span>`;
      const inner = `<div class="list ${primitive ? 'primitive' : ''}">${items}<div class="list-add">${add}</div></div>`;
      if (depth === 0) return `${help ? `<p class="muted">${esc(n.comment)}</p>` : ''}${inner}`;
      return `<details class="group" data-path="${pathAttr(n.path)}" ${depth < 2 ? 'open' : ''}><summary>${esc(label)} <span class="muted small">(${n.items.length})</span>${help}</summary><div class="group-body">${inner}</div></details>`;
    }
    return `<div class="field" data-search="${search} ${esc(nodeText(n).toLowerCase())}"><label for="${id}">${esc(label)}</label>${help}${primitiveInput(n, id)}</div>`;
  }

  async function dataView(main) {
    const files = data.dataFiles ?? [];
    if (!files.length) {
      main.innerHTML = `<header class="page-header"><div><h1>Config</h1></div></header><div class="empty card"><p>No config or data files found in <code>src/</code>.</p>
        <p class="muted">Files like <code>src/data/site.ts</code>, <code>src/config.ts</code> or <code>src/data/*.json</code> that export objects or lists show up here. You can also add files in the <a data-action="settings">dashboard settings</a> (Config Files).</p></div>`;
      return;
    }
    const fileRel = state.params.file && files.some((f) => f.file === state.params.file) ? state.params.file : files[0].file;
    state.params.file = fileRel;
    vscode.setState(state);
    main.innerHTML = '<div class="loading">Loading…</div>';
    let df;
    try {
      df = await call('dataFile', { file: fileRel });
    } catch (e) {
      main.innerHTML = `<div class="empty card"><p>Could not read <code>${esc(fileRel)}</code>: ${esc(e.message)}</p></div>`;
      return;
    }
    editor = { kind: 'data', dirty: false };
    const openState = new Set(state.params.open ?? []);
    const draw = (scroll = 0) => {
      fieldSeq = 0;
      main.innerHTML = `
        <header class="page-header sticky"><div><h1>${esc(df.label)}</h1><p class="muted"><a data-action="open-file" data-file="${esc(df.file)}">${esc(df.file)}</a></p></div>
          <div class="actions"><span class="dirty-flag" hidden>Unsaved changes</span><input type="search" id="dq" placeholder="Filter fields…"><button class="btn" id="d-revert" disabled>Revert</button><button class="btn primary" id="d-save" disabled>Save</button></div></header>
        ${df.data.length > 1 ? `<nav class="chips">${df.data.map((x) => `<a href="#exp-${esc(x.name)}" data-jump="${esc(x.name)}">${esc(humanize(x.name))}</a>`).join('')}</nav>` : ''}
        <form id="data-form" autocomplete="off">${df.data
          .map(
            (x) => `<section class="card box export" id="exp-${esc(x.name)}" data-search="${esc(x.name.toLowerCase())}">
            <div class="export-head"><h2>${esc(humanize(x.name))}</h2><a class="small" data-action="open-file" data-file="${esc(df.file)}" data-line="${x.line}">Open in file</a></div>
            ${x.comment ? `<p class="muted">${esc(x.comment)}</p>` : ''}
            ${x.node.kind === 'object' || x.node.kind === 'array' ? renderData(x.node, x.name, 0, df.file) : renderData(x.node, x.name, 1, df.file)}</section>`,
          )
          .join('')}</form>`;
      $$('details[data-path]', main).forEach((d) => {
        if (openState.has(d.dataset.path)) d.open = true;
        d.addEventListener('toggle', () => {
          d.open ? openState.add(d.dataset.path) : openState.delete(d.dataset.path);
          state.params.open = [...openState];
          vscode.setState(state);
        });
      });
      main.scrollTop = scroll;
      bind();
    };

    const pending = () =>
      $$('[data-kind]', main)
        .map((el) => {
          const kind = el.dataset.kind;
          if (kind === 'boolean') return el.checked !== (el.dataset.orig === 'true') ? { path: JSON.parse(el.dataset.path), value: el.checked } : null;
          if (el.value === el.dataset.orig) return null;
          let value = el.value;
          if (kind === 'number') value = el.value === '' ? 0 : Number(el.value);
          if (kind === 'null' && el.value === '') value = null;
          return { path: JSON.parse(el.dataset.path), value };
        })
        .filter(Boolean);

    const refreshDirty = () => {
      const n = pending().length;
      editor.dirty = n > 0;
      $('.dirty-flag', main).hidden = !n;
      $('.dirty-flag', main).textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
      $('#d-save', main).disabled = !n;
      $('#d-revert', main).disabled = !n;
      $$('[data-kind]', main).forEach((el) => {
        const changed = el.dataset.kind === 'boolean' ? el.checked !== (el.dataset.orig === 'true') : el.value !== el.dataset.orig;
        el.classList.toggle('changed', changed);
      });
    };

    const commit = async (op) => {
      const edits = pending();
      if (!edits.length && !op) return;
      if (op?.op === 'remove') {
        const ok = await dialog('Remove item', '<p>Remove this item from the list? You can undo it with ⌘Z in the file if needed.</p>', [
          { label: 'Cancel', value: false },
          { label: 'Remove', value: true, danger: true },
        ]);
        if (!ok) return;
      }
      try {
        const scroll = main.scrollTop;
        df = await call('saveDataFile', { file: df.file, edits, op });
        editor.dirty = false;
        // list items shift after structural changes; keep the parent groups open
        draw(scroll);
        toast(op ? (edits.length ? 'Saved' : 'List updated') : `Saved ${edits.length} change${edits.length === 1 ? '' : 's'}`, 'success');
      } catch (e) {
        fail(e);
      }
    };
    editor.save = () => commit();

    const bind = () => {
      const form = $('#data-form', main);
      form.addEventListener('input', refreshDirty);
      form.addEventListener('change', refreshDirty);
      form.addEventListener('submit', (e) => e.preventDefault());
      form.addEventListener('click', (e) => {
        const b = e.target.closest('[data-op]');
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        commit({ op: b.dataset.op, path: JSON.parse(b.dataset.path) });
      });
      $('#d-save', main).addEventListener('click', () => commit());
      $('#d-revert', main).addEventListener('click', () => {
        editor.dirty = false;
        draw(main.scrollTop);
      });
      $$('[data-jump]', main).forEach((a) =>
        a.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById(`exp-${a.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }),
      );
      $('#dq', main).addEventListener('input', (e) => filterFields(form, e.target.value.trim().toLowerCase()));
    };
    draw();
  }

  function filterFields(form, q) {
    const fields = $$('.field', form);
    for (const f of fields) {
      const values = $$('[data-kind]', f).map((el) => el.value.toLowerCase()).join(' ');
      f.hidden = !!q && !(f.dataset.search + ' ' + values).includes(q);
    }
    for (const d of $$('details', form).reverse()) {
      const any = $$('.field', d).some((f) => !f.hidden) || (q && $('summary', d).textContent.toLowerCase().includes(q));
      d.hidden = !!q && !any;
      if (q && any) d.open = true;
    }
    for (const s of $$('section.export', form)) s.hidden = !!q && !$$('.field', s).some((f) => !f.hidden);
  }

  // ---------- settings ----------
  function settingsView(main) {
    const s = data.site || {};
    const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
    main.innerHTML = `<header class="page-header"><div><h1>Settings</h1><p class="muted">Read from your Astro config</p></div>
      <div class="actions"><button class="btn" data-action="settings">Dashboard settings</button></div></header>
      <div class="grid-2">
        <section class="card box"><h3>Site</h3><table class="kv">
          ${row('Project', esc(s.name))}${row('Root', `<code>${esc(s.root)}</code>`)}${row('Site URL', esc(s.site ?? '—'))}${row('Base path', `<code>${esc(s.base || '/')}</code>`)}
          ${row('Astro version', esc(s.astroVersion ?? '—'))}${row('Integrations', (s.integrations || []).map((i) => `<span class="badge">${esc(i)}</span>`).join(' ') || '—')}
          ${row('Languages', s.locales?.length ? s.locales.map((l) => `<span class="badge">${esc(l)}${l === s.defaultLocale ? ' (default)' : ''}</span>`).join(' ') : 'Not configured')}
        </table>
        <p>${s.configFile ? `<button class="btn" data-action="open-file" data-file="${esc(s.configFile)}">Edit ${esc(s.configFile)}</button>` : ''} ${s.contentConfigFile ? `<button class="btn" data-action="open-file" data-file="${esc(s.contentConfigFile)}">Edit ${esc(s.contentConfigFile)}</button>` : ''}</p></section>
        <section class="card box"><h3>Collections</h3><table class="table"><thead><tr><th>Name</th><th>Folder</th><th>Fields</th></tr></thead><tbody>${data.collections
          .map((c) => `<tr><td><a data-go="collection" data-collection="${esc(c.name)}">${esc(c.name)}</a></td><td><code>${esc(c.baseRel)}</code></td><td>${c.fields.filter((f) => !f.extra).map((f) => `<span class="badge" title="${esc(f.type)}">${esc(f.name)}${f.required ? '*' : ''}</span>`).join(' ')}</td></tr>`)
          .join('')}</tbody></table></section>
        <section class="card box"><h3>Dashboard</h3><table class="kv">${row('Dev server URL', `<code>${esc(data.devUrl)}</code>`)}${row('Media folders', (data.mediaFolders || []).map((f) => `<code>${esc(f)}</code>`).join(', '))}${row('Upload folder', `<code>${esc(data.uploadFolder)}</code>`)}</table></section>
      </div>`;
  }

  // keep the dev-server indicator in sync (e.g. stopped from its terminal)
  setInterval(async () => {
    if (document.hidden || !data.site) return;
    try {
      const up = await call('devStatus');
      if (up === data.devServer) return;
      data.devServer = up;
      if (state.view === 'overview') render();
      else renderSidebar();
    } catch {
      /* ignore */
    }
  }, 8000);

  // ---------- boot ----------
  (async () => {
    try {
      const init = await call('init');
      data = init;
      if (init.view) {
        if (init.view.startsWith('new-entry:')) state = { view: 'entry', params: { collection: init.view.slice(10), isNew: true } };
        else state = { view: init.view, params: {} };
      }
      // don't restore a "new entry" draft form from a previous session
      if (state.view === 'entry' && state.params.isNew && !init.view) state = { view: 'collection', params: { collection: state.params.collection } };
      render();
    } catch (e) {
      app.innerHTML = `<div class="loading">Could not load dashboard: ${esc(e.message)}</div>`;
    }
  })();
})();
