/* Pitwall Add-in for MyGeotab.
   Finds devices that stopped communicating in this database, reads what each
   one reported just before going quiet, and classifies the likely cause using
   the same engine as the Pitwall web app. Read-only: makes only Get calls. */
(function () {
  'use strict';

  var H = 3600e3, D = 24 * H;
  var IDS = {
    unplugged: 'DiagnosticDeviceHasBeenUnpluggedId',
    voltage: 'DiagnosticGoDeviceVoltageId',
    ignition: 'DiagnosticIgnitionId'
  };
  var MAX_INSPECT = 300;     // silent devices inspected in detail per load
  var CALLS_PER_BATCH = 100; // calls per multiCall request

  /* ---------- pure: turn raw records into one signal ---------- */
  function deriveSignal(r) {
    // r: {faults:[], volts:[{dateTime,data}], ign:[{dateTime,data}], logs:[{dateTime,latitude,longitude}]}
    var byTime = function (a, b) { return Date.parse(a.dateTime) - Date.parse(b.dateTime); };
    var volts = (r.volts || []).slice().sort(byTime);
    var ign = (r.ign || []).slice().sort(byTime);
    var logs = (r.logs || []).filter(function (l) { return l.latitude || l.longitude; }).sort(byTime);
    if ((r.faults || []).length) return 'power_removed';
    var lastIgn = ign.length ? ign[ign.length - 1] : null;
    var ignOn = lastIgn ? +lastIgn.data === 1 : null;
    var lastV = volts.length ? +volts[volts.length - 1].data : null;
    var lowCount = volts.filter(function (v) { return +v.data > 0 && +v.data < 11.5; }).length;
    if (lastV != null && lastV < 6 && ignOn !== true) return 'power_removed';
    if (volts.length >= 3 && lowCount / volts.length >= 0.5) return 'low_voltage';
    if (ignOn === true) {
      var lastLog = logs.length ? Date.parse(logs[logs.length - 1].dateTime) : null;
      if (lastLog == null || Date.parse(lastIgn.dateTime) - lastLog > 20 * 60e3) return 'ignition_no_gps';
      return 'normal';
    }
    if (ignOn === false) return 'normal_shutdown';
    return '';
  }

  /* ---------- MyGeotab API helpers ---------- */
  function call(api, method, params) {
    return new Promise(function (res, rej) { api.call(method, params, res, rej); });
  }
  function multi(api, calls) {
    var out = [], i = 0;
    function next() {
      if (i >= calls.length) return Promise.resolve(out);
      var part = calls.slice(i, i + CALLS_PER_BATCH); i += CALLS_PER_BATCH;
      return new Promise(function (res, rej) { api.multiCall(part, res, rej); }).then(function (r) { out = out.concat(r); return next(); });
    }
    return next();
  }
  function session(api) {
    return new Promise(function (res) { try { api.getSession(function (s) { res(s || {}); }); } catch (e) { res({}); } });
  }

  function loadLive(api, onProgress) {
    var now = new Date();
    return Promise.all([
      session(api),
      call(api, 'Get', { typeName: 'Device', search: { fromDate: now.toISOString() } }),
      call(api, 'Get', { typeName: 'DeviceStatusInfo' })
    ]).then(function (r) {
      var sess = r[0], devices = r[1] || [], statuses = r[2] || [];
      var st = {}; statuses.forEach(function (s) { if (s.device) st[s.device.id] = s; });
      var asOf = now.getTime();
      var rows = devices.map(function (d) {
        var s = st[d.id] || {};
        return { id: d.id, serial: d.serialNumber || d.id, vehicle: d.name || d.serialNumber, activatedAt: d.activeFrom || null, lastCommAt: s.dateTime || null, communicating: s.isDeviceCommunicating };
      });
      var silent = rows.filter(function (x) { var t = Date.parse(x.lastCommAt); return isNaN(t) || asOf - t >= D; })
        .sort(function (a, b) { return (Date.parse(a.lastCommAt) || 0) - (Date.parse(b.lastCommAt) || 0); });
      var inspect = silent.slice(0, MAX_INSPECT);
      var calls = [];
      inspect.forEach(function (x) {
        var t = Date.parse(x.lastCommAt);
        var to = isNaN(t) ? now.toISOString() : new Date(t + 5 * 60e3).toISOString();
        var from = isNaN(t) ? new Date(asOf - 30 * D).toISOString() : new Date(t - 3 * H).toISOString();
        var dev = { id: x.id };
        calls.push(['Get', { typeName: 'FaultData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.unplugged }, fromDate: from, toDate: now.toISOString() }, resultsLimit: 1 }]);
        calls.push(['Get', { typeName: 'StatusData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.voltage }, fromDate: from, toDate: to }, resultsLimit: 200 }]);
        calls.push(['Get', { typeName: 'StatusData', search: { deviceSearch: dev, diagnosticSearch: { id: IDS.ignition }, fromDate: from, toDate: to }, resultsLimit: 50 }]);
        calls.push(['Get', { typeName: 'LogRecord', search: { deviceSearch: dev, fromDate: from, toDate: to }, resultsLimit: 200 }]);
        calls.push(['Get', { typeName: 'Trip', search: { deviceSearch: dev, fromDate: x.activatedAt || new Date(asOf - 365 * D).toISOString() }, resultsLimit: 1 }]);
      });
      if (onProgress) onProgress('Reading recent events for ' + inspect.length + ' silent devices…');
      return multi(api, calls).then(function (res) {
        inspect.forEach(function (x, i) {
          var b = i * 5;
          x.lastSignal = deriveSignal({ faults: res[b], volts: res[b + 1], ign: res[b + 2], logs: res[b + 3] });
          var trips = res[b + 4] || [];
          x.lastTripAt = trips.length ? (trips[trips.length - 1].stop || trips[trips.length - 1].start) : null;
        });
        rows.forEach(function (x) { if (x.lastTripAt === undefined) x.lastTripAt = x.lastCommAt; });
        return { database: sess.database || 'this database', asOf: asOf, rows: rows, truncated: silent.length - inspect.length };
      });
    });
  }

  /* Example data for opening the page outside MyGeotab. */
  function loadDemo() {
    var asOf = Date.now(), rows = [], i;
    function add(n, name, hoursAgo, sig, extra) { var o = { id: 'b' + n, serial: 'G9DEMO' + String(n).padStart(4, '0'), vehicle: name, activatedAt: new Date(asOf - 400 * D).toISOString(), lastCommAt: hoursAgo == null ? null : new Date(asOf - hoursAgo * H).toISOString(), lastSignal: sig }; o.lastTripAt = o.lastCommAt; Object.assign(o, extra || {}); rows.push(o); }
    for (i = 1; i <= 40; i++) add(i, 'Truck ' + i, Math.random() * 3, 'normal');
    for (i = 41; i <= 47; i++) add(i, 'Truck ' + i, 70 + (i - 41) * 0.3, 'power_removed');
    add(48, 'Van 3', 52, 'ignition_no_gps'); add(49, 'Van 4', 96, 'low_voltage'); add(50, 'Loader 2', 900, 'normal_shutdown');
    add(51, 'Unassigned', null, '', { activatedAt: new Date(asOf - 20 * D).toISOString(), lastTripAt: null });
    return Promise.resolve({ database: 'Example database', asOf: asOf, rows: rows, truncated: 0, demo: true });
  }

  /* ---------- UI ---------- */
  var SIG = { power_removed: 'Power removed, ignition off', low_voltage: 'Low supply voltage', reboot_loop: 'Repeated reboots', ignition_no_gps: 'Ignition on, no GPS fix', normal_shutdown: 'Normal shutdown', normal: 'Normal trip end', '': 'No events found' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function View(root) { this.root = root; this.cause = ''; this.data = null; this.analysis = null; }
  View.prototype.status = function (msg) { this.root.querySelector('[data-gl="body"]').innerHTML = '<p class="pw-status"><span class="pw-spin" aria-hidden="true"></span>' + esc(msg) + '</p>'; };
  View.prototype.setData = function (data) {
    var E = window.PitwallEngine;
    var devices = data.rows.map(function (r) { return { serial: r.serial, customerId: 'db', vehicle: r.vehicle, lastCommAt: r.lastCommAt, lastSignal: r.lastSignal || '', activatedAt: r.activatedAt, lastTripAt: r.lastTripAt }; });
    var flags = loadFlags();
    var A = E.analyze({ asOf: data.asOf, devices: devices, customers: [{ id: 'db', name: data.database }], pricing: {}, flags: flags });
    this.data = data; this.devices = devices; this.analysis = A; this.render();
  };
  View.prototype.render = function () {
    var E = window.PitwallEngine, A = this.analysis, self = this;
    var silent = this.devices.filter(function (d) { return A.cls[d.serial].silent; });
    var counts = {}; silent.forEach(function (d) { var c = A.cls[d.serial].cause; counts[c] = (counts[c] || 0) + 1; });
    var checked = new Date(this.data.asOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    var h = '<header class="pw-head"><div class="pw-title">'
      + '<p class="pw-db">' + esc(this.data.database) + (this.data.demo ? '<span class="pw-demo">Example data</span>' : '') + '</p>'
      + '<h1 class="pw-h1"><span class="pw-big">' + silent.length + '</span> of ' + this.devices.length + ' devices have gone silent</h1>'
      + '<p class="pw-sub">No data received for 24 hours or more. Checked at ' + esc(checked) + '.</p></div>'
      + '<div class="pw-actions"><button type="button" class="pw-btn" data-gl-act="refresh">Refresh</button>'
      + '<button type="button" class="pw-btn pw-primary" data-gl-act="export">Export CSV</button></div></header>';
    if (this.data.truncated > 0) h += '<p class="pw-note">Checked the ' + MAX_INSPECT + ' longest-silent devices in detail. ' + this.data.truncated + ' more are listed under "Needs a look".</p>';
    if (silent.length) {
      h += '<section class="pw-strip" aria-label="Silent devices by likely cause"><div class="pw-bar" aria-hidden="true">'
        + E.CAUSE_ORDER.filter(function (k) { return counts[k]; }).map(function (k) { return '<span class="pw-seg pw-c-' + k + '" style="flex-grow:' + counts[k] + '"></span>'; }).join('')
        + '</div><div class="pw-legend">'
        + E.CAUSE_ORDER.map(function (k) {
          var n = counts[k] || 0;
          return '<button type="button" class="pw-key pw-c-' + k + (n ? '' : ' pw-zero') + '" data-gl-act="cause" data-v="' + k + '" aria-pressed="' + (self.cause === k) + '"' + (n ? '' : ' disabled') + '>'
            + '<span class="pw-sw" aria-hidden="true"></span><span class="pw-kn">' + n + '</span><span class="pw-kl">' + esc(E.CAUSES[k].label) + '</span></button>';
        }).join('') + '</div></section>'
        + '<div class="pw-tools"><label class="pw-search"><span class="pw-vh">Search silent devices</span>'
        + '<input type="search" data-gl="q" placeholder="Search by vehicle or serial" value="' + esc(this.query || '') + '"></label>'
        + '<p class="pw-count" data-gl="count" aria-live="polite"></p></div>';
    }
    h += '<div data-gl="list"></div>'
      + '<p class="pw-foot">Likely causes come from the last voltage, ignition, GPS and unplug records before each device went quiet. Pitwall only reads data; it never changes anything in this database. "Mark parked" is saved in this browser only.</p>';
    this.root.querySelector('[data-gl="body"]').innerHTML = h;
    this.silent = silent;
    this.renderList();
  };
  View.prototype.renderList = function () {
    var E = window.PitwallEngine, A = this.analysis, self = this;
    var list = this.root.querySelector('[data-gl="list"]'); if (!list) return;
    var q = (this.query || '').trim().toLowerCase();
    var shown = this.silent.filter(function (d) {
      if (self.cause && A.cls[d.serial].cause !== self.cause) return false;
      return !q || (String(d.vehicle) + ' ' + d.serial).toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return A.cls[b.serial].silentMs - A.cls[a.serial].silentMs; });
    var count = this.root.querySelector('[data-gl="count"]');
    if (count) count.textContent = shown.length === this.silent.length ? 'Longest silent first' : 'Showing ' + shown.length + ' of ' + this.silent.length;
    if (!this.silent.length) { list.innerHTML = '<div class="pw-empty"><strong>Every device has reported in the last 24 hours.</strong><span>Nothing to chase right now. Refresh later to check again.</span></div>'; return; }
    if (!shown.length) { list.innerHTML = '<div class="pw-empty"><strong>No silent devices match.</strong><span>Clear the search or pick a different cause.</span></div>'; return; }
    // Silence bar: log scale from 1 day up to the longest silence, so 2 days and 200 days both read.
    var max = Math.max.apply(null, shown.map(function (d) { var m = A.cls[d.serial].silentMs; return isFinite(m) ? m : 0; }).concat([2 * D]));
    var lmax = Math.log(max / D);
    var firstOfBatch = {};
    list.innerHTML = '<div class="pw-cols" aria-hidden="true"><span>Vehicle</span><span>Silent for</span><span>Likely cause</span><span>Next step</span><span></span></div><ul class="pw-rows">'
      + shown.map(function (d) {
        var c = A.cls[d.serial], cz = E.CAUSES[c.cause];
        var pct = isFinite(c.silentMs) ? Math.max(4, Math.min(100, Math.log(Math.max(c.silentMs, D) / D) / lmax * 100)) : 100;
        return '<li class="pw-row pw-c-' + c.cause + '">'
          + '<div class="pw-veh"><strong>' + esc(d.vehicle) + '</strong><span class="pw-serial">' + esc(d.serial) + '</span></div>'
          + '<div class="pw-gap"><span class="pw-gap-t">' + esc(E.fmtAgo(c.silentMs)) + '</span><span class="pw-track" aria-hidden="true"><span class="pw-fill" style="width:' + pct.toFixed(1) + '%"></span></span></div>'
          + '<div class="pw-why"><span class="pw-tag">' + esc(cz.label) + '</span>'
          + (c.batch ? '<span class="pw-batch">' + c.batchSize + ' lost power together</span>' : '')
          + '<span class="pw-sig">Last signal: ' + esc(SIG[d.lastSignal] || d.lastSignal || 'none') + '</span></div>'
          + (function () {
            if (!c.batch) return '<p class="pw-next">' + esc(E.nextStep(c)) + '</p>';
            var key = c.cause + '~' + c.batchSize, first = firstOfBatch[key];
            if (!first) { firstOfBatch[key] = d.vehicle; return '<p class="pw-next">' + esc(E.nextStep(c)) + '</p>'; }
            return '<p class="pw-next pw-same">Same batch as ' + esc(first) + '. One check covers all ' + c.batchSize + '.</p>';
          })()
          + '<div class="pw-act"><button type="button" class="pw-btn pw-ghost" data-gl-act="seasonal" data-v="' + esc(d.serial) + '">' + (c.flagged ? 'Unmark parked' : 'Mark parked') + '</button></div></li>';
      }).join('') + '</ul>';
  };
  View.prototype.exportCsv = function () {
    var E = window.PitwallEngine, db = this.data.database;
    var rows = this.devices.map(function (d) { return { serial: d.serial, customerId: db, vehicle: d.vehicle, plan: '', invoicedPlan: '', addons: '', invoicedAddons: '', lastCommAt: d.lastCommAt, lastSignal: d.lastSignal, activatedAt: d.activatedAt, lastTripAt: d.lastTripAt, archived: 'false', milesToService: '' }; });
    var csv = E.toCSV(rows, E.DEVICE_COLS);
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'pitwall-' + E.slug(db) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  };

  var FLAG_KEY = 'pitwall.parked';
  function loadFlags() { try { return JSON.parse(localStorage.getItem(FLAG_KEY) || '{}'); } catch (e) { return {}; } }
  function toggleFlag(serial) { var f = loadFlags(); if (f[serial]) delete f[serial]; else f[serial] = { seasonal: true }; try { localStorage.setItem(FLAG_KEY, JSON.stringify(f)); } catch (e) {} }

  function start(api, demo) {
    var root = document.getElementById('pitwallAddin');
    if (!root) return;
    var view = new View(root);
    function load() {
      view.status('Loading devices…');
      (demo ? loadDemo() : loadLive(api, function (m) { view.status(m); }))
        .then(function (d) { view.setData(d); })
        .catch(function (e) { view.status('Couldn’t load devices: ' + ((e && (e.message || e.name)) || e) + '. Check that your user can view devices and engine data.'); });
    }
    if (!root._glBound) {
      root._glBound = true;
      root.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-gl-act]'); if (!b) return;
        var act = b.getAttribute('data-gl-act'), v = b.getAttribute('data-v');
        if (act === 'refresh') load();
        else if (act === 'export') view.exportCsv();
        else if (act === 'cause') { view.cause = view.cause === v ? '' : v; view.render(); var k = root.querySelector('[data-gl-act="cause"][data-v="' + v + '"]'); if (k) k.focus(); }
        else if (act === 'seasonal') { toggleFlag(v); view.setData(view.data); }
      });
      root.addEventListener('input', function (ev) {
        if (ev.target.getAttribute('data-gl') === 'q') { view.query = ev.target.value; view.renderList(); }
      });
    }
    load();
  }

  /* ---------- MyGeotab entry point ---------- */
  if (typeof window !== 'undefined') {
    var inMyGeotab = typeof window.geotab !== 'undefined' && window.geotab && window.geotab.addin;
    if (!inMyGeotab) window.geotab = { addin: {} };
    window.geotab.addin.pitwall = function () {
      return {
        initialize: function (api, state, callback) { callback(); },
        focus: function (api) { start(api, false); },
        blur: function () {}
      };
    };
    if (!inMyGeotab) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { start(null, true); });
      else start(null, true);
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { deriveSignal: deriveSignal };
})();
