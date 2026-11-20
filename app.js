'use strict';
/* Nimbus browser shell. Talks to sw.js; sw.js talks to the Cloudflare relay. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };
const hue = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

const ENGINES = {
  ddg:    { name: 'DuckDuckGo (HTML)', url: 'https://html.duckduckgo.com/html/?q=' },
  bing:   { name: 'Bing',              url: 'https://www.bing.com/search?q=' },
  mojeek: { name: 'Mojeek',            url: 'https://www.mojeek.com/search?q=' },
};
const LINKS = [
  { t: 'Wikipedia',   u: 'https://en.wikipedia.org/' },
  { t: 'Hacker News', u: 'https://news.ycombinator.com/' },
  { t: 'NPR Text',    u: 'https://text.npr.org/' },
  { t: 'Example',     u: 'https://example.com/' },
  { t: 'DuckDuckGo',  u: 'https://html.duckduckgo.com/html/' },
  { t: 'MDN',         u: 'https://developer.mozilla.org/' },
];

let relay = (localStorage.getItem('relay') || (window.PROXY_CONFIG && window.PROXY_CONFIG.relay) || '').trim().replace(/\/+$/, '');
let PFX = '';
let tabs = [], activeId = 0, nextId = 1, drawerView = 'history';
let bookmarks = read('bookmarks', []);
let visits = read('visits', []);

const cur = () => tabs.find(t => t.id === activeId);
const toProxy = real => PFX + encodeURIComponent(real);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('on'), 2600);
}

function resolveInput(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v)) return 'https://' + v;
  return (ENGINES[read('engine', 'ddg')] || ENGINES.ddg).url + encodeURIComponent(v);
}

/* ---------- tabs ---------- */
function newTab(url, focus = true) {
  const tab = { id: nextId++, url: '', title: 'New Tab', hist: [], idx: -1, loading: false, expect: false, el: null };
  const f = document.createElement('iframe');
  f.className = 'view';
  f.allow = 'fullscreen; autoplay; clipboard-write; picture-in-picture';
  f.addEventListener('load', () => {
    if (!tab.url) return;
    tab.loading = false; tab.expect = false;
    render();
  });
  $('#viewport').appendChild(f);
  tab.el = f;
  tabs.push(tab);
  if (focus) activeId = tab.id;
  if (url) go(tab, url);
  render();
  if (!url && focus) $('#home-q').focus();
  return tab;
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  tabs[i].el.remove();
  tabs.splice(i, 1);
  if (!tabs.length) return newTab('');
  if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)].id;
  render();
}

function go(tab, input) {
  const url = resolveInput(input);
  if (!url) return;
  if (!PFX) { toast('Engine not ready. Check Settings > Relay URL.'); openDrawer('settings'); return; }
  tab.url = url; tab.title = host(url); tab.loading = true; tab.expect = true;
  tab.hist = tab.hist.slice(0, tab.idx + 1); tab.hist.push(url); tab.idx = tab.hist.length - 1;
  tab.el.src = toProxy(url);
  render();
}

function onNav(tab, url) {
  if (tab.expect) { tab.expect = false; tab.hist[tab.idx] = url; }
  else if (url === tab.hist[tab.idx]) { /* same */ }
  else if (url === tab.hist[tab.idx - 1]) tab.idx--;
  else if (url === tab.hist[tab.idx + 1]) tab.idx++;
  else { tab.hist = tab.hist.slice(0, tab.idx + 1); tab.hist.push(url); tab.idx++; }
  tab.url = url;
  addVisit(url);
  render();
}

function addVisit(url, title) {
  if (!/^https?:/.test(url)) return;
  const top = visits[0];
  if (top && top.u === url) { if (title) top.t = title; }
  else visits.unshift({ u: url, t: title || host(url), ts: Date.now() });
  visits = visits.slice(0, 300);
  write('visits', visits);
}

window.addEventListener('message', ev => {
  if (ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || !d.__prox) return;
  const tab = tabs.find(t => t.el.contentWindow === ev.source);
  if (!tab) return;
  if (d.type === 'nav' && typeof d.url === 'string') onNav(tab, d.url);
  else if (d.type === 'title') { tab.title = d.title || host(tab.url); addVisit(tab.url, d.title); render(); }
  else if (d.type === 'open' && typeof d.url === 'string') newTab(d.url);
});

