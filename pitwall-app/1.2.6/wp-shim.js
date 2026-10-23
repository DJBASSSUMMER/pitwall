/* Pitwall on WordPress: small adapter that loads before the app.
   - Reads go out as POST (marked as reads), so no web cache ever keeps a copy.
   - Live updates: WordPress can't hold a connection open, so the page asks
     "what changed?" every few seconds, and right after you save something. */
(function () {
  'use strict';
  var BASE = '/pitwall/app/api/', realFetch = window.fetch.bind(window);
  var pollers = [];
  function isApi(url) { try { var u = new URL(url, location.href); return u.origin === location.origin && u.pathname.indexOf(BASE) === 0 ? u.pathname : null; } catch (e) { return null; } }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url, p = isApi(url);
    if (!p) return realFetch(input, init);
    init = Object.assign({ credentials: 'same-origin' }, init || {});
    var method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') { init.method = 'POST'; init.body = '{}'; init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {}, { 'X-Pitwall-Get': '1' }); }
    var writes = p === BASE + 'db' && init.body && !/"op"\s*:\s*"(list|get)"/.test(String(init.body));
    return realFetch(url, init).then(function (r) { if (writes || p.indexOf(BASE + 'geotab/') === 0 || p.indexOf(BASE + 'users') === 0) pollers.forEach(function (x) { x.soon(); }); return r; });
  };
  var RealES = window.EventSource;
  window.EventSource = function (url) {
    if (!isApi(url)) return new RealES(url);
    var s = { onmessage: null, onerror: null, onopen: null, readyState: 1 }, seq = 0, timer = null, busy = false, closed = false, again = false;
    function wait() { return document.hidden ? 30000 : 4000; }
    function schedule(ms) { clearTimeout(timer); if (!closed) timer = setTimeout(poll, ms); }
    function poll() {
      if (busy) { again = true; return; }
      busy = true;
      realFetch(BASE + 'changes', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: seq }) })
        .then(function (r) { if (r.status === 401) { location.href = '/pitwall/app/login'; return null; } return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          var first = !seq; seq = j.seq || seq;
          if (first) { if (s.onopen) s.onopen(); return; }
          (j.paths || []).forEach(function (path) { if (s.onmessage) s.onmessage({ data: JSON.stringify({ path: path }) }); });
        }, function () { if (s.onerror) s.onerror(); })
        .then(function () { busy = false; if (again) { again = false; schedule(300); } else schedule(wait()); });
    }
    s.soon = function () { schedule(400); };
    s.close = function () { closed = true; clearTimeout(timer); pollers = pollers.filter(function (x) { return x !== s; }); };
    pollers.push(s);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(200); });
    schedule(0);
    return s;
  };

  /* Resellers: the owner gets a "Resellers" link; while helping a reseller, a bar says
     whose Pitwall this is, with a way back. */
  function decorate(user) {
    if (!user || !user.owner) return;
    if (user.support && !document.getElementById('pwSupportBar')) {
      var bar = document.createElement('div');
      bar.id = 'pwSupportBar'; bar.setAttribute('role', 'status');
      bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:center;padding:8px 16px;background:#C2410C;color:#fff;font:600 14px/1.4 system-ui,-apple-system,sans-serif;position:relative;z-index:50';
      var t = document.createElement('span');
      t.textContent = 'Support view: you’re inside ' + (user.workspace ? user.workspace.name : 'a reseller') + '’s Pitwall as an admin.';
      var back = document.createElement('button');
      back.type = 'button'; back.textContent = 'Back to my workspace';
      back.style.cssText = 'font:inherit;min-height:32px;padding:0 12px;border-radius:8px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer';
      back.onclick = function () {
        back.disabled = true;
        realFetch(BASE + 'owner/support', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function () { location.href = '/pitwall/app/owner'; }, function () { back.disabled = false; });
      };
      var list = document.createElement('a');
      list.href = '/pitwall/app/owner'; list.textContent = 'All resellers'; list.style.color = '#fff';
      bar.appendChild(t); bar.appendChild(back); bar.appendChild(list);
      document.body.insertBefore(bar, document.body.firstChild);
    }
    if (location.pathname.indexOf('/pitwall/app/owner') === 0 || document.getElementById('pwOwnerLink')) return;
    var team = document.querySelector('a[data-r="team"]');
    var link = document.createElement('a');
    link.id = 'pwOwnerLink'; link.href = '/pitwall/app/owner'; link.textContent = 'Resellers';
    /* its own menu group, next to the app's menu (the app hides links it doesn't know) */
    if (team && team.parentNode) { var grp = document.createElement('div'); grp.className = 'nav'; grp.appendChild(link); team.parentNode.parentNode.insertBefore(grp, team.parentNode.nextSibling); }
    else {
      var backLink = document.querySelector('main:not([hidden]) p > a[href="/pitwall/app/"]');
      if (backLink) { link.style.marginLeft = '16px'; backLink.parentNode.appendChild(link); }
    }
  }
  function lookUp() {
    realFetch(BASE + 'state', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Pitwall-Get': '1' }, body: '{}' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s) { decorate(s.user); setTimeout(function () { decorate(s.user); }, 1500); } }, function () {});
  }
  /* Beta update popup: whatever the owner last published from the Resellers page.
     Shown once per browser, and only until it expires. */
  function notice() {
    realFetch(BASE + 'announcement', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Pitwall-Get': '1' }, body: '{}' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.announcement) showNotice(j.announcement); }, function () {});
  }
  function showNotice(a) {
    var NOTICE_ID = String(a.id);
    if (Date.now() > Date.parse(a.until)) return;
    try { if (localStorage.getItem('pwNotice') === NOTICE_ID) return; } catch (e) {}
    if (document.getElementById('pwNotice') || document.getElementById('pwUnsub')) return;
    var dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    var wrap = document.createElement('div');
    wrap.id = 'pwNotice';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.55)';
    var box = document.createElement('div');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'pwNoticeTitle');
    box.style.cssText = 'max-width:440px;width:100%;border-radius:14px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.3);font:15px/1.55 system-ui,-apple-system,sans-serif;'
      + (dark ? 'background:#0f172a;color:#e2e8f0;border:1px solid #334155' : 'background:#fff;color:#0f172a;border:1px solid #e2e8f0');
    box.innerHTML = '<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#C2410C">New update</p>'
      + '<h2 id="pwNoticeTitle" style="margin:0 0 10px;font-size:22px;line-height:1.25"></h2>'
      + '<ul style="margin:0 0 18px;padding-left:20px"></ul>';
    box.querySelector('h2').textContent = a.title;
    (a.items || []).forEach(function (t) { var li = document.createElement('li'); li.textContent = t; box.querySelector('ul').appendChild(li); });
    var ok = document.createElement('button');
    ok.type = 'button'; ok.textContent = 'Got it';
    ok.style.cssText = 'font:600 15px system-ui,-apple-system,sans-serif;min-height:40px;padding:0 18px;border-radius:10px;border:0;background:#C2410C;color:#fff;cursor:pointer';
    function close() { try { localStorage.setItem('pwNotice', NOTICE_ID); } catch (e) {} wrap.remove(); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') close(); }
    ok.onclick = close;
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', esc);
    box.appendChild(ok); wrap.appendChild(box); document.body.appendChild(wrap); ok.focus();
  }
  /* "Stop update emails" link: /pitwall/app/login?unsub=<id>.<token> */
  function unsub() {
    var m = /[?&]unsub=([^&]+)/.exec(location.search); if (!m) return false;
    var v = decodeURIComponent(m[1]), dot = v.lastIndexOf('.');
    var bar = document.createElement('div'); bar.id = 'pwUnsub'; bar.setAttribute('role', 'status');
    bar.style.cssText = 'padding:12px 16px;text-align:center;font:600 15px/1.4 system-ui,-apple-system,sans-serif;background:#0f172a;color:#fff';
    bar.textContent = 'Updating your email preferences…';
    document.body.insertBefore(bar, document.body.firstChild);
    realFetch(BASE + 'unsubscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: v.slice(0, dot), t: v.slice(dot + 1) }) })
      .then(function (r) { bar.textContent = r.ok ? 'You won’t get Pitwall update emails anymore. Your login still works as usual.' : 'That unsubscribe link isn’t valid. Ask your Pitwall admin to remove you from update emails.'; },
        function () { bar.textContent = 'Couldn’t reach Pitwall. Try the link again in a minute.'; });
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    return true;
  }
  function start() { if (!unsub()) notice(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  if (location.pathname.indexOf('/pitwall/app/login') !== 0) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', lookUp); else lookUp();
  }
})();
