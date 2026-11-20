// Service Worker: every request made by a proxied page is routed to the relay.
// The relay URL is passed in the registration query string (sw.js?relay=...).
const RELAY = new URL(self.location.href).searchParams.get('relay') || '';
const PFX = self.registration.scope + '~/';           // e.g. https://user.github.io/repo/~/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// proxy URL -> real URL (handles ?query appended by GET form submissions)
function parse(url) {
  const rest = url.slice(PFX.length).split('#')[0];
  const i = rest.indexOf('?');
  let t = decodeURIComponent(i < 0 ? rest : rest.slice(0, i));
  if (i >= 0) t += (t.includes('?') ? '&' : '?') + rest.slice(i + 1);
  return t;
}

self.addEventListener('fetch', e => {
  if (!RELAY) return;
  e.respondWith(route(e));
});

async function route(e) {
  const req = e.request;
  let ctx = null;
  try { ctx = e.clientId ? await self.clients.get(e.clientId) : null; } catch {}
  const refUrl = (ctx && ctx.url) || (req.mode === 'navigate' ? req.referrer : '') || '';
  const fromProxied = refUrl.startsWith(PFX);

  if (req.url.startsWith(PFX)) {
    let t;
    try { t = parse(req.url); } catch { return new Response('Bad proxy URL', { status: 400 }); }
    if (/^https?:\/\//i.test(t)) return go(req, t);
    if (fromProxied) return go(req, new URL(t, parse(refUrl)).href);   // relative leftover
    return new Response('Bad proxy URL', { status: 400 });
  }

  if (fromProxied) {
    const u = new URL(req.url);
    if (u.origin === self.location.origin) {
      // root-relative request the page script built without our rewriting
      return go(req, new URL(u.pathname + u.search, parse(refUrl)).href);
    }
    return go(req, req.url);                                           // stray cross-origin request
  }

  return fetch(req);                                                   // the browser shell itself
}

async function go(req, target) {
  const api = new URL(RELAY);
  api.searchParams.set('url', target);
  api.searchParams.set('p', PFX);
  const init = { method: req.method, headers: {}, credentials: 'omit', redirect: 'follow' };
  const ct = req.headers.get('content-type');
  const ac = req.headers.get('accept');
  if (ct) init.headers['content-type'] = ct;
  if (ac) init.headers['accept'] = ac;
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
  try {
    const r = await fetch(api.href, init);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  } catch (err) {
    return new Response('Relay unreachable: ' + err, { status: 502, headers: { 'content-type': 'text/plain' } });
  }
}
