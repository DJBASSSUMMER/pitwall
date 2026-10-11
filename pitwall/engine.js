/* Pitwall engine: shared by the hosted app and the MyGeotab Add-in.
   Pure functions only. No DOM, no network. */
(function (root) {
  'use strict';
  var H = 3600e3, D = 24 * H;

  var CAUSES = {
    unplugged:    { label: 'Likely unplugged',  hint: 'Power removed with ignition off', tone: 'crit' },
    voltage:      { label: 'Wiring / voltage',  hint: 'Low or unstable supply',          tone: 'warn' },
    gps:          { label: 'No GPS fix',        hint: 'Ignition seen, no location',      tone: 'info' },
    seasonal:     { label: 'Parked / seasonal', hint: 'Normal shutdown, idle 14+ days',  tone: 'muted' },
    notinstalled: { label: 'Never installed',   hint: 'Activated, no trips ever',        tone: 'purple' },
    unknown:      { label: 'Needs a look',      hint: 'No clear signal before silence',  tone: 'muted' }
  };
  var CAUSE_ORDER = ['unplugged', 'voltage', 'gps', 'notinstalled', 'seasonal', 'unknown'];

  var SIGNALS = ['power_removed', 'low_voltage', 'reboot_loop', 'ignition_no_gps', 'normal_shutdown', 'normal', ''];

  function t(x) { if (x == null || x === '') return null; var v = typeof x === 'number' ? x : Date.parse(x); return isNaN(v) ? null : v; }

  function fmtAgo(ms) {
    if (ms == null || !isFinite(ms)) return 'never';
    if (ms < H) return Math.max(1, Math.round(ms / 60e3)) + ' min';
    if (ms < D) return Math.round(ms / H) + ' h';
    var d = Math.floor(ms / D), h = Math.round((ms - d * D) / H);
    if (h === 24) { d++; h = 0; }
    return d < 3 && h ? d + ' d ' + h + ' h' : d + ' d';
  }

  /* d: normalized device. flags: {seasonal:bool}. Returns classification. */
  function classifyDevice(d, asOf, flags) {
    flags = flags || {};
    var last = t(d.lastCommAt), act = t(d.activatedAt), trip = t(d.lastTripAt);
    var silentMs = last == null ? Infinity : Math.max(0, asOf - last);
    var r = { serial: d.serial, silent: false, silentMs: silentMs, cause: null, archived: !!d.archived };
    if (d.archived) return r;
    if (!trip && act != null && asOf - act > 7 * D) {
      r.silent = true; r.cause = 'notinstalled'; r.silentMs = asOf - act; return r;
    }
    if (silentMs < D) return r;
    r.silent = true;
    if (flags.seasonal) { r.cause = 'seasonal'; r.flagged = true; return r; }
    switch (d.lastSignal) {
      case 'power_removed': r.cause = 'unplugged'; break;
      case 'low_voltage': case 'reboot_loop': r.cause = 'voltage'; break;
      case 'ignition_no_gps': r.cause = 'gps'; break;
      case 'normal_shutdown': r.cause = silentMs > 14 * D ? 'seasonal' : 'unknown'; break;
      default: r.cause = 'unknown';
    }
    return r;
  }

  /* Several units at one customer losing power within a 3-hour window
     points to shop work rather than individual drivers. */
  function markBatches(devices, cls) {
    var byCust = {};
    devices.forEach(function (d) {
      var c = cls[d.serial];
      if (c && c.cause === 'unplugged') (byCust[d.customerId] = byCust[d.customerId] || []).push(d);
    });
    Object.keys(byCust).forEach(function (cid) {
      var list = byCust[cid].slice().sort(function (a, b) { return t(a.lastCommAt) - t(b.lastCommAt); });
      for (var i = 0; i < list.length; i++) {
        var group = [list[i]];
        for (var j = 0; j < list.length; j++) {
          if (j !== i && Math.abs(t(list[j].lastCommAt) - t(list[i].lastCommAt)) <= 3 * H) group.push(list[j]);
        }
        if (group.length >= 3) group.forEach(function (g) {
          var c = cls[g.serial];
          if (!c.batch || c.batchSize < group.length) { c.batch = true; c.batchSize = group.length; }
        });
      }
    });
  }

  function nextStep(c) {
    if (!c || !c.silent) return 'Reporting normally.';
    switch (c.cause) {
      case 'unplugged': return c.batch
        ? c.batchSize + ' units at this customer lost power within hours of each other. That points to shop work, not drivers. Ask the fleet manager before sending an installer. Stored records upload once the units are plugged back in.'
        : 'Power was removed with the ignition off. Check with the driver or fleet manager; if the device was pulled on purpose, consider a harness install in a less accessible spot.';
      case 'voltage': return 'Supply voltage was low or unstable before it went quiet. Book an installer to check the harness and connection.';
      case 'gps': return 'The vehicle is running but not getting a location fix. Usually antenna placement or obstruction: inspect where the device is mounted.';
      case 'seasonal': return 'Normal shutdown and parked for weeks. Confirm with the customer, then consider suspending billing until the season starts.';
      case 'notinstalled': return 'Activated (and likely billing) but has never recorded a trip. Book the install or return the unit.';
      default: return 'No clear signal before it went quiet. Ask the customer whether the vehicle is in use.';
    }
  }

  function price(pricing, kind, name, field) {
    var tbl = (pricing && pricing[kind]) || {};
    var row = tbl[name];
    return row && isFinite(+row[field]) ? +row[field] : 0;
  }

  var EX_TYPES = {
    plan:      { label: 'Plan mismatch',      tone: 'info' },
    overcharge:{ label: 'Customer overbilled',tone: 'warn' },
    uninvoiced:{ label: 'Not invoiced',       tone: 'info' },
    install:   { label: 'Billing, not installed', tone: 'purple' },
    ghost:     { label: 'Archived, still billing', tone: 'crit' },
    addon:     { label: 'Add-on not invoiced',tone: 'warn' },
    margin:    { label: 'Below target margin',tone: 'muted' }
  };

  function billing(devices, customers, pricing, cls) {
    var ex = {}, perCust = {}, cmap = {};
    (customers || []).forEach(function (c) { cmap[c.id] = c; });
    /* Wholesale cost from the pricing table; sell price from the customer's
       contract price when set, else the list price. */
    function cost(kind, name) { return price(pricing, kind, name, 'cost'); }
    function sell(kind, name, cid) {
      var c = cmap[cid];
      if (c && c.prices && c.prices[name] != null && c.prices[name] !== '' && isFinite(+c.prices[name])) return +c.prices[name];
      return price(pricing, kind, name, 'price');
    }
    function add(cid, type, serial, impact, detail) {
      var id = cid + '~' + type;
      var e = ex[id] || (ex[id] = { id: id, customerId: cid, type: type, units: 0, impact: 0, serials: [], detail: detail });
      e.units++; e.impact += impact; e.serials.push(serial);
    }
    devices.forEach(function (d) {
      var cid = d.customerId;
      var pc = perCust[cid] || (perCust[cid] = { revenue: 0, cost: 0, billed: 0, invoiced: 0 });
      var addons = d.addons || [], inv = d.invoicedAddons || [];
      if (d.plan) { pc.cost += cost('plans', d.plan); pc.billed++; }
      addons.forEach(function (a) { pc.cost += cost('addons', a); });
      if (d.invoicedPlan) { pc.revenue += sell('plans', d.invoicedPlan, cid); pc.invoiced++; }
      inv.forEach(function (a) { pc.revenue += sell('addons', a, cid); });
      if (!d.plan) return;
      var c = cls[d.serial] || {};
      if (d.archived) add(cid, 'ghost', d.serial, cost('plans', d.plan), 'Vehicle archived, device still billing in MyAdmin');
      else if (c.cause === 'notinstalled') add(cid, 'install', d.serial, cost('plans', d.plan), 'Activated and billing, never recorded a trip');
      if (!d.archived) {
        if (!d.invoicedPlan) add(cid, 'uninvoiced', d.serial, sell('plans', d.plan, cid), 'Billing in MyAdmin, on no customer invoice line');
        else if (d.invoicedPlan !== d.plan) {
          var diff = sell('plans', d.plan, cid) - sell('plans', d.invoicedPlan, cid);
          if (diff > 0) add(cid, 'plan', d.serial, diff, 'MyAdmin ' + d.plan + ', invoiced as ' + d.invoicedPlan);
          else if (diff < 0) add(cid, 'overcharge', d.serial, -diff, 'MyAdmin ' + d.plan + ', invoiced as ' + d.invoicedPlan);
        }
        addons.forEach(function (a) {
          if (inv.indexOf(a) < 0) add(cid, 'addon', d.serial, sell('addons', a, cid), a + ' billing, not on customer invoice');
        });
      }
    });
    var target = pricing && isFinite(+pricing.targetMarginPct) ? +pricing.targetMarginPct / 100 : 0;
    var margins = {};
    Object.keys(perCust).forEach(function (cid) {
      var p = perCust[cid];
      var m = p.revenue > 0 ? (p.revenue - p.cost) / p.revenue : null;
      margins[cid] = { revenue: p.revenue, cost: p.cost, marginPct: m == null ? null : m * 100, billed: p.billed, invoiced: p.invoiced };
      if (target > 0 && target < 1 && m != null && m < target) {
        var need = p.cost / (1 - target) - p.revenue;
        ex[cid + '~margin'] = { id: cid + '~margin', customerId: cid, type: 'margin', units: p.invoiced, impact: Math.max(0, need), serials: [], detail: 'Margin ' + (m * 100).toFixed(1) + '% vs target ' + (target * 100).toFixed(0) + '%' };
      }
    });
    var list = Object.keys(ex).map(function (k) { var e = ex[k]; e.impact = Math.round(e.impact * 100) / 100; return e; });
    list.sort(function (a, b) { return b.impact - a.impact; });
    return { exceptions: list, margins: margins };
  }

  /* Full analysis over a normalized dataset. */
  function analyze(data) {
    var asOf = t(data.asOf) || Date.now();
    var devices = data.devices || [], customers = data.customers || [], flags = data.flags || {};
    var custById = {}; customers.forEach(function (c) { custById[c.id] = c; });
    var cls = {};
    devices.forEach(function (d) { cls[d.serial] = classifyDevice(d, asOf, flags[d.serial]); });
    markBatches(devices, cls);
    var bill = billing(devices, customers, data.pricing, cls);
    var health = {};
    customers.forEach(function (c) { health[c.id] = { units: 0, active: 0, reporting: 0, silent: 0, pmTracked: 0, pmOk: 0, causes: {} }; });
    devices.forEach(function (d) {
      var h = health[d.customerId] || (health[d.customerId] = { units: 0, active: 0, reporting: 0, silent: 0, pmTracked: 0, pmOk: 0, causes: {} });
      h.units++;
      var c = cls[d.serial];
      if (d.archived) return;
      h.active++;
      if (c.silent) { h.silent++; h.causes[c.cause] = (h.causes[c.cause] || 0) + 1; } else h.reporting++;
      if (d.milesToService != null && d.milesToService !== '' && isFinite(+d.milesToService)) { h.pmTracked++; if (+d.milesToService >= 0) h.pmOk++; }
    });
    Object.keys(health).forEach(function (cid) {
      var h = health[cid], c = custById[cid] || {};
      h.reportingPct = h.active ? h.reporting / h.active * 100 : null;
      h.pmPct = h.pmTracked ? h.pmOk / h.pmTracked * 100 : null;
      var login = t(c.lastAdminLoginAt);
      h.loginDays = login == null ? null : Math.floor((asOf - login) / D);
      var ren = t(c.renewalAt);
      h.renewalDays = ren == null ? null : Math.ceil((ren - asOf) / D);
      h.churnRisk = h.loginDays != null && h.loginDays >= 30;
    });
    return { asOf: asOf, cls: cls, billing: bill, health: health, custById: custById };
  }

  /* One ranked list of things a person should act on. */
  function queue(data, A, resolved) {
    resolved = resolved || {};
    var items = [], groups = {};
    (data.devices || []).forEach(function (d) {
      var c = A.cls[d.serial];
      if (!c || !c.silent || c.cause === 'seasonal' || c.cause === 'notinstalled') return;
      var key = d.customerId + '~' + c.cause + (c.batch ? '~batch' : '');
      var g = groups[key] || (groups[key] = { customerId: d.customerId, cause: c.cause, batch: !!c.batch, serials: [], maxSilent: 0 });
      g.serials.push(d.serial); g.maxSilent = Math.max(g.maxSilent, c.silentMs);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], n = g.serials.length, cz = CAUSES[g.cause];
      var text = g.batch
        ? n + ' vehicles lost power within hours of each other, likely during shop work.'
        : n + (n === 1 ? ' vehicle' : ' vehicles') + ' silent, ' + cz.label.toLowerCase() + '. Longest: ' + fmtAgo(g.maxSilent) + '.';
      items.push({ id: 'dev~' + k, cat: 'devices', sev: g.cause === 'unknown' ? 'Risk' : 'Critical', customerId: g.customerId, kind: cz.label, text: text, impactLabel: n + (n === 1 ? ' vehicle' : ' vehicles'), score: n * 40 + (g.batch ? 200 : 0), route: 'devices', filter: { customerId: g.customerId, cause: g.cause } });
    });
    A.billing.exceptions.forEach(function (e) {
      if (resolved[e.id]) return;
      items.push({ id: 'bill~' + e.id, cat: 'billing', sev: e.type === 'overcharge' ? 'Risk' : 'Revenue', customerId: e.customerId, kind: EX_TYPES[e.type].label, text: e.detail + ' (' + e.units + (e.units === 1 ? ' unit' : ' units') + ').', impactLabel: money(e.impact) + '/mo', score: e.impact, route: 'billing', filter: { exceptionId: e.id } });
    });
    Object.keys(A.health).forEach(function (cid) {
      var h = A.health[cid];
      if (!h.churnRisk) return;
      var txt = 'No admin login for ' + h.loginDays + ' days.' + (h.renewalDays != null && h.renewalDays > 0 ? ' Renewal in ' + h.renewalDays + ' days.' : '');
      items.push({ id: 'cust~' + cid, cat: 'customers', sev: 'Risk', customerId: cid, kind: 'Adoption', text: txt, impactLabel: 'Renewal risk', score: 300 + (h.renewalDays != null && h.renewalDays < 90 ? 400 : 0), route: 'customers', filter: { customerId: cid } });
    });
    items.sort(function (a, b) { return b.score - a.score; });
    return items;
  }

  function money(n) {
    var v = Math.round(+n || 0);
    return '$' + v.toLocaleString('en-US');
  }

  /* ---- CSV ---- */
  function parseCSV(text) {
    var rows = [], row = [], f = '', q = false, i = 0, s = String(text || '').replace(/^﻿/, '');
    for (; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
      } else f += ch;
    }
    row.push(f); if (row.length > 1 || row[0] !== '') rows.push(row);
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); });
    return rows.slice(1).map(function (r) { var o = {}; head.forEach(function (h, k) { o[h] = (r[k] || '').trim(); }); return o; });
  }

  function csvCell(v) {
    if (v == null) return '';
    var s = Array.isArray(v) ? v.join('|') : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows, cols) {
    return [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return csvCell(r[c]); }).join(','); })).join('\r\n');
  }

  var DEVICE_COLS = ['serial', 'customerId', 'vehicle', 'plan', 'invoicedPlan', 'addons', 'invoicedAddons', 'lastCommAt', 'lastSignal', 'activatedAt', 'lastTripAt', 'archived', 'milesToService'];
  var CUSTOMER_COLS = ['id', 'name', 'database', 'lastAdminLoginAt', 'renewalAt'];

  function pick(o, names) { for (var i = 0; i < names.length; i++) { var v = o[names[i]]; if (v != null && v !== '') return v; } return ''; }
  function list(v) { return String(v || '').split(/[|;]/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function bool(v) { return /^(1|true|yes|y|archived)$/i.test(String(v || '').trim()); }
  function iso(v) { var x = t(v); return x == null ? null : new Date(x).toISOString(); }
  function slug(v) { return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

  /* Returns {devices, errors}. Accepts loose header names. */
  function rowsToDevices(rows) {
    var out = [], errors = [], seen = {};
    rows.forEach(function (r, i) {
      var serial = pick(r, ['serial', 'serialnumber', 'deviceserial', 'device']);
      var cust = pick(r, ['customerid', 'customer', 'database', 'customername', 'account']);
      if (!serial) { errors.push('Row ' + (i + 2) + ': missing serial'); return; }
      if (!cust) { errors.push('Row ' + (i + 2) + ': missing customer'); return; }
      if (seen[serial]) { errors.push('Row ' + (i + 2) + ': duplicate serial ' + serial + ' (kept the first)'); return; }
      seen[serial] = 1;
      var sig = pick(r, ['lastsignal', 'signal', 'lastevent']).toLowerCase().replace(/[^a-z_]/g, '_');
      if (SIGNALS.indexOf(sig) < 0) { errors.push('Row ' + (i + 2) + ': unknown lastSignal "' + sig + '", treated as blank'); sig = ''; }
      var mts = pick(r, ['milestoservice', 'servicedue', 'milesuntilservice']);
      out.push({
        serial: serial.replace(/[^A-Za-z0-9_.\-]/g, ''),
        customerId: slug(cust),
        customerName: cust,
        vehicle: pick(r, ['vehicle', 'vehiclename', 'name', 'asset']) || 'Unassigned',
        plan: pick(r, ['plan', 'rateplan', 'myadminplan', 'billingplan']) || null,
        invoicedPlan: pick(r, ['invoicedplan', 'invoiceplan', 'customerplan']) || null,
        addons: list(pick(r, ['addons', 'myadminaddons'])),
        invoicedAddons: list(pick(r, ['invoicedaddons'])),
        lastCommAt: iso(pick(r, ['lastcommat', 'lastcommunicated', 'lastseen', 'datetime'])),
        lastSignal: sig,
        activatedAt: iso(pick(r, ['activatedat', 'billingstartdate', 'activationdate'])),
        lastTripAt: iso(pick(r, ['lasttripat', 'lasttrip'])),
        archived: bool(pick(r, ['archived', 'inactive'])),
        milesToService: mts === '' || !isFinite(+mts) ? null : +mts
      });
    });
    return { devices: out, errors: errors };
  }

  function rowsToCustomers(rows) {
    var out = [], errors = [];
    rows.forEach(function (r, i) {
      var name = pick(r, ['name', 'customername', 'customer']);
      var id = slug(pick(r, ['id', 'customerid']) || name);
      if (!id) { errors.push('Row ' + (i + 2) + ': missing customer name'); return; }
      out.push({ id: id, name: name || id, database: pick(r, ['database', 'db']), lastAdminLoginAt: iso(pick(r, ['lastadminloginat', 'lastlogin', 'lastadminlogin'])), renewalAt: iso(pick(r, ['renewalat', 'renewal', 'renewaldate'])) });
    });
    return { customers: out, errors: errors };
  }

  var api = { CAUSES: CAUSES, CAUSE_ORDER: CAUSE_ORDER, EX_TYPES: EX_TYPES, SIGNALS: SIGNALS, DEVICE_COLS: DEVICE_COLS, CUSTOMER_COLS: CUSTOMER_COLS,
    classifyDevice: classifyDevice, markBatches: markBatches, nextStep: nextStep, billing: billing, analyze: analyze, queue: queue,
    fmtAgo: fmtAgo, money: money, parseCSV: parseCSV, toCSV: toCSV, rowsToDevices: rowsToDevices, rowsToCustomers: rowsToCustomers, slug: slug, time: t };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PitwallEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
