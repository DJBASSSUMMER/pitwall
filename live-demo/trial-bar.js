/* Trial banner: who you're signed in as, erase, sign out. */
(function () {
  'use strict';
  var css = '.pwtrial{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;justify-content:space-between;padding:8px 16px;background:#0E3B36;color:#F3F4F1;font:13px/1.4 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;border-bottom:2px solid #2BB3A3}'
    + '.pwtrial b{color:#8ED8CC;font-weight:600}.pwtrial .r{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '.pwtrial a,.pwtrial button{font:inherit;font-weight:600;color:#F3F4F1;background:transparent;border:1px solid #5E8F89;border-radius:6px;min-height:32px;padding:0 10px;cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}'
    + '.pwtrial a:hover,.pwtrial button:hover{border-color:#F3F4F1}.pwtrial a:focus-visible,.pwtrial button:focus-visible{outline:2px solid #8ED8CC;outline-offset:2px}'
    + '@media (max-width:760px){.pwtrial{padding:6px 12px}.pwtrial .long,#pwtrialWho{display:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var bar = document.createElement('div'); bar.className = 'pwtrial'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Trial');
  bar.innerHTML = '<span><b>Pitwall Live trial</b><span class="long"> · Starts empty and reads your real MyGeotab data. Everything you do here is saved only in this browser.</span></span>'
    + '<span class="r"><span id="pwtrialWho"></span><button type="button" id="pwtrialErase">Erase everything</button><button type="button" id="pwtrialOut">Sign out</button></span>';
  document.body.insertBefore(bar, document.body.firstChild);
  var ROLE = { admin: 'Admin', editor: 'Editor', staff: 'Staff', customer: 'Fleet manager' };
  fetch('api/state').then(function (r) { return r.json(); }).then(function (s) {
    if (s.user) document.getElementById('pwtrialWho').textContent = 'Signed in as ' + s.user.name + ' (' + ROLE[s.user.role] + ')';
    else document.getElementById('pwtrialOut').hidden = true;
  });
  document.getElementById('pwtrialOut').addEventListener('click', function () { fetch('api/logout', { method: 'POST', body: '{}' }).then(function () { location.href = 'login.html'; }); });
  var eb = document.getElementById('pwtrialErase');
  eb.addEventListener('click', function () {
    if (!eb.dataset.confirm) { eb.dataset.confirm = '1'; eb.textContent = 'Click again: erase all trial data'; setTimeout(function () { delete eb.dataset.confirm; eb.textContent = 'Erase everything'; }, 4000); return; }
    window.pitwallTrial.erase().then(function () { location.href = 'login.html'; });
  });
})();
