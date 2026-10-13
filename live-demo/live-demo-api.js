/* Pitwall Live trial: the Pitwall Live server, running inside this browser.
   Same API and the same rules as the Raspberry Pi version (roles, company
   walls, first-sign-in passwords), but everything is saved in this browser's
   storage only. It starts empty: no sample companies. MyGeotab is read live,
   straight from this browser; MyGeotab passwords are never saved, only the
   session key MyGeotab hands back. */
(function () {
  'use strict';
  var KEY = 'pitwall-live-trial-v1', SESS = 'pitwall-live-trial-session', SYNC_MINUTES = 15, H = 3600e3;
  var realFetch = window.fetch.bind(window);
  var bc = 'BroadcastChannel' in window ? new BroadcastChannel('pitwall-live-trial') : null;
  var state = null, streams = [], locks = {}, failed = {};
  if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) AbortSignal.timeout = function (ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; };

  /* ---- MyGeotab sync: the same code the Pi runs ---- */
  var PitwallGeotab = (function () {
/* Reads MyGeotab directly through its JSON-RPC API and turns each database's
   devices into Pitwall device rows. Read-only: only Authenticate and Get
   (batched with ExecuteMultiCall). */
const H = 3600e3, D = 24 * H;
const IDS = { unplugged: 'DiagnosticDeviceHasBeenUnpluggedId', voltage: 'DiagnosticGoDeviceVoltageId', ignition: 'DiagnosticIgnitionId', allPower: 'DiagnosticDeviceRestartedBecauseAllPowerWasRemovedId' };
const CNG_GROUP = 'GroupCompressedNaturalGasId', CNG_NAME = /\bcng\b|compressed natural gas/i;
const MAX_INSPECT = 300, CALLS_PER_BATCH = 100;

class GeotabError extends Error { constructor(msg, name) { super(msg); this.geotabName = name || ''; } }

async function rpc(host, method, params, fetchImpl) {
  const res = await (fetchImpl || fetch)('https://' + host + '/apiv1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new GeotabError('MyGeotab answered HTTP ' + res.status);
  const j = await res.json();
  if (j.error) {
    const e = (j.error.errors && j.error.errors[0]) || j.error;
    throw new GeotabError(e.message || j.error.message || 'MyGeotab error', e.name || j.error.name);
  }
  return j.result;
}

/* One authenticated session per database, re-used until MyGeotab rejects it. */
class Session {
  constructor(cred, fetchImpl) { this.cred = cred; this.fetch = fetchImpl; this.auth = null; }
  async login() {
    const server = this.cred.server || 'my.geotab.com';
    const r = await rpc(server, 'Authenticate', { database: this.cred.database, userName: this.cred.userName, password: this.cred.password }, this.fetch);
    this.auth = { credentials: r.credentials, host: !r.path || r.path === 'ThisServer' ? server : r.path };
  }
  async call(method, params) {
    if (!this.auth) await this.login();
    try { return await rpc(this.auth.host, method, Object.assign({}, params, { credentials: this.auth.credentials }), this.fetch); }
    catch (e) {
      if (/InvalidUser|DbUnavailable|session/i.test(e.geotabName + ' ' + e.message)) { await this.login(); return rpc(this.auth.host, method, Object.assign({}, params, { credentials: this.auth.credentials }), this.fetch); }
      throw e;
    }
  }
  get(typeName, search, resultsLimit) { return this.call('Get', { typeName, search, resultsLimit }); }
  async multi(calls) {
    let out = [];
    for (let i = 0; i < calls.length; i += CALLS_PER_BATCH) out = out.concat(await this.call('ExecuteMultiCall', { calls: calls.slice(i, i + CALLS_PER_BATCH).map(c => ({ method: 'Get', params: c })) }));
    return out;
  }
}

/* What the device reported just before it went quiet (same rules as the add-in). */
function deriveSignal(r) {
  const byTime = (a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime);
  const volts = (r.volts || []).slice().sort(byTime), ign = (r.ign || []).slice().sort(byTime);
  const logs = (r.logs || []).filter(l => l.latitude || l.longitude).sort(byTime);
  if ((r.faults || []).length) return 'power_removed';
  const lastIgn = ign.length ? ign[ign.length - 1] : null, ignOn = lastIgn ? +lastIgn.data === 1 : null;
  const lastV = volts.length ? +volts[volts.length - 1].data : null;
  const low = volts.filter(v => +v.data > 0 && +v.data < 11.5).length;
  if (lastV != null && lastV < 6 && ignOn !== true) return 'power_removed';
  if (volts.length >= 3 && low / volts.length >= 0.5) return 'low_voltage';
  if (ignOn === true) {
    const lastLog = logs.length ? Date.parse(logs[logs.length - 1].dateTime) : null;
    return lastLog == null || Date.parse(lastIgn.dateTime) - lastLog > 20 * 60e3 ? 'ignition_no_gps' : 'normal';
  }
  if (ignOn === false) return 'normal_shutdown';
  return '';
}

/* CNG battery switch: days in the last 14 when power came back and the
   ignition went on within 15 minutes (driver flips the switch, then starts up). */
function disconnectDays(restarts, ign) {
  const ons = (ign || []).filter(s => +s.data === 1).map(s => Date.parse(s.dateTime)), days = {};
  (restarts || []).forEach(f => { const t = Date.parse(f.dateTime); if (ons.some(o => o >= t && o - t <= 15 * 60e3)) days[new Date(t).toDateString()] = 1; });
  return Object.keys(days).length;
}
/* Shutdown, then silence within 20 minutes, with a healthy resting battery. */
function looksLikeSwitch(o) {
  if (!['power_removed', 'normal_shutdown', ''].includes(o.sig)) return false;
  const byTime = (a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime);
  const ign = (o.ign || []).slice().sort(byTime), volts = (o.volts || []).filter(v => +v.data >= 6).sort(byTime);
  const resting = volts.length ? +volts[volts.length - 1].data : null, last = Date.parse(o.lastCommAt), lastIgn = ign[ign.length - 1];
  if (resting != null && resting < 11.8) return false;
  if (lastIgn && +lastIgn.data === 0) return !isNaN(last) && last - Date.parse(lastIgn.dateTime) <= 20 * 60e3;
  return !lastIgn && o.routine && o.sig === 'power_removed';
}

function slug(v) { return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

async function syncDatabase(session, entry, onProgress) {
  const db = entry.database, cid = slug(entry.customer || db), now = new Date(), nowIso = now.toISOString(), asOf = now.getTime();
  onProgress && onProgress('Reading devices…');
  const [devices, statuses, cngGroupList] = await Promise.all([
    session.get('Device', { fromDate: nowIso }, 50000),
    session.get('DeviceStatusInfo', undefined, 50000),
    session.get('Group', { name: '%CNG%' }, 50).catch(() => [])
  ]);
  const cngGroups = { [CNG_GROUP]: 1 }; (cngGroupList || []).forEach(g => { if (g && g.name && CNG_NAME.test(g.name)) cngGroups[g.id] = 1; });
  const st = {}; (statuses || []).forEach(s => { if (s.device) st[s.device.id] = s; });
  const rows = (devices || []).map(d => { const s = st[d.id] || {}; return { id: d.id, serial: d.serialNumber || d.id, vehicle: d.name || d.serialNumber || d.id, activatedAt: d.activeFrom || null, lastCommAt: s.dateTime || null, isCng: (d.groups || []).some(g => g && cngGroups[g.id]) || CNG_NAME.test(d.name || '') }; });
  const silent = rows.filter(x => { const t = Date.parse(x.lastCommAt); return isNaN(t) || asOf - t >= D; })
    .sort((a, b) => (Date.parse(a.lastCommAt) || 0) - (Date.parse(b.lastCommAt) || 0));
  const inspect = silent.slice(0, MAX_INSPECT);
  if (inspect.length) {
    onProgress && onProgress('Checking ' + inspect.length + ' silent device' + (inspect.length === 1 ? '' : 's') + '…');
    const calls = [], from14 = new Date(asOf - 14 * D).toISOString();
    inspect.forEach(x => {
      x.at = calls.length;
      const t = Date.parse(x.lastCommAt), dev = { id: x.id };
      const to = isNaN(t) ? nowIso : new Date(t + 5 * 60e3).toISOString();
      const from = isNaN(t) ? new Date(asOf - 30 * D).toISOString() : new Date(t - 3 * H).toISOString();
      const gpsFrom = isNaN(t) ? from : new Date(t - 40 * 60e3).toISOString();
      calls.push({ typeName: 'FaultData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.unplugged }, fromDate: from, toDate: nowIso }, resultsLimit: 1 });
      calls.push({ typeName: 'StatusData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.voltage }, fromDate: from, toDate: to }, resultsLimit: 500 });
      calls.push({ typeName: 'StatusData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.ignition }, fromDate: from, toDate: to }, resultsLimit: 200 });
      calls.push({ typeName: 'LogRecord', search: { deviceSearch: dev, fromDate: gpsFrom, toDate: to }, resultsLimit: 500 });
      calls.push({ typeName: 'Trip', search: { deviceSearch: dev, fromDate: x.activatedAt || new Date(asOf - 365 * D).toISOString(), toDate: nowIso }, resultsLimit: 1 });
      if (x.isCng) {
        calls.push({ typeName: 'FaultData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.allPower }, fromDate: from14, toDate: nowIso }, resultsLimit: 200 });
        calls.push({ typeName: 'StatusData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.ignition }, fromDate: from14, toDate: nowIso }, resultsLimit: 3000 });
      }
    });
    const res = await session.multi(calls);
    inspect.forEach(x => {
      const b = x.at;
      let sig = deriveSignal({ faults: res[b], volts: res[b + 1], ign: res[b + 2], logs: res[b + 3] });
      if (x.isCng) {
        x.disconnects14 = disconnectDays(res[b + 5], res[b + 6]); x.routine = x.disconnects14 >= 2;
        if (looksLikeSwitch({ sig, ign: res[b + 2], volts: res[b + 1], lastCommAt: x.lastCommAt, routine: x.routine })) sig = 'battery_disconnect';
      }
      x.lastSignal = sig;
      x.lastTripAt = (res[b + 4] || []).length ? (x.lastCommAt || res[b + 4][0].stop) : null;
      x.inspected = true;
    });
  }
  const out = rows.map(x => ({
    serial: String(x.serial).replace(/[^A-Za-z0-9_.\-]/g, ''), customerId: cid, vehicle: x.vehicle, lastCommAt: x.lastCommAt,
    lastSignal: x.lastSignal || '', activatedAt: x.activatedAt, lastTripAt: x.inspected ? x.lastTripAt : x.lastCommAt,
    archived: false, milesToService: null, isCng: !!x.isCng, disconnects14: x.disconnects14 == null ? null : x.disconnects14, routine: !!x.routine, source: 'mygeotab', database: db
  }));
  return { cid, devices: out, silent: silent.length, inspected: inspect.length };
}

return { Session, syncDatabase, slug };

  })();

  function now() { return Date.now(); }
  function iso(ms) { return new Date(ms).toISOString(); }
  function fresh() { return { v: 1, docs: {}, users: [], geo: {}, createdAt: iso(now()) }; }
  function load() { try { state = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { state = null; } if (!state || state.v !== 1) state = fresh(); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('Pitwall trial: browser storage is full or blocked; changes are kept until you close this tab.'); } }
  function clone(v) { return v == null ? null : JSON.parse(JSON.stringify(v)); }

  /* ---------- documents ---------- */
  function getDoc(p) { return state.docs[p] || null; }
  function setDoc(p, d) { state.docs[p] = { data: clone(d) }; changed(p); }
  function updDoc(p, patch) { var m = Object.assign({}, state.docs[p] ? state.docs[p].data : {}, clone(patch)); Object.keys(m).forEach(function (k) { if (m[k] && m[k].__delete__ === true) delete m[k]; }); setDoc(p, m); }
  function delDoc(p) { if (state.docs[p]) { delete state.docs[p]; changed(p); } }
  function addDoc(col, d) { var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); setDoc(col + '/' + id, d); return id; }
  function list(col) { var pre = col + '/', out = []; Object.keys(state.docs).forEach(function (k) { if (k.indexOf(pre) === 0 && k.indexOf('/', pre.length) < 0) out.push({ id: k.slice(pre.length), data: state.docs[k].data }); }); return out; }
  function valid(p, even) { if (typeof p !== 'string' || !p || p.length > 1000) return false; var s = p.split('/'); if (s.some(function (x) { return !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(x) || x === '.' || x === '..'; })) return false; return even ? s.length % 2 === 0 : s.length % 2 === 1; }
  function acquire(p, holder, ttl) { var l = locks[p]; if (l && l.until > now() && l.holder !== holder) return { acquired: false }; locks[p] = { holder: holder, until: now() + Math.min(+ttl || 5000, 30000) }; return { acquired: true }; }

  /* ---------- live updates to open pages and other tabs ---------- */
  function notify(p) {
    var u = me(), d = getDoc(p);
    if (u && u.role === 'customer' && !(d && scopeDoc(u, p, d.data))) return;
    var msg = { data: JSON.stringify({ path: p }) };
    streams.forEach(function (s) { if (s.onmessage) setTimeout(function () { s.onmessage(msg); }, 0); });
  }
  function changed(p) { save(); notify(p); if (bc) bc.postMessage({ path: p }); }
  if (bc) bc.onmessage = function (ev) {
    if (ev.data && ev.data.reset) { location.reload(); return; }
    var keepSync = state && state._syncing; load(); if (keepSync) state._syncing = keepSync; notify(ev.data.path);
  };

  /* ---------- people ---------- */
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function randHex(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer); }
  function hashPw(pw, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' }, k, 256); }).then(hex);
  }
  function makeUser(o) {
    var salt = randHex(16);
    return hashPw(o.password, salt).then(function (h) {
      return { id: 'u_' + randHex(11), username: o.username.toLowerCase(), name: o.name, role: o.role, customerId: o.role === 'customer' ? o.customerId : undefined,
        salt: salt, hash: h, mustChangePassword: !!o.mustChangePassword, createdAt: iso(now()), createdBy: o.createdBy || null };
    });
  }
  function setPw(u, pw) { u.salt = randHex(16); return hashPw(pw, u.salt).then(function (h) { u.hash = h; }); }
  function checkPw(u, pw) { return hashPw(pw, u.salt).then(function (h) { return h === u.hash; }); }
  function me() { var id = null; try { id = localStorage.getItem(SESS); } catch (e) {} return state.users.filter(function (u) { return u.id === id; })[0] || null; }
  function signIn(u) { try { localStorage.setItem(SESS, u.id); } catch (e) {} }
  function signOut() { try { localStorage.removeItem(SESS); } catch (e) {} }
  var canEdit = function (u) { return u && (u.role === 'admin' || u.role === 'editor'); };
  var ADMIN_PATHS = /^(settings|devices|customers)(\/|$)/, ROLES = ['admin', 'editor', 'staff', 'customer'];
  function publicUser(u) { return { id: u.id, name: u.name, username: u.username, role: u.role, customerId: u.customerId || null, mustChangePassword: !!u.mustChangePassword }; }
  function saveUsers() { save(); }

  /* ---------- the company wall (same rules as the Pi) ---------- */
  function scopeDoc(u, p, data) {
    if (!u || u.role !== 'customer') return true;
    var cid = u.customerId, s = p.split('/');
    if (s[0] === 'devices') return !!data && data.customerId === cid;
    if (s[0] === 'customers') return s[1] === cid && s.length === 2;
    if (s[0] === 'settings') return s[1] === 'meta' && s.length === 2;
    if (s[0] === 'counters') return s[1] === 'tickets' && s.length === 2;
    if (s[0] === 'tickets') {
      var t = getDoc('tickets/' + s[1]);
      if (!t || t.data.customerId !== cid) return false;
      if (s.length === 2) return true;
      return s[2] === 'messages' && s.length === 4 && !(data && data.kind === 'note');
    }
    return false;
  }
  function customerWrite(u, op, p, b) {
    var s = p.split('/'), cid = u.customerId, t = iso(now()), deny = [403, { code: 'invalid_argument', error: 'Not allowed for this account.' }];
    var counter = getDoc('counters/tickets'), next = counter && +counter.data.next ? +counter.data.next : 1001;
    if (p === 'counters/tickets') {
      if (op === 'acquire') return [200, acquire(p, u.id, b.ttlMs)];
      if (op === 'update' && b.data && b.data.next === next + 1 && Object.keys(b.data).length === 1) { updDoc(p, { next: next + 1 }); return [200, { ok: true }]; }
      return deny;
    }
    if (s[0] === 'tickets' && s.length === 2 && op === 'set') {
      var d = b.data || {}, n = +d.number;
      if (getDoc(p) || d.customerId !== cid || n !== Math.floor(n) || s[1] !== 't' + n || n >= next) return deny;
      setDoc(p, { number: n, subject: String(d.subject || 'Help request').slice(0, 200), customerId: cid, category: 'Other', priority: 'Normal', status: 'new', assignee: null,
        contact: String(d.contact || u.name).slice(0, 200), serials: Array.isArray(d.serials) ? d.serials.slice(0, 200).map(String) : [], vehicles: Array.isArray(d.vehicles) ? d.vehicles.slice(0, 200).map(String) : [],
        source: d.source === 'brief' ? 'brief' : 'customer', briefKey: typeof d.briefKey === 'string' ? d.briefKey.slice(0, 200) : undefined, briefPeriod: typeof d.briefPeriod === 'string' ? d.briefPeriod.slice(0, 20) : undefined,
        createdBy: u.id, createdAt: t, updatedAt: t, firstResponseAt: null, resolvedAt: null });
      return [200, { ok: true }];
    }
    if (s[0] === 'tickets' && s.length === 3 && s[2] === 'messages' && op === 'add') {
      var tk = getDoc('tickets/' + s[1]), m = b.data || {};
      if (!tk || tk.data.customerId !== cid) return deny;
      if (m.kind === 'event' && m.event === 'created') return [200, { id: addDoc(p, { kind: 'event', event: 'created', by: u.id, at: t }) }];
      if (m.kind !== 'request') return deny;
      var id = addDoc(p, { kind: 'request', body: String(m.body || '').slice(0, 20000), from: u.name, by: u.id, at: t });
      var nd = Object.assign({}, tk.data, { updatedAt: t });
      if (nd.status === 'waiting' || nd.status === 'resolved') { nd.status = 'open'; nd.resolvedAt = null; }
      setDoc('tickets/' + s[1], nd);
      return [200, { id: id }];
    }
    return deny;
  }

  /* ---------- MyGeotab, straight from this browser ----------
     Sent as a form post ("JSON-RPC=…"), the way Geotab's own browser library
     does, so the browser doesn't need a pre-flight check. */
  function gtFetch(url, opts) { return realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'JSON-RPC=' + encodeURIComponent(opts.body), signal: opts.signal }); }
  var geoSessions = {};
  function geoCfg() { var d = getDoc('settings/geotab'); return (d && d.data) || { databases: [] }; }
  function saveGeoCfg(cfg) { cfg.updatedAt = iso(now()); setDoc('settings/geotab', cfg); }
  function setDbStatus(db, patch) { var cfg = geoCfg(); cfg.databases = (cfg.databases || []).map(function (e) { return e.database === db ? Object.assign({}, e, patch) : e; }); saveGeoCfg(cfg); }
  function chunkDocs(cid, devs) { var docs = {}; for (var i = 0, n = 1; i < devs.length; i += 400, n++) docs[cid + '--' + n] = { customerId: cid, chunk: n, devices: devs.slice(i, i + 400) }; return docs; }
  function geoError(e, db, server) {
    var m = (e && (e.geotabName || '') + ' ' + (e.message || '')) || '';
    if (/InvalidUser/i.test(m)) return 'MyGeotab’s sign-in for “' + db + '” has expired or was refused. Remove the database and add it again with its password.';
    if (/Failed to fetch|NetworkError|Load failed|TypeError|abort/i.test(m)) return 'This browser couldn’t reach MyGeotab at ' + (server || 'my.geotab.com') + '. Check the server name and your connection.';
    return 'MyGeotab error: ' + (e && e.message || 'unknown');
  }
  var syncing = null;
  function runSync(only) {
    if (syncing) return syncing;
    var listDb = (geoCfg().databases || []).filter(function (e) { return !only || e.database === only; }), ok = 0;
    syncing = listDb.reduce(function (p, entry) {
      return p.then(function () {
        var db = entry.database, g = state.geo[db];
        if (!g || !g.auth) { setDbStatus(db, { status: '', last: { at: iso(now()), error: 'No MyGeotab sign-in saved for this database. Remove it and add it again.' } }); return; }
        var s = geoSessions[db] || (geoSessions[db] = new PitwallGeotab.Session({ database: db, userName: g.userName, password: '', server: g.server }, gtFetch));
        if (!s.auth) s.auth = g.auth;
        setDbStatus(db, { status: 'Syncing…' });
        return PitwallGeotab.syncDatabase(s, entry, function (msg) { setDbStatus(db, { status: msg }); }).then(function (r) {
          var docs = chunkDocs(r.cid, r.devices);
          Object.keys(docs).forEach(function (id) { setDoc('devices/' + id, docs[id]); });
          list('devices').forEach(function (d) { if (d.id.split('--')[0] === r.cid && !docs[d.id]) delDoc('devices/' + d.id); });
          var ex = getDoc('customers/' + r.cid);
          setDoc('customers/' + r.cid, Object.assign({}, ex && ex.data, { id: r.cid, name: entry.customer || db, database: db }));
          setDbStatus(db, { status: '', last: { at: iso(now()), devices: r.devices.length, silent: r.silent, inspected: r.inspected, error: null } });
          ok++;
        }, function (e) {
          delete geoSessions[db];
          setDbStatus(db, { status: '', last: { at: iso(now()), error: geoError(e, db, g.server) } });
        });
      });
    }, Promise.resolve()).then(function () {
      if (ok) { var m = getDoc('settings/meta'); setDoc('settings/meta', Object.assign({}, m && m.data, { asOf: iso(now()), source: 'mygeotab', syncedAt: iso(now()) })); }
      try { localStorage.setItem(KEY + '-lastsync', String(now())); } catch (e) {}
      return ok;
    }).then(function (r) { syncing = null; return r; }, function (e) { syncing = null; throw e; });
    return syncing;
  }
  function syncIfDue() {
    var last = 0; try { last = +localStorage.getItem(KEY + '-lastsync') || 0; } catch (e) {}
    if ((geoCfg().databases || []).length && now() - last > SYNC_MINUTES * 60e3 - 5000) { try { localStorage.setItem(KEY + '-lastsync', String(now())); } catch (e) {} runSync().catch(function () {}); }
  }
  setTimeout(syncIfDue, 4000); setInterval(syncIfDue, 60e3);

  /* ---------- routes ---------- */
  function body0(b) { return b || {}; }
  function route(method, p, b) {
    var u = me();
    if (p === '/api/state' && method === 'GET') return [200, { setupNeeded: !state.users.length, setupAllowed: true, trial: true, user: u ? publicUser(u) : null }];
    if (p === '/api/setup' && method === 'POST') {
      if (state.users.length) return [409, { error: 'Pitwall is already set up here. Sign in instead.' }];
      if (!b.username || !/^[a-z0-9._@-]{2,64}$/i.test(String(b.username).trim()) || !b.password || String(b.password).length < 8) return [400, { error: 'Choose a username of letters and numbers and a password of at least 8 characters.' }];
      return makeUser({ username: String(b.username).trim(), name: String(b.name || b.username).trim().slice(0, 100), role: 'admin', password: b.password }).then(function (nu) {
        nu.lastLoginAt = iso(now()); state.users.push(nu); saveUsers(); signIn(nu); return [200, { ok: true, mustChangePassword: false }];
      });
    }
    if (p === '/api/login' && method === 'POST') {
      var un = String(b.username || '').trim().toLowerCase(), f = failed[un] || { n: 0, until: 0 };
      if (f.until > now()) return [429, { error: 'Too many attempts. Wait a minute and try again, or ask your Pitwall admin to reset your password.' }];
      var x = state.users.filter(function (y) { return y.username === un; })[0];
      var fail = function () { f.n++; if (f.n >= 5) { f.n = 0; f.until = now() + 60e3; } failed[un] = f; return [401, { error: 'That username and password don’t match.' }]; };
      if (!x) return fail();
      return checkPw(x, b.password || '').then(function (good) {
        if (!good) return fail();
        delete failed[un]; x.lastLoginAt = iso(now()); saveUsers(); signIn(x);
        return [200, { ok: true, mustChangePassword: !!x.mustChangePassword }];
      });
    }
    if (p === '/api/logout' && method === 'POST') { signOut(); return [200, { ok: true }]; }
    if (p === '/api/trial/erase' && method === 'POST') { localStorage.removeItem(KEY); localStorage.removeItem(KEY + '-lastsync'); signOut(); state = fresh(); if (bc) bc.postMessage({ reset: true }); return [200, { ok: true }]; }
    if (!u) return [401, { error: 'Sign in first.' }];

    if (p === '/api/users' && method === 'GET') {
      if (u.role === 'customer') return [200, { users: state.users.filter(function (x) { return x.role !== 'customer' || x.id === u.id; }).map(function (x) { return { id: x.id, name: x.name, isMe: x.id === u.id }; }) }];
      return [200, { users: state.users.map(function (x) { return { id: x.id, name: x.name, username: x.username, role: x.role, customerId: x.customerId || null, isMe: x.id === u.id,
        lastLoginAt: u.role === 'admin' ? x.lastLoginAt || null : undefined, mustChangePassword: u.role === 'admin' ? !!x.mustChangePassword : undefined }; }) }];
    }
    if (p === '/api/users' && method === 'POST') {
      if (u.role !== 'admin') return [403, { error: 'Only admins can add people.' }];
      var nun = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._@-]{2,64}$/.test(nun) || !b.password || String(b.password).length < 8) return [400, { error: 'Use a username of letters and numbers and a password of at least 8 characters.' }];
      if (state.users.some(function (x) { return x.username === nun; })) return [409, { error: 'That username is taken.' }];
      var role = ROLES.indexOf(b.role) >= 0 ? b.role : 'staff';
      if (role === 'customer' && !getDoc('customers/' + b.customerId)) return [400, { error: 'Choose which customer this fleet manager belongs to.' }];
      return makeUser({ username: nun, name: String(b.name || nun).trim().slice(0, 100), role: role, customerId: String(b.customerId || ''), password: b.password, mustChangePassword: true, createdBy: u.id })
        .then(function (nu) { state.users.push(nu); saveUsers(); return [200, { ok: true }]; });
    }
    if (p === '/api/users/update' && method === 'POST') {
      if (u.role !== 'admin') return [403, { error: 'Only admins can change people.' }];
      var tg = state.users.filter(function (x) { return x.id === b.id; })[0];
      if (!tg) return [404, { error: 'That person isn’t on the team any more.' }];
      if (tg.id === u.id && b.role && b.role !== 'admin') return [400, { error: 'You can’t remove your own admin role. Ask another admin.' }];
      if (b.role) {
        if (ROLES.indexOf(b.role) < 0) return [400, { error: 'Unknown role.' }];
        if (b.role === 'customer' && !getDoc('customers/' + (b.customerId || tg.customerId))) return [400, { error: 'Choose which customer this fleet manager belongs to.' }];
        tg.role = b.role; tg.customerId = b.role === 'customer' ? String(b.customerId || tg.customerId) : undefined;
      }
      if (typeof b.name === 'string' && b.name.trim()) tg.name = b.name.trim().slice(0, 100);
      saveUsers(); return [200, { ok: true }];
    }
    if (p === '/api/users/password' && method === 'POST') {
      var tgt = b.id ? state.users.filter(function (x) { return x.id === b.id; })[0] : u;
      if (!tgt || (tgt.id !== u.id && u.role !== 'admin')) return [403, { error: 'Not allowed.' }];
      if (!b.password || String(b.password).length < 8) return [400, { error: 'Use at least 8 characters.' }];
      var chk = tgt.id === u.id && !tgt.mustChangePassword ? checkPw(u, b.current || '') : Promise.resolve(true);
      return chk.then(function (good) {
        if (!good) return [400, { error: 'Your current password isn’t right.' }];
        return setPw(tgt, b.password).then(function () { tgt.mustChangePassword = tgt.id !== u.id; saveUsers(); return [200, { ok: true }]; });
      });
    }
    if (p === '/api/users/remove' && method === 'POST') {
      if (u.role !== 'admin') return [403, { error: 'Only admins can remove people.' }];
      if (b.id === u.id) return [400, { error: 'You can’t remove yourself.' }];
      state.users = state.users.filter(function (x) { return x.id !== b.id; }); saveUsers(); return [200, { ok: true }];
    }

    if (p === '/api/db' && method === 'POST') {
      var op = b.op, pth = b.path;
      if (op === 'list') return valid(pth, false) ? [200, { docs: list(pth).filter(function (d) { return scopeDoc(u, pth + '/' + d.id, d.data); }) }] : [400, { error: 'bad path' }];
      if (!valid(pth, op !== 'add')) return [400, { error: 'bad path' }];
      if (op === 'get') { var d = getDoc(pth), vis = d && scopeDoc(u, pth, d.data); return [200, { exists: !!vis, data: vis ? d.data : null }]; }
      if (u.role === 'customer') return customerWrite(u, op, pth, b);
      if (ADMIN_PATHS.test(pth) && !canEdit(u)) return [403, { code: 'invalid_argument', error: 'Only admins and editors can change this.' }];
      if (op === 'set') { setDoc(pth, b.data || {}); return [200, { ok: true }]; }
      if (op === 'update') { updDoc(pth, b.data || {}); return [200, { ok: true }]; }
      if (op === 'delete') { delDoc(pth); return [200, { ok: true }]; }
      if (op === 'add') return [200, { id: addDoc(pth, b.data || {}) }];
      if (op === 'acquire') return [200, acquire(pth, u.id, b.ttlMs)];
      return [400, { error: 'unknown op' }];
    }

    if (p === '/api/geotab/databases' && method === 'POST') {
      if (!canEdit(u)) return [403, { error: 'Only admins and editors can add databases.' }];
      var db = String(b.database || '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/[/?#].*$/, '');
      if (!db || !b.userName || !b.password) return [400, { error: 'Enter the database name, a MyGeotab username and its password.' }];
      var server = String(b.server || 'my.geotab.com').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'my.geotab.com';
      var s = new PitwallGeotab.Session({ database: db, userName: String(b.userName).trim(), password: String(b.password), server: server }, gtFetch);
      return s.login().then(function () {
        s.cred.password = ''; // never kept
        state.geo[db] = { auth: s.auth, userName: String(b.userName).trim(), server: server, savedAt: iso(now()) }; geoSessions[db] = s;
        var cfg = geoCfg(); cfg.databases = (cfg.databases || []).filter(function (e) { return e.database !== db; }).concat([{ database: db, customer: String(b.customer || db).trim(), userName: String(b.userName).trim(), server: server, addedAt: iso(now()), addedBy: u.id }]);
        saveGeoCfg(cfg); runSync(db).catch(function () {});
        return [200, { ok: true }];
      }, function (e) {
        return [400, { error: /InvalidUser/i.test((e.geotabName || '') + e.message) ? 'MyGeotab didn’t accept that login for “' + db + '”. Check the database name, username and password.' : geoError(e, db, server) }];
      });
    }
    if (p === '/api/geotab/remove' && method === 'POST') {
      if (!canEdit(u)) return [403, { error: 'Only admins and editors can remove databases.' }];
      var cfg2 = geoCfg(); cfg2.databases = (cfg2.databases || []).filter(function (e) { return e.database !== b.database; }); delete state.geo[b.database]; delete geoSessions[b.database]; saveGeoCfg(cfg2);
      return [200, { ok: true }];
    }
    if (p === '/api/geotab/sync' && method === 'POST') {
      if (!canEdit(u)) return [403, { error: 'Only admins and editors can sync.' }];
      runSync(b.database || null).catch(function () {}); return [200, { ok: true, syncMinutes: SYNC_MINUTES }];
    }
    if (p === '/api/geotab/info' && method === 'GET') { if (u.role === 'customer') return [403, { error: 'Not allowed for this account.' }]; return [200, { syncMinutes: SYNC_MINUTES, syncing: !!syncing, trial: true }]; }
    if (p === '/api/backups') { if (u.role === 'customer') return [403, { error: 'Not allowed for this account.' }]; return [200, { local: { daily: 0, monthly: 0, latest: null }, drives: [], configured: 0, trial: true }]; }
    if (p === '/api/events') return [200, {}];
    return [404, { error: 'Not found' }];
  }
  function handle(method, p, b) {
    try { return Promise.resolve(route(method, p, body0(b))).catch(function (e) { console.error(e); return [500, { error: 'Something went wrong: ' + e.message }]; }); }
    catch (e) { console.error(e); return Promise.resolve([500, { error: 'Something went wrong: ' + e.message }]); }
  }
  function apiPath(url) { try { var u = new URL(url, location.href); var i = u.pathname.indexOf('/api/'); return i >= 0 && u.origin === location.origin ? u.pathname.slice(i) : null; } catch (e) { return null; } }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url, p = apiPath(url);
    if (!p) return realFetch(input, init);
    init = init || {};
    var method = (init.method || 'GET').toUpperCase(), b = null;
    try { b = init.body ? JSON.parse(init.body) : null; } catch (e) { b = null; }
    return handle(method, p, b).then(function (r) { return new Response(JSON.stringify(r[1]), { status: r[0], headers: { 'Content-Type': 'application/json' } }); });
  };
  var RealES = window.EventSource;
  window.EventSource = function (url) {
    if (!apiPath(url)) return new RealES(url);
    var s = { onmessage: null, onerror: null, onopen: null, close: function () { streams = streams.filter(function (x) { return x !== s; }); } };
    streams.push(s); setTimeout(function () { if (s.onopen) s.onopen(); }, 0);
    return s;
  };
  window.pitwallTrial = { erase: function () { return handle('POST', '/api/trial/erase', {}); } };
  load();
})();
