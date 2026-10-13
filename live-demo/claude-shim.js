/* Self-hosted bridge: gives the Pitwall web app the same window.claude.use()
   calls it uses on claude.ai, answered by this Raspberry Pi instead. */
(function () {
  'use strict';
  function api(path, body) {
    return fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 401) { location.href = 'login.html'; return new Promise(function () {}); }
        return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Request failed'); e.code = j.code || (r.status === 403 ? 'invalid_argument' : 'error'); throw e; } return j; });
      });
  }
  function dbOp(op, path, extra) { return api('/api/db', Object.assign({ op: op, path: path }, extra || {})); }

  /* live updates: one event stream, listeners keyed by collection path */
  var watchers = [], es = null;
  function parentOf(p) { var s = p.split('/'); s.pop(); return s.join('/'); }
  function ensureStream() {
    if (es) return;
    es = new EventSource('/api/events');
    es.onmessage = function (ev) {
      var p; try { p = JSON.parse(ev.data).path; } catch (e) { return; }
      var col = parentOf(p);
      watchers.forEach(function (w) { if (w.col === col) w.poke(); });
    };
    es.onerror = function () { /* the browser reconnects by itself */ };
    es.onopen = function () { watchers.forEach(function (w) { w.poke(); }); };
  }
  function snapDocs(list) { return { docs: list.map(function (d) { return { id: d.id, data: function () { return d.data; } }; }), size: list.length, empty: !list.length }; }

  function query(col, order, lim) {
    function apply(docs) {
      if (order) docs.sort(function (a, b) { var x = a.data[order.f], y = b.data[order.f]; var c = x < y ? -1 : x > y ? 1 : 0; return order.d === 'desc' ? -c : c; });
      return lim ? docs.slice(0, lim) : docs;
    }
    return {
      orderBy: function (f, d) { return query(col, { f: f, d: d || 'asc' }, lim); },
      limit: function (n) { return query(col, order, n); },
      get: function () { return dbOp('list', col).then(function (r) { return snapDocs(apply(r.docs)); }); },
      add: function (data) { return dbOp('add', col, { data: data }).then(function (r) { return { id: r.id }; }); },
      doc: function (id) { return docRef(col + '/' + id); },
      onSnapshot: function (cb, err) {
        var alive = true, timer = null;
        function load() { dbOp('list', col).then(function (r) { if (alive) cb(snapDocs(apply(r.docs))); }, function (e) { if (alive && err) err(e); }); }
        var w = { col: col, poke: function () { clearTimeout(timer); timer = setTimeout(load, 80); } };
        watchers.push(w); ensureStream(); load();
        return function () { alive = false; watchers = watchers.filter(function (x) { return x !== w; }); };
      }
    };
  }
  function docRef(path) {
    return {
      get: function () { return dbOp('get', path).then(function (r) { return { exists: r.exists, data: function () { return r.data; } }; }); },
      set: function (data) { return dbOp('set', path, { data: data }); },
      update: function (data) { return dbOp('update', path, { data: data }); },
      delete: function () { return dbOp('delete', path); },
      acquire: function (o) { return dbOp('acquire', path, { ttlMs: o && o.ttlMs }); },
      collection: function (c) { return query(path + '/' + c); }
    };
  }
  var db = { collection: function (p) { return query(p); }, doc: function (p) { return docRef(p); } };

  var meP = null, peopleP = null;
  function me() { return meP || (meP = api('/api/state').then(function (s) { if (!s.user) { location.href = 'login.html'; return new Promise(function () {}); } return s.user; })); }
  function people() { return peopleP || (peopleP = api('/api/users').then(function (r) { setTimeout(function () { peopleP = null; }, 30000); return r.users; })); }
  var user = {
    id: function () { return me().then(function (u) { return u.id; }); },
    me: function () { return me().then(function (u) { return { id: u.id, name: u.name, isMe: true }; }); },
    isOwner: function () { return me().then(function (u) { return u.role === 'admin'; }); },
    canEdit: function () { return me().then(function (u) { return u.role === 'admin' || u.role === 'editor'; }); },
    can: function () { return Promise.resolve(true); },
    profiles: function (ids) { return Promise.all([people(), me()]).then(function (r) { var out = {}; ids.forEach(function (id) { var p = r[0].filter(function (x) { return x.id === id; })[0]; if (p) out[id] = { id: id, name: p.name, isMe: id === r[1].id }; }); return out; }); },
    search: function (q) { q = String(q || '').toLowerCase(); return people().then(function (list) { return list.filter(function (p) { return !q || (p.name + ' ' + p.username).toLowerCase().indexOf(q) >= 0; }).slice(0, 10).map(function (p) { return { id: p.id, name: p.name, isMe: p.isMe }; }); }); }
  };
  var downloads = {
    save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: /\.csv$/i.test(o.filename) ? 'text/csv' : 'application/octet-stream' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename || 'download';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      return Promise.resolve();
    }
  };
  /* The Pi syncs MyGeotab itself; the page only asks it to. */
  var mcp = { selfHosted: true, callTool: function () { return Promise.reject({ code: 'capability_disabled', message: 'Sync runs from the Data page.' }); } };
  var caps = { db: db, user: user, downloads: downloads, mcp: mcp };
  window.claude = { use: function (name) { return Promise.resolve(caps[name] || null); } };
  window.pitwallApi = api;
})();
