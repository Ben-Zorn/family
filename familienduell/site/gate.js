// Password gate: nothing (app code, questions, styles, PeerJS, fonts) is loaded before the password is accepted.
(function () {
  'use strict';
  var PAGE = document.documentElement.dataset.page;
  var KEY_LS = 'fd_auth';
  var b64 = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  function form(msg) {
    document.body.innerHTML =
      '<form id="g" style="max-width:340px;margin:22vh auto;padding:1.5em;font-family:system-ui,sans-serif;display:grid;gap:.8em;color:#fff">' +
      '<h1 style="margin:0;color:#f5c542;font-size:1.6em">Familien-Duell</h1>' +
      '<input id="pw" type="password" placeholder="Passwort" autocomplete="current-password" autofocus ' +
      'style="font-size:1.2em;padding:.6em;border-radius:8px;border:1px solid #26346a;background:#0b1433;color:#fff">' +
      '<button style="font-size:1.1em;padding:.6em;border:0;border-radius:8px;background:#f5c542;color:#2b1a00;font-weight:600">Weiter</button>' +
      '<div id="err" style="color:#ff6b6b;min-height:1.2em">' + (msg || '') + '</div></form>';
    document.getElementById('g').onsubmit = function (e) {
      e.preventDefault();
      var pw = document.getElementById('pw').value;
      document.getElementById('err').textContent = 'Prüfe …';
      unlock(pw, true);
    };
  }
  async function unlock(pw, remember) {
    try {
      var res = await fetch('app.enc', { cache: 'no-cache' });
      var enc = await res.json();
      var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
      var key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.data));
      var app = JSON.parse(new TextDecoder().decode(plain));
      if (remember) try { localStorage.setItem(KEY_LS, pw); } catch (e) {}
      await boot(app);
    } catch (e) {
      try { localStorage.removeItem(KEY_LS); } catch (x) {}
      form(e && e.name === 'OperationError' ? 'Falsches Passwort' : 'Fehler: ' + (e && e.message || e));
    }
  }
  function loadExt(src) {
    return new Promise(function (ok, fail) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { ok(); }; document.head.appendChild(s); });
  }
  async function boot(app) {
    var p = app.pages[PAGE];
    var st = document.createElement('style'); st.textContent = app.css; document.head.appendChild(st);
    var f = document.createElement('link'); f.rel = 'stylesheet'; f.href = 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&display=swap'; document.head.appendChild(f);
    document.body.innerHTML = p.body;
    window.__QUESTIONS = app.questions;
    for (var i = 0; i < p.ext.length; i++) await loadExt(p.ext[i]);
    p.scripts.forEach(function (name) { var s = document.createElement('script'); s.textContent = app.js[name]; document.body.appendChild(s); });
  }
  var saved = null; try { saved = localStorage.getItem(KEY_LS); } catch (e) {}
  if (saved) { document.body.innerHTML = ''; unlock(saved, false); } else form();
})();
