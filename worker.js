// Cloudflare Worker: the relay. Fetches target sites, strips blocking headers,
// rewrites URLs so every sub-request comes back through your GitHub Pages origin.
//
// SET THIS to your GitHub Pages ORIGIN only (no repo path, no trailing slash):
const ALLOWED_ORIGIN = 'https://YOUR-USERNAME.github.io';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STRIP = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'set-cookie', 'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'report-to', 'nel', 'permissions-policy'];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const j = v => JSON.stringify(v).replace(/</g, '\\u003c');

function blocked(h) {
  h = h.toLowerCase();
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.workers.dev');
}

function fail(status, msg, cors) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;background:#0a0c11;color:#e9ecf5;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:480px;padding:24px"><h2>Couldn't load this page</h2><p style="color:#8a92a8">${esc(msg)}</p></div>`,
    { status, headers: { ...cors, 'content-type': 'text/html;charset=utf-8' } });
}

export default {
  async fetch(req) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'content-type, accept',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
      'Access-Control-Expose-Headers': 'x-final-url',
      'Vary': 'Origin',
    };
    if (req.headers.get('Origin') !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const u = new URL(req.url);
    if (u.searchParams.has('ping')) return new Response('ok', { headers: cors });

    const prefix = u.searchParams.get('p') || '';
    let t;
    try { t = new URL(u.searchParams.get('url')); } catch { return fail(400, 'Invalid URL.', cors); }
    if (!/^https?:$/.test(t.protocol) || blocked(t.hostname)) return fail(400, 'This target is not allowed.', cors);

    const h = new Headers({
      'user-agent': UA,
      'accept': req.headers.get('accept') || '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'referer': t.origin + '/',
    });
    const ct = req.headers.get('content-type');
    if (ct) h.set('content-type', ct);
    const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await req.arrayBuffer();

    let up;
    try { up = await fetch(t.href, { method: req.method, headers: h, body, redirect: 'follow' }); }
    catch (e) { return fail(502, 'Could not reach ' + t.hostname + ': ' + e.message, cors); }

    const finalUrl = up.url || t.href;
    const out = new Headers(up.headers);
    STRIP.forEach(k => out.delete(k));
    Object.entries(cors).forEach(([k, v]) => out.set(k, v));
    out.set('x-final-url', finalUrl);

    const type = (out.get('content-type') || '').toLowerCase();
    const ctx = { prefix, base: finalUrl };

    if (type.includes('text/html')) {
      out.delete('content-length'); out.delete('content-encoding');
      return rewriteHTML(new Response(up.body, { status: up.status, statusText: up.statusText, headers: out }), ctx);
    }
    if (type.includes('text/css')) {
      out.delete('content-length'); out.delete('content-encoding');
      return new Response(rewriteCSS(await up.text(), ctx), { status: up.status, headers: out });
    }
    return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
  },
};

function proxify(v, ctx) {
  const s = String(v).trim();
  if (!s || /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(s)) return v;
  try {
    const a = new URL(s, ctx.base);
    if (!/^https?:$/.test(a.protocol)) return v;
    const hash = a.hash; a.hash = '';
    return ctx.prefix + encodeURIComponent(a.href) + hash;
  } catch { return v; }
}

