/* Pitwall demo: a pretend Pitwall server that runs inside the browser.
   It answers the same /api/ calls as the real Raspberry Pi server, keeps
   everything in this browser (localStorage), and starts with sample fleets.
   Nothing is sent anywhere. */
(function () {
  'use strict';
  var KEY = 'pitwall-demo-v4', H = 3600e3, D = 24 * H;
  var realFetch = window.fetch.bind(window);
  var bc = 'BroadcastChannel' in window ? new BroadcastChannel('pitwall-demo') : null;
  var state = null, streams = [];

  function now() { return Date.now(); }
  function iso(ms) { return new Date(ms).toISOString(); }
  function load() {
    try { state = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { state = null; }
    if (!state || !state.docs || state.v !== 4) { state = seed(); save(); }
    rebase();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked: keep working in memory */ } }
  function changed(p) {
    save();
    var msg = { data: JSON.stringify({ path: p }) };
    streams.forEach(function (s) { if (s.onmessage) setTimeout(function () { s.onmessage(msg); }, 0); });
    if (bc) bc.postMessage({ path: p });
  }
  if (bc) bc.onmessage = function (ev) {
    try { state = JSON.parse(localStorage.getItem(KEY)); } catch (e) { return; }
    var msg = { data: JSON.stringify({ path: ev.data.path }) };
    streams.forEach(function (s) { if (s.onmessage) s.onmessage(msg); });
  };

  /* Keep the sample fleets "live": device times move forward with the clock. */
  function rebase() {
    var delta = now() - (state.syncedAt || now());
    if (delta < 60e3) return;
    Object.keys(state.docs).forEach(function (k) {
      if (k.indexOf('devices/') !== 0) return;
      (state.docs[k].data.devices || []).forEach(function (d) {
        ['lastCommAt', 'activatedAt', 'lastTripAt'].forEach(function (f) { if (d[f]) d[f] = iso(Date.parse(d[f]) + delta); });
      });
    });
    var g = state.docs['settings/geotab'];
    if (g) (g.data.databases || []).forEach(function (e) { if (e.last && e.last.at) e.last.at = iso(now() - 6 * 60e3); });
    if (state.docs['settings/meta']) state.docs['settings/meta'].data.asOf = iso(now());
    state.syncedAt = now(); save();
  }

  /* ---------- sample data ---------- */
  function seed() {
    var t = now(), docs = {}, put = function (p, d) { docs[p] = { data: d }; };
    var users = [
      { id: 'u_demo_admin', username: 'admin', name: 'Alex Rivera', role: 'admin', password: 'demo' },
      { id: 'u_demo_editor', username: 'editor', name: 'Erin Park', role: 'editor', password: 'demo' },
      { id: 'u_demo_staff', username: 'staff', name: 'Sam Ortiz', role: 'staff', password: 'demo' },
      { id: 'u_demo_fleet', username: 'fleet', name: 'Dana Brooks', role: 'customer', customerId: 'coastal-plumbing', password: 'demo' }
    ];
    var customers = [
      { id: 'coastal-plumbing', name: 'Coastal Plumbing Co', database: 'coastal_plumbing', lastAdminLoginAt: iso(t - 2 * D), renewalAt: iso(t + 210 * D), make: ['Van', 'Service Truck'], n: 40 },
      { id: 'valley-transit', name: 'Valley Transit', database: 'valley_transit', lastAdminLoginAt: iso(t - 45 * D), renewalAt: iso(t + 60 * D), make: ['Bus'], n: 34 },
      { id: 'summit-landscaping', name: 'Summit Landscaping', database: 'summit_land', lastAdminLoginAt: iso(t - 6 * D), renewalAt: iso(t + 300 * D), make: ['Crew Truck', 'Mower Trailer'], n: 24 },
      { id: 'bayline-movers', name: 'Bayline Movers', database: 'bayline_movers', lastAdminLoginAt: iso(t - 11 * D), renewalAt: iso(t + 120 * D), make: ['Box Truck', 'Tractor'], n: 18 }
    ];
    var serialN = 4100, dbs = [];
    customers.forEach(function (c, ci) {
      var list = [];
      for (var i = 1; i <= c.n; i++) {
        var type = c.make[i % c.make.length], last = t - (5 + ((i * 37) % 300)) * 60e3;
        list.push({ serial: 'G9D' + (serialN++), customerId: c.id, vehicle: type + ' ' + (100 * (ci + 1) + i), lastCommAt: iso(last), lastSignal: 'normal',
          activatedAt: iso(t - (200 + i * 3) * D), lastTripAt: iso(last - 20 * 60e3), archived: false, milesToService: 400 + ((i * 731) % 4600), source: 'mygeotab', database: c.database });
      }
      function set(i, o) { Object.assign(list[i], o); }
      if (c.id === 'coastal-plumbing') {
        for (var b = 0; b < 5; b++) set(3 + b * 4, { lastCommAt: iso(t - 61 * H - b * 25 * 60e3), lastSignal: 'power_removed' });
        set(30, { lastCommAt: iso(t - 4 * D), lastSignal: 'low_voltage' });
        set(12, { milesToService: -420 });
        /* two CNG service trucks: one went quiet after its battery switch was turned off */
        set(26, { isCng: true, lastCommAt: iso(t - 30 * H), lastTripAt: iso(t - 30 * H - 6 * 60e3), lastSignal: 'battery_disconnect', disconnects14: 1, routine: false });
        set(34, { isCng: true, disconnects14: 0, routine: false });
      }
      if (c.id === 'valley-transit') {
        /* the whole bus fleet runs on CNG; most drivers turn the battery switch off at the depot each night */
        list.forEach(function (d, k) { d.isCng = true; d.disconnects14 = 8 + (k * 7) % 5; d.routine = true; });
        set(6, { lastCommAt: iso(t - 5 * D), lastTripAt: iso(t - 5 * D - 4 * 60e3), lastSignal: 'battery_disconnect', disconnects14: 9 });
        set(14, { lastCommAt: iso(t - 38 * H), lastTripAt: iso(t - 38 * H - 5 * 60e3), lastSignal: 'battery_disconnect', disconnects14: 11 });
        set(27, { lastCommAt: iso(t - 54 * H), lastTripAt: iso(t - 54 * H - 3 * 60e3), lastSignal: 'battery_disconnect', disconnects14: 0, routine: false });
        set(11, { lastCommAt: iso(t - 50 * H), lastSignal: 'ignition_no_gps' });
        set(19, { lastCommAt: iso(t - 30 * H), lastSignal: 'ignition_no_gps' });
        set(25, { lastCommAt: iso(t - 3 * D), lastSignal: '' });
        set(4, { milesToService: -1200 }); set(8, { milesToService: -150 });
      }
      if (c.id === 'summit-landscaping') {
        [2, 9, 16].forEach(function (k, j) { set(k, { lastCommAt: iso(t - (28 + j * 9) * D), lastSignal: 'normal_shutdown' }); });
        set(22, { lastCommAt: null, lastSignal: '', activatedAt: iso(t - 20 * D), lastTripAt: null });
      }
      if (c.id === 'bayline-movers') {
        set(6, { lastCommAt: iso(t - 5 * D), lastSignal: 'power_removed' });
        set(13, { lastCommAt: iso(t - 2 * D), lastSignal: 'low_voltage' });
        set(2, { milesToService: -800 }); set(9, { milesToService: -60 }); set(15, { milesToService: -2100 });
      }
      put('devices/' + c.id + '--1', { customerId: c.id, chunk: 1, devices: list });
      put('customers/' + c.id, { id: c.id, name: c.name, database: c.database, lastAdminLoginAt: c.lastAdminLoginAt, renewalAt: c.renewalAt });
      var silent = list.filter(function (d) { return !d.lastCommAt || t - Date.parse(d.lastCommAt) >= D || (!d.lastTripAt && t - Date.parse(d.activatedAt) > 7 * D); }).length;
      dbs.push({ database: c.database, customer: c.name, userName: 'pitwall@' + c.id.replace(/-/g, '') + '.com', server: 'my.geotab.com', addedAt: iso(t - 30 * D), last: { at: iso(t - 6 * 60e3), devices: list.length, silent: silent, error: null } });
    });
    put('settings/meta', { asOf: iso(t), source: 'mygeotab', syncedAt: iso(t) });
    put('settings/geotab', { databases: dbs });
    function dev(cid, idxs) { var l = docs['devices/' + cid + '--1'].data.devices; return idxs.map(function (i) { return l[i].serial; }); }
    function veh(cid, idxs) { var l = docs['devices/' + cid + '--1'].data.devices; return idxs.map(function (i) { return l[i].vehicle; }); }
    var tickets = [
      { id: 't1001', number: 1001, subject: 'Five vans stopped reporting overnight', customerId: 'coastal-plumbing', category: 'Device issue', priority: 'High', status: 'open', assignee: 'u_demo_admin', contact: 'Dana (fleet manager), 555-0142',
        serials: dev('coastal-plumbing', [3, 7, 11, 15, 19]), vehicles: veh('coastal-plumbing', [3, 7, 11, 15, 19]), source: 'brief', createdAt: iso(t - 20 * H), firstResponseAt: iso(t - 19 * H),
        msgs: [{ kind: 'request', from: 'Dana (fleet manager)', body: 'Five of our vans stopped showing on the map last night. Did something break?', at: t - 20 * H },
               { kind: 'reply', by: 'u_demo_admin', body: 'They all lost power within two hours of each other, which usually means shop work. Were they in for service last night?', at: t - 19 * H },
               { kind: 'note', by: 'u_demo_admin', body: 'Pitwall flags this as a batch. Likely the body shop pulled the harnesses.', at: t - 19 * H + 60e3 }] },
      { id: 't1002', number: 1002, subject: 'Bus 112 not showing its location', customerId: 'valley-transit', category: 'Device issue', priority: 'Normal', status: 'waiting', assignee: 'u_demo_staff', contact: 'Transit dispatch',
        serials: dev('valley-transit', [11]), vehicles: veh('valley-transit', [11]), source: 'device', createdAt: iso(t - 30 * H), firstResponseAt: iso(t - 28 * H),
        msgs: [{ kind: 'request', from: 'Transit dispatch', body: 'Bus 112 runs every day but the map shows it parked at the depot.', at: t - 30 * H },
               { kind: 'reply', by: 'u_demo_staff', body: 'The tracker sees the ignition but gets no GPS fix. Can you send a photo of where the device is mounted?', at: t - 28 * H }] },
      { id: 't1003', number: 1003, subject: 'Add two new crew leads as drivers', customerId: 'summit-landscaping', category: 'Account access', priority: 'Low', status: 'new', assignee: null, contact: 'office@summit (sample)',
        serials: [], vehicles: [], source: 'brief', createdAt: iso(t - 27 * H), firstResponseAt: null,
        msgs: [{ kind: 'request', from: 'Summit office', body: 'Please add Jordan and Casey as drivers so they can use the app.', at: t - 27 * H }] },
      { id: 't1004', number: 1004, subject: 'Install tracker in new box truck', customerId: 'bayline-movers', category: 'Installation', priority: 'Normal', status: 'resolved', assignee: 'u_demo_editor', contact: 'Bayline ops',
        serials: [], vehicles: [], source: 'staff', createdAt: iso(t - 9 * D), firstResponseAt: iso(t - 9 * D + 2 * H), resolvedAt: iso(t - 6 * D),
        msgs: [{ kind: 'request', from: 'Bayline ops', body: 'New truck arriving Monday, need a tracker installed.', at: t - 9 * D },
               { kind: 'reply', by: 'u_demo_editor', body: 'Installer booked for Tuesday 9am.', at: t - 9 * D + 2 * H }] }
    ];
    tickets.forEach(function (tk) {
      var msgs = tk.msgs; delete tk.msgs;
      tk.updatedAt = iso(msgs[msgs.length - 1].at); tk.createdBy = 'u_demo_admin';
      put('tickets/' + tk.id, tk);
      put('tickets/' + tk.id + '/messages/m0', { kind: 'event', event: 'created', by: 'u_demo_admin', at: tk.createdAt });
      msgs.forEach(function (m, i) { put('tickets/' + tk.id + '/messages/m' + (i + 1), { kind: m.kind, from: m.from || '', body: m.body, by: m.by || 'u_demo_admin', at: iso(m.at) }); });
    });
    put('counters/tickets', { next: 1005 });
    return { v: 4, docs: docs, users: users, syncedAt: t, backups: [iso(t - 2 * H).slice(0, 10)] };
  }

  /* ---------- the pretend server ---------- */
  function me() { var id = sessionStorage.getItem('pitwall-demo-user'); return state.users.filter(function (u) { return u.id === id; })[0] || null; }
  var canEdit = function (u) { return u && (u.role === 'admin' || u.role === 'editor'); };
  var ADMIN_PATHS = /^(settings|devices|customers)(\/|$)/;
  function valid(p, even) { if (typeof p !== 'string' || !p) return false; var s = p.split('/'); if (s.some(function (x) { return !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(x); })) return false; return even ? s.length % 2 === 0 : s.length % 2 === 1; }
  function list(col) { var pre = col + '/', out = []; Object.keys(state.docs).forEach(function (k) { if (k.indexOf(pre) === 0 && k.indexOf('/', pre.length) < 0) out.push({ id: k.slice(pre.length), data: state.docs[k].data }); }); return out; }
  function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }
  function setDoc(p, d) { state.docs[p] = { data: clone(d) }; changed(p); }
  var locks = {};
  function slug(v) { return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

  function fakeFleet(cid, db, name) {
    var t = now(), list = [], types = ['Truck', 'Van', 'Pickup'];
    for (var i = 1; i <= 12; i++) { var last = t - (10 + i * 13) * 60e3; list.push({ serial: 'G9N' + Math.floor(1000 + Math.random() * 8999), customerId: cid, vehicle: types[i % 3] + ' ' + i, lastCommAt: iso(last), lastSignal: 'normal', activatedAt: iso(t - 150 * D), lastTripAt: iso(last - 15 * 60e3), archived: false, milesToService: 300 + i * 250, source: 'mygeotab', database: db }); }
    Object.assign(list[4], { lastCommAt: iso(t - 70 * H), lastSignal: 'power_removed' });
    Object.assign(list[9], { lastCommAt: iso(t - 36 * H), lastSignal: 'ignition_no_gps' });
    Object.assign(list[7], { vehicle: 'CNG Truck 8', isCng: true, lastCommAt: iso(t - 28 * H), lastTripAt: iso(t - 28 * H - 5 * 60e3), lastSignal: 'battery_disconnect', disconnects14: 1, routine: false });
    return list;
  }

  var routes = {
    'GET /api/state': function () { return [200, { setupNeeded: false, demo: true, user: me() ? strip(me()) : null }]; },
    'POST /api/login': function (b) {
      var u = state.users.filter(function (x) { return x.username === String(b.username || '').trim().toLowerCase(); })[0];
      if (!u || u.password !== b.password) return [401, { error: 'That username and password don’t match. Demo accounts use the password “demo”.' }];
      sessionStorage.setItem('pitwall-demo-user', u.id); return [200, { ok: true }];
    },
    'POST /api/logout': function () { sessionStorage.removeItem('pitwall-demo-user'); return [200, { ok: true }]; },
    'POST /api/demo/reset': function () { localStorage.removeItem(KEY); state = seed(); save(); return [200, { ok: true }]; }
  };
  var authed = {
    'GET /api/users': function (b, u) {
      if (u.role === 'customer') return [200, { users: state.users.filter(function (x) { return x.role !== 'customer' || x.id === u.id; }).map(function (x) { return { id: x.id, name: x.name, isMe: x.id === u.id }; }) }];
      return [200, { users: state.users.map(function (x) { return { id: x.id, name: x.name, username: x.username, role: x.role, customerId: x.customerId || null, isMe: x.id === u.id }; }) }];
    },
    'POST /api/users': function (b, u) {
      if (u.role !== 'admin') return [403, { error: 'Only admins can add people.' }];
      var un = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._@-]{2,64}$/.test(un) || !b.password || String(b.password).length < 8) return [400, { error: 'Use a username of letters and numbers and a password of at least 8 characters.' }];
      if (state.users.some(function (x) { return x.username === un; })) return [409, { error: 'That username is taken.' }];
      var role = ['admin', 'editor', 'staff', 'customer'].indexOf(b.role) >= 0 ? b.role : 'staff';
      if (role === 'customer' && !state.docs['customers/' + b.customerId]) return [400, { error: 'Choose which customer this fleet manager belongs to.' }];
      state.users.push({ id: 'u_' + Math.random().toString(36).slice(2, 12), username: un, name: String(b.name || un).trim(), role: role, customerId: role === 'customer' ? String(b.customerId) : undefined, password: String(b.password) });
      save(); return [200, { ok: true }];
    },
    'POST /api/users/password': function (b, u) {
      var tgt = b.id ? state.users.filter(function (x) { return x.id === b.id; })[0] : u;
      if (!tgt || (tgt.id !== u.id && u.role !== 'admin')) return [403, { error: 'Not allowed.' }];
      if (!b.password || String(b.password).length < 8) return [400, { error: 'Use at least 8 characters.' }];
      if (/^u_demo_/.test(tgt.id)) return [400, { error: 'The built-in demo accounts keep the password “demo”. Add a new person to try this.' }];
      tgt.password = String(b.password); save(); return [200, { ok: true }];
    },
    'POST /api/users/remove': function (b, u) {
      if (u.role !== 'admin') return [403, { error: 'Only admins can remove people.' }];
      if (b.id === u.id) return [400, { error: 'You can’t remove yourself.' }];
      if (/^u_demo_/.test(b.id)) return [400, { error: 'The built-in demo accounts can’t be removed. Add a new person to try this.' }];
      state.users = state.users.filter(function (x) { return x.id !== b.id; }); save(); return [200, { ok: true }];
    },
    'POST /api/db': function (b, u) {
      var op = b.op, p = b.path;
      if (op === 'list') return valid(p, false) ? [200, { docs: list(p).filter(function (x) { return scopeDoc(u, p + '/' + x.id, x.data); }) }] : [400, { error: 'bad path' }];
      if (!valid(p, op !== 'add')) return [400, { error: 'bad path' }];
      if (op === 'get') { var d = state.docs[p], vis = d && scopeDoc(u, p, d.data); return [200, { exists: !!vis, data: vis ? d.data : null }]; }
      if (u.role === 'customer') return customerWrite(u, op, p, b);
      if (ADMIN_PATHS.test(p) && !canEdit(u)) return [403, { code: 'invalid_argument', error: 'Only admins and editors can change this.' }];
      if (op === 'set') { setDoc(p, b.data || {}); return [200, { ok: true }]; }
      if (op === 'update') { var m = Object.assign({}, state.docs[p] ? state.docs[p].data : {}, clone(b.data || {})); Object.keys(m).forEach(function (k) { if (m[k] && m[k].__delete__ === true) delete m[k]; }); setDoc(p, m); return [200, { ok: true }]; }
      if (op === 'delete') { if (state.docs[p]) { delete state.docs[p]; changed(p); } return [200, { ok: true }]; }
      if (op === 'add') { var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7); setDoc(p + '/' + id, b.data || {}); return [200, { id: id }]; }
      if (op === 'acquire') { var l = locks[p]; if (l && l.until > now() && l.holder !== u.id) return [200, { acquired: false }]; locks[p] = { holder: u.id, until: now() + 5000 }; return [200, { acquired: true }]; }
      return [400, { error: 'unknown op' }];
    },
    'POST /api/geotab/databases': function (b, u) {
      if (!canEdit(u)) return [403, { error: 'Only admins and editors can add databases.' }];
      var db = String(b.database || '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/[/?#].*$/, '');
      if (!db || !b.userName || !b.password) return [400, { error: 'Enter the database name, a MyGeotab username and its password.' }];
      var cfg = state.docs['settings/geotab'].data, cust = String(b.customer || db).trim(), cid = slug(cust);
      cfg.databases = (cfg.databases || []).filter(function (e) { return e.database !== db; }).concat([{ database: db, customer: cust, userName: String(b.userName).trim(), server: 'my.geotab.com', addedAt: iso(now()), addedBy: u.id, status: 'Syncing…' }]);
      setDoc('settings/geotab', cfg);
      setTimeout(function () {
        var fleet = fakeFleet(cid, db, cust);
        setDoc('devices/' + cid + '--1', { customerId: cid, chunk: 1, devices: fleet });
        setDoc('customers/' + cid, { id: cid, name: cust, database: db, lastAdminLoginAt: iso(now() - D), renewalAt: iso(now() + 365 * D) });
        var c2 = state.docs['settings/geotab'].data;
        c2.databases = c2.databases.map(function (e) { return e.database === db ? Object.assign({}, e, { status: '', last: { at: iso(now()), devices: fleet.length, silent: 2, error: null } }) : e; });
        setDoc('settings/geotab', c2);
      }, 1800);
      return [200, { ok: true, demo: true }];
    },
    'POST /api/geotab/remove': function (b, u) {
      if (!canEdit(u)) return [403, { error: 'Only admins and editors can remove databases.' }];
      var cfg = state.docs['settings/geotab'].data; cfg.databases = cfg.databases.filter(function (e) { return e.database !== b.database; }); setDoc('settings/geotab', cfg); return [200, { ok: true }];
    },
    'POST /api/geotab/sync': function (b, u) {
      if (!canEdit(u)) return [403, { error: 'Only admins and editors can sync.' }];
      var cfg = state.docs['settings/geotab'].data;
      cfg.databases = cfg.databases.map(function (e) { return !b.database || e.database === b.database ? Object.assign({}, e, { status: 'Syncing…' }) : e; });
      setDoc('settings/geotab', cfg);
      setTimeout(function () {
        var c2 = state.docs['settings/geotab'].data;
        c2.databases = c2.databases.map(function (e) { return e.status ? Object.assign({}, e, { status: '', last: Object.assign({}, e.last || {}, { at: iso(now()), error: null }) }) : e; });
        setDoc('settings/geotab', c2);
        var m = state.docs['settings/meta']; if (m) { m.data.asOf = iso(now()); changed('settings/meta'); }
      }, 1500);
      return [200, { ok: true, syncMinutes: 15 }];
    },
    'GET /api/geotab/info': function () { return [200, { syncMinutes: 15, syncing: false, demo: true }]; },
    'GET /api/backups': function (b, u) { if (u.role === 'customer') return [403, { error: 'Not allowed for this account.' }]; return [200, { local: { daily: 12, monthly: 3, latest: state.backups[state.backups.length - 1] }, drives: [], configured: 0 }]; },
    'POST /api/backups': function (b, u) { if (!canEdit(u)) return [403, { error: 'Only admins and editors can run a backup.' }]; state.backups.push(iso(now()).slice(0, 10)); save(); return [200, { local: { daily: 12, monthly: 3, latest: iso(now()).slice(0, 10) }, drives: [], configured: 0 }]; }
  };
  function strip(u) { return { id: u.id, name: u.name, username: u.username, role: u.role, customerId: u.customerId || null }; }

  /* Fleet-manager logins only see their own company: its vehicles and record,
     its tickets without internal notes, and nothing else. */
  function scopeDoc(u, p, data) {
    if (!u || u.role !== 'customer') return true;
    var cid = u.customerId, s = p.split('/');
    if (s[0] === 'devices') return !!data && data.customerId === cid;
    if (s[0] === 'customers') return s[1] === cid;
    if (s[0] === 'settings') return s[1] === 'meta';
    if (s[0] === 'counters') return s[1] === 'tickets';
    if (s[0] === 'tickets') {
      var t = state.docs['tickets/' + s[1]];
      if (!t || t.data.customerId !== cid) return false;
      if (s.length === 2) return true;
      return s[2] === 'messages' && !(data && data.kind === 'note');
    }
    return false;
  }
  function customerWrite(u, op, p, b) {
    var s = p.split('/'), cid = u.customerId, deny = [403, { code: 'invalid_argument', error: 'Not allowed for this account.' }], t = iso(now());
    if (p === 'counters/tickets') {
      if (op === 'acquire') return [200, { acquired: true }];
      if (op === 'update' && b.data && Number.isInteger(b.data.next)) { setDoc(p, { next: b.data.next }); return [200, { ok: true }]; }
      return deny;
    }
    if (s[0] === 'tickets' && s.length === 2 && op === 'set') {
      var d = b.data || {};
      if (state.docs[p] || d.customerId !== cid) return deny;
      setDoc(p, { number: +d.number || +s[1].slice(1), subject: String(d.subject || 'Help request').slice(0, 200), customerId: cid, category: 'Other', priority: 'Normal', status: 'new', assignee: null,
        contact: String(d.contact || u.name), serials: d.serials || [], vehicles: d.vehicles || [], source: d.source === 'brief' ? 'brief' : 'customer', briefKey: d.briefKey, briefPeriod: d.briefPeriod,
        createdBy: u.id, createdAt: t, updatedAt: t, firstResponseAt: null, resolvedAt: null });
      return [200, { ok: true }];
    }
    if (s[0] === 'tickets' && s.length === 3 && s[2] === 'messages' && op === 'add') {
      var tk = state.docs['tickets/' + s[1]], m = b.data || {}, id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      if (!tk || tk.data.customerId !== cid) return deny;
      if (m.kind === 'event' && m.event === 'created') { setDoc(p + '/' + id, { kind: 'event', event: 'created', by: u.id, at: t }); return [200, { id: id }]; }
      if (m.kind !== 'request') return deny;
      setDoc(p + '/' + id, { kind: 'request', body: String(m.body || ''), from: u.name, by: u.id, at: t });
      var nd = Object.assign({}, tk.data, { updatedAt: t }); if (nd.status === 'waiting' || nd.status === 'resolved') { nd.status = 'open'; nd.resolvedAt = null; }
      setDoc('tickets/' + s[1], nd);
      return [200, { id: id }];
    }
    return deny;
  }

  function handle(method, path, body) {
    var key = method + ' ' + path;
    if (routes[key]) return routes[key](body || {});
    if (authed[key]) { var u = me(); if (!u) return [401, { error: 'Sign in first.' }]; return authed[key](body || {}, u); }
    return [404, { error: 'Not found' }];
  }
  function apiPath(url) { try { var u = new URL(url, location.href); var i = u.pathname.indexOf('/api/'); return i >= 0 ? u.pathname.slice(i) : null; } catch (e) { return null; } }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url, p = apiPath(url);
    if (!p) return realFetch(input, init);
    init = init || {};
    var method = (init.method || 'GET').toUpperCase(), body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r = handle(method, p, body);
        resolve(new Response(JSON.stringify(r[1]), { status: r[0], headers: { 'Content-Type': 'application/json' } }));
      }, 60 + Math.random() * 90);
    });
  };
  var RealES = window.EventSource;
  window.EventSource = function (url) {
    if (!apiPath(url)) return new RealES(url);
    var s = { onmessage: null, onerror: null, onopen: null, close: function () { streams = streams.filter(function (x) { return x !== s; }); } };
    streams.push(s); setTimeout(function () { if (s.onopen) s.onopen(); }, 0);
    return s;
  };
  window.pitwallDemo = { reset: function () { return handle('POST', '/api/demo/reset', {}); } };
  load();
})();
