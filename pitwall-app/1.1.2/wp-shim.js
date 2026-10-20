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
})();
