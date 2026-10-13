/* Demo banner: who you're signed in as, reset, sign out. */
(function () {
  'use strict';
  var css = '.pwdemo{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;justify-content:space-between;padding:8px 16px;background:#16191D;color:#F3F4F1;font:13px/1.4 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;border-bottom:2px solid #C2410C}'
    + '.pwdemo b{color:#FDBA74;font-weight:600}.pwdemo .r{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '.pwdemo button{font:inherit;font-weight:600;color:#F3F4F1;background:transparent;border:1px solid #59606A;border-radius:6px;min-height:32px;padding:0 10px;cursor:pointer}.pwdemo button:hover{border-color:#F3F4F1}'
    + '.pwdemo button:focus-visible{outline:2px solid #FDBA74;outline-offset:2px}'
    + '@media (max-width:700px){.pwdemo{padding:6px 12px}.pwdemo .long,#pwdemoWho{display:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var bar = document.createElement('div'); bar.className = 'pwdemo'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Demo');
  bar.innerHTML = '<span><b>Pitwall demo</b><span class="long"> · Sample fleets for made-up companies. Your changes stay in this browser only.</span></span>'
    + '<span class="r"><span id="pwdemoWho"></span><button type="button" id="pwdemoReset">Reset demo</button><button type="button" id="pwdemoOut">Sign out</button></span>';
  document.body.insertBefore(bar, document.body.firstChild);
  var ROLE = { admin: 'Admin', editor: 'Editor', staff: 'Staff' };
  fetch('api/state').then(function (r) { return r.json(); }).then(function (s) { if (s.user) document.getElementById('pwdemoWho').textContent = 'Signed in as ' + s.user.name + ' (' + ROLE[s.user.role] + ')'; });
  document.getElementById('pwdemoOut').addEventListener('click', function () { fetch('api/logout', { method: 'POST', body: '{}' }).then(function () { location.href = 'login.html'; }); });
  var rb = document.getElementById('pwdemoReset');
  rb.addEventListener('click', function () {
    if (!rb.dataset.confirm) { rb.dataset.confirm = '1'; rb.textContent = 'Click again to reset'; setTimeout(function () { delete rb.dataset.confirm; rb.textContent = 'Reset demo'; }, 4000); return; }
    window.pitwallDemo.reset(); location.reload();
  });
})();