/* ---------- render ---------- */
function render() {
  const tab = cur(); if (!tab) return;
  $('#tabs').innerHTML = tabs.map(t => {
    const h = host(t.url);
    return `<div class="tab${t.id === activeId ? ' active' : ''}" data-id="${t.id}">
      <span class="fav" style="--h:${hue(h || 'new')}">${t.loading ? '<i class="spin"></i>' : esc((h || '+')[0].toUpperCase())}</span>
      <span class="ttl">${esc(t.title)}</span>
      <button class="x" data-close="${t.id}" title="Close tab">×</button></div>`;
  }).join('');
  tabs.forEach(t => t.el.classList.toggle('show', t.id === activeId && !!t.url));
  $('#home').classList.toggle('show', !tab.url);
  if (document.activeElement !== $('#url')) $('#url').value = tab.url;
  $('#back').disabled = tab.idx <= 0;
  $('#fwd').disabled = tab.idx >= tab.hist.length - 1;
  $('#progress').classList.toggle('on', tab.loading);
  $('#star').classList.toggle('on', bookmarks.some(b => b.u === tab.url));
  $('#bookmarks').innerHTML = bookmarks.map((b, i) => `<button class="bm" data-bm="${i}" title="${esc(b.u)}">${esc(b.t)}</button>`).join('');
  document.title = (tab.url ? tab.title + ' - ' : '') + 'Nimbus';
}

/* ---------- drawer ---------- */
function openDrawer(view) { drawerView = view; $('#drawer').hidden = false; renderDrawer(); }
function renderDrawer() {
  document.querySelectorAll('#drawer nav button').forEach(b => b.classList.toggle('on', b.dataset.view === drawerView));
  const body = $('#drawer-body');
  if (drawerView === 'history') {
    body.innerHTML = (visits.length ? `<button class="btn danger" data-act="clear-history">Clear history</button>` : '<p class="muted">Nothing yet.</p>') +
      visits.slice(0, 150).map(v => `<div class="item"><button class="open" data-open="${esc(v.u)}"><b>${esc(v.t)}</b><small>${esc(v.u)}</small></button></div>`).join('');
  } else if (drawerView === 'bookmarks') {
    body.innerHTML = bookmarks.length ? bookmarks.map((b, i) => `<div class="item"><button class="open" data-open="${esc(b.u)}"><b>${esc(b.t)}</b><small>${esc(b.u)}</small></button><button class="x" data-act="rm-bm" data-i="${i}">×</button></div>`).join('') : '<p class="muted">No bookmarks. Use the star in the address bar.</p>';
  } else {
    const eng = read('engine', 'ddg');
    body.innerHTML = `${relay ? '' : '<div class="notice">Set your Cloudflare Worker URL below. Nothing loads without it.</div>'}
      <label class="field">Relay URL (Cloudflare Worker)</label>
      <input id="s-relay" class="inp" placeholder="https://nimbus-relay.yourname.workers.dev" value="${esc(relay)}">
      <button class="btn" data-act="test">Test relay</button>
      <label class="field">Search engine</label>
      <select id="s-engine" class="inp">${Object.entries(ENGINES).map(([k, v]) => `<option value="${k}"${k === eng ? ' selected' : ''}>${v.name}</option>`).join('')}</select>
      <div><button class="btn primary" data-act="save">Save</button><button class="btn danger" data-act="wipe">Clear all browser data</button></div>`;
  }
}

$('#drawer').addEventListener('click', async e => {
  const b = e.target.closest('[data-view],[data-open],[data-act]'); if (!b) return;
  if (b.dataset.view) return openDrawer(b.dataset.view);
  if (b.dataset.open) { go(cur(), b.dataset.open); $('#drawer').hidden = true; return; }
  const act = b.dataset.act;
  if (act === 'clear-history') { visits = []; write('visits', visits); renderDrawer(); }
  else if (act === 'rm-bm') { bookmarks.splice(+b.dataset.i, 1); write('bookmarks', bookmarks); renderDrawer(); render(); }
  else if (act === 'test') {
    const r = ($('#s-relay').value || '').trim().replace(/\/+$/, '');
    try { const res = await fetch(r + '/?ping'); toast((await res.text()) === 'ok' ? 'Relay reachable.' : 'Reached a server, but it is not the relay (check ALLOWED_ORIGIN / code).'); }
    catch { toast('Relay not reachable. Check URL, deployment, and ALLOWED_ORIGIN.'); }
  } else if (act === 'save') {
    write('engine', $('#s-engine').value);
    const r = ($('#s-relay').value || '').trim().replace(/\/+$/, '');
    if (r !== relay) { localStorage.setItem('relay', r); location.reload(); }
    else toast('Saved.');
  } else if (act === 'wipe') {
    if (confirm('Delete history, bookmarks, settings and unregister the service worker?')) {
      localStorage.clear();
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      location.reload();
    }
  }
});
$('#drawer-close').onclick = () => { $('#drawer').hidden = true; };
$('#menu').onclick = () => { $('#drawer').hidden ? openDrawer(drawerView) : ($('#drawer').hidden = true); };