function rewriteCSS(css, ctx) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${proxify(u, ctx)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${proxify(u, ctx)}${q}`);
}

function rewriteHTML(res, ctx) {
  const real = ctx.base;
  const px = v => proxify(v, ctx);
  const attr = name => ({ element(e) { const v = e.getAttribute(name); if (v != null) e.setAttribute(name, px(v)); } });
  const inject = { element(e) { e.prepend(`<script>(${runtime.toString()})(${j(real)},${j(ctx.prefix)})</script>`, { html: true }); } };
  const srcset = { element(e) {
    const v = e.getAttribute('srcset'); if (!v) return;
    e.setAttribute('srcset', v.split(/,\s+/).map(p => { const [u, ...d] = p.trim().split(/\s+/); return [px(u), ...d].join(' '); }).join(', '));
  } };
  let styleBuf = '';

  return new HTMLRewriter()
    .on('html', inject)
    .on('head', inject)
    .on('base', { element(e) { const hr = e.getAttribute('href'); if (hr) { try { ctx.base = new URL(hr, ctx.base).href; } catch {} } e.remove(); } })
    .on('meta', { element(e) {
      const he = (e.getAttribute('http-equiv') || '').toLowerCase();
      if (he.includes('content-security-policy')) e.remove();
      else if (he === 'refresh') {
        const c = e.getAttribute('content') || '';
        e.setAttribute('content', c.replace(/(url\s*=\s*)(['"]?)([^'"]+)\2/i, (m, a, q, u) => a + q + px(u) + q));
      }
    } })
    .on('[href]', attr('href'))
    .on('[src]', attr('src'))
    .on('[action]', attr('action'))
    .on('[formaction]', attr('formaction'))
    .on('[poster]', attr('poster'))
    .on('object[data]', attr('data'))
    .on('[srcset]', srcset)
    .on('[integrity]', { element(e) { e.removeAttribute('integrity'); } })
    .on('[nonce]', { element(e) { e.removeAttribute('nonce'); } })
    .on('[style]', { element(e) { e.setAttribute('style', rewriteCSS(e.getAttribute('style') || '', ctx)); } })
    .on('style', { text(t) {
      styleBuf += t.text;
      if (t.lastInTextNode) { t.replace(rewriteCSS(styleBuf, ctx), { html: true }); styleBuf = ''; }
      else t.remove();
    } })
    .transform(res);
}

// Runs inside the proxied page (serialized via toString). Keep it self-contained, no outer references.
function runtime(REAL, PFX) {
  if (window.__prox) return;
  window.__prox = 1;
  var SKIP = /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
  var ORIGIN = location.origin;
  var cur = REAL;
  var framed = window.parent !== window && window.parent === window.top;

  function parseProx(u) {
    var rest = u.slice(PFX.length).split('#')[0];
    var i = rest.indexOf('?');
    var t = decodeURIComponent(i < 0 ? rest : rest.slice(0, i));
    if (i >= 0) t += (t.indexOf('?') < 0 ? '?' : '&') + rest.slice(i + 1);
    return t;
  }
  function abs(u) { try { return new URL(u, cur).href; } catch (e) { return u; } }
  function prox(u) {
    if (u == null) return u;
    var s = String(u).trim();
    if (!s || SKIP.test(s) || s.indexOf(PFX) === 0) return u;
    if (s.indexOf(ORIGIN + '/') === 0) s = s.slice(ORIGIN.length);
    var a; try { a = new URL(s, cur); } catch (e) { return u; }
    if (!/^https?:$/.test(a.protocol)) return u;
    var h = a.hash; a.hash = '';
    return PFX + encodeURIComponent(a.href) + h;
  }
  function real(u) {
    if (String(u).indexOf(PFX) === 0) { try { return parseProx(String(u)); } catch (e) {} }
    return abs(u);
  }
  function fromLoc() {
    var h = location.href;
    if (h.indexOf(PFX) !== 0) return cur;
    try { return parseProx(h) + location.hash; } catch (e) { return cur; }
  }
  function send(m) { if (!framed) return; m.__prox = 1; try { parent.postMessage(m, ORIGIN); } catch (e) {} }
  function nav() { send({ type: 'nav', url: cur }); }
  function title() { send({ type: 'title', title: document.title }); }

  nav();
  addEventListener('DOMContentLoaded', function () {
    title();
    try { new MutationObserver(title).observe(document.querySelector('title') || document.head || document.documentElement, { subtree: true, childList: true, characterData: true }); } catch (e) {}
  });
  addEventListener('load', title);
  addEventListener('popstate', function () { cur = fromLoc(); nav(); });
  addEventListener('hashchange', function () { cur = fromLoc(); nav(); });

  ['pushState', 'replaceState'].forEach(function (k) {
    var o = history[k];
    history[k] = function (s, t, u) {
      if (u != null) { cur = real(u); u = prox(u); }
      var r = o.call(this, s, t, u);
      nav();
      return r;
    };
  });

  var _fetch = window.fetch;
  window.fetch = function (i, o) {
    try { if (typeof i === 'string' || i instanceof URL) i = prox(i); } catch (e) {}
    return _fetch.call(this, i, o);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    var a = [].slice.call(arguments); a[1] = prox(u);
    return _open.apply(this, a);
  };

  var URL_ATTRS = ['src', 'href', 'action', 'poster', 'formaction'];
  var _sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (URL_ATTRS.indexOf(String(n).toLowerCase()) > -1) v = prox(v);
    return _sa.call(this, n, v);
  };
  [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLSourceElement, 'src'],
   [HTMLMediaElement, 'src'], [HTMLEmbedElement, 'src'], [HTMLLinkElement, 'href'], [HTMLAnchorElement, 'href'],
   [HTMLFormElement, 'action'], [HTMLVideoElement, 'poster']].forEach(function (p) {
    var d = Object.getOwnPropertyDescriptor(p[0].prototype, p[1]);
    if (!d || !d.set) return;
    Object.defineProperty(p[0].prototype, p[1], {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, prox(v)); }
    });
  });

  var _wopen = window.open;
  window.open = function (u) {
    if (framed && u) { send({ type: 'open', url: real(u) }); return null; }
    return _wopen.apply(window, arguments);
  };

  document.addEventListener('click', function (e) {
    if (!framed || e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var raw = a.getAttribute('href');
    if (!raw || SKIP.test(raw.trim())) return;
    var tgt = (a.getAttribute('target') || '').toLowerCase();
    if (tgt === '_blank' || e.ctrlKey || e.metaKey) { e.preventDefault(); send({ type: 'open', url: real(raw) }); }
  }, true);
}