/* ---------- wiring ---------- */
$('#tabs').addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) return closeTab(+c.dataset.close);
  const t = e.target.closest('.tab'); if (t) { activeId = +t.dataset.id; render(); }
});
$('#newtab-btn').onclick = () => newTab('');
$('#back').onclick = () => { const t = cur(); if (t.idx > 0) t.el.contentWindow.history.back(); };
$('#fwd').onclick = () => { const t = cur(); if (t.idx < t.hist.length - 1) t.el.contentWindow.history.forward(); };
$('#reload').onclick = () => { const t = cur(); if (!t.url) return; t.loading = true; t.expect = true; render(); try { t.el.contentWindow.location.reload(); } catch { t.el.src = toProxy(t.url); } };
$('#home-btn').onclick = () => { const t = cur(); t.url = ''; t.title = 'New Tab'; t.hist = []; t.idx = -1; t.loading = false; t.el.removeAttribute('src'); render(); $('#home-q').focus(); };
$('#omni').addEventListener('submit', e => { e.preventDefault(); go(cur(), $('#url').value); $('#url').blur(); });
$('#url').addEventListener('focus', () => $('#url').select());
$('#home-form').addEventListener('submit', e => { e.preventDefault(); go(cur(), $('#home-q').value); $('#home-q').value = ''; });
$('#star').onclick = () => {
  const t = cur(); if (!t.url) return;
  const i = bookmarks.findIndex(b => b.u === t.url);
  if (i >= 0) bookmarks.splice(i, 1); else bookmarks.push({ u: t.url, t: t.title || host(t.url) });
  write('bookmarks', bookmarks); render();
};
$('#bookmarks').addEventListener('click', e => { const b = e.target.closest('[data-bm]'); if (b) go(cur(), bookmarks[+b.dataset.bm].u); });
$('#tiles').innerHTML = LINKS.map(l => `<button class="tile" data-u="${esc(l.u)}"><span class="fav" style="--h:${hue(host(l.u))}">${esc(l.t[0])}</span><span>${esc(l.t)}</span></button>`).join('');
$('#tiles').addEventListener('click', e => { const b = e.target.closest('[data-u]'); if (b) go(cur(), b.dataset.u); });

document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'l') { e.preventDefault(); $('#url').focus(); }
  else if (e.altKey && k === 't') { e.preventDefault(); newTab(''); }
  else if (e.altKey && k === 'w') { e.preventDefault(); closeTab(activeId); }
  else if (e.altKey && k === 'r') { e.preventDefault(); $('#reload').click(); }
  else if (e.altKey && k === 'l') { e.preventDefault(); $('#url').focus(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); $('#back').click(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); $('#fwd').click(); }
});

/* ---------- boot ---------- */
function activated(reg) {
  return new Promise(res => {
    const w = reg.installing || reg.waiting || reg.active;
    if (!w || w.state === 'activated') return res();
    w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
  });
}

(async function boot() {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  newTab('', true);
  if (!relay) { openDrawer('settings'); return; }
  if (!('serviceWorker' in navigator)) { toast('Service workers need HTTPS (GitHub Pages) or localhost.'); return; }
  try {
    const reg = await navigator.serviceWorker.register('sw.js?relay=' + encodeURIComponent(relay), { scope: './' });
    await activated(reg);
    PFX = new URL('./~/', reg.scope).href;
    const start = new URLSearchParams(location.search).get('go');
    if (start) go(cur(), start);
  } catch (err) {
    toast('Service worker failed: ' + err.message);
  }
})();
