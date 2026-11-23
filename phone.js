// Read-only phone view of the Glasses Link session strip. Its own key (made at Taha's terminal, scanned
// from a QR). The key can only decrypt v-view.json; nothing on this page sends anything anywhere.
'use strict';
(function () {
  // ---- same colours and order as the glasses strip (glasses-link/index.html) ----
  function tone(s, now) {
    if (s.wait) return 'red';
    if (s.status === 'busy') return 'green';
    var a = now - (s.last || s.since || 0);
    return a < 3600 ? 'green' : a < 86400 ? 'orange' : 'grey';
  }
  function short(sec) {
    if (sec < 60) return 'now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) { var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h + 'h' + (h < 10 && m ? ' ' + m + 'm' : ''); }
    return Math.floor(sec / 86400) + 'd';
  }
  var TONE_RANK = { red: 0, green: 1, orange: 2, grey: 3 };
  function order(list, now) {
    return list.map(function (s) { return { s: s, t: tone(s, now) }; }).sort(function (a, b) {
      if (a.t !== b.t) return TONE_RANK[a.t] - TONE_RANK[b.t];
      if (a.t === 'red') return (a.s.wsince || 0) - (b.s.wsince || 0);
      if ((a.s.status === 'busy') !== (b.s.status === 'busy')) return a.s.status === 'busy' ? -1 : 1;
      return (b.s.last || b.s.since || 0) - (a.s.last || a.s.since || 0);
    });
  }
  window.__phoneTest = { tone: tone, short: short, order: order };

  var PUB = location.hostname === '127.0.0.1' ? 'http://127.0.0.1:8767/pub/' : 'https://monitor.protaha.com/devlink/pub/';
  var AAD = new TextEncoder().encode('glasses-phone-view-v1');
  var $ = function (id) { return document.getElementById(id); };
  var KEY = null, KID = null, data = null, gotAt = 0, skew = 0, fails = 0, badKey = false, gone = 0, timer = null;

  function db() {
    return new Promise(function (ok, no) {
      var r = indexedDB.open('glasses-phone', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('k'); };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { no(r.error); };
    });
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, no) {
        var t = d.transaction('k', mode), req = fn(t.objectStore('k'));
        t.oncomplete = function () { ok(req && req.result); }; t.onerror = function () { no(t.error); };
      });
    });
  }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function b64(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  // Key from the QR link (#v=...): import as non-extractable, store, then wipe it from the address bar.
  function takeKeyFromLink() {
    var m = /[#&]v=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (!m) return Promise.resolve(false);
    var raw = b64(m[1]);
    if (raw.length !== 32) return Promise.resolve(false);
    return crypto.subtle.digest('SHA-256', raw).then(function (h) {
      var kid = hex(h).slice(0, 8);
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']).then(function (k) {
        raw.fill(0);
        return idb('readwrite', function (st) { return st.put({ key: k, kid: kid }, 'v'); }).then(function () { return true; });
      });
    });
  }
  function loadKey() {
    return idb('readonly', function (st) { return st.get('v'); }).then(function (r) {
      if (r && r.key) { KEY = r.key; KID = r.kid; }
    });
  }

  function show(text) { var m = $('msg'); m.textContent = text; m.hidden = !text; }
  function now() { return Math.floor(Date.now() / 1000) - skew; }   // control-box clock
  function stale() { return fails >= 3 || !data || Date.now() - gotAt > 120000; }

  function render() {
    var list = $('list'), head = $('head');
    list.textContent = '';
    if (!KEY) { head.textContent = ''; $('forget').hidden = true; $('upd').textContent = '';
      show('This phone is not paired. At the terminal run: bash ~/ops/glasses-phone-pair.sh and scan the code.'); return; }
    $('forget').hidden = false;
    if (badKey || gone >= 3) { head.textContent = ''; $('upd').textContent = '';
      show('This phone\'s key was cancelled or replaced. Pair again at the terminal to see the sessions.'); return; }
    var st = stale(), n = now(), items = order((data && data.sessions) || [], n), reds = 0;
    items.forEach(function (x) { if (x.t === 'red') reds++; });
    head.className = 'head' + (!st && reds ? ' red' : '');
    head.textContent = !data ? 'loading…' : st ? 'offline' : reds ? reds + ' waiting for you' : 'none waiting';
    list.classList.toggle('stale', st);
    show(st && data && fails >= 3 ? 'Cannot reach the status feed. Showing the last known state.' : (data && !items.length ? 'No sessions to show right now.' : ''));
    items.forEach(function (x) {
      var s = x.s, c = document.createElement('div'); c.className = 'card ' + x.t;
      var d = document.createElement('span'); d.className = 'dot';
      var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = String(s.label || '');
      var w = document.createElement('span'); w.className = 'when';
      if (x.t === 'red') { var a = short(Math.max(0, n - (s.wsince || n))); w.textContent = (s.wait === 'menu' ? 'needs an answer · ' : 'asked you · ') + (a === 'now' ? 'just now' : a); }
      else if (s.status === 'busy') w.textContent = 'working';
      else if (!s.last) w.textContent = '—';
      else { var b = short(Math.max(0, n - s.last)); w.textContent = b === 'now' ? 'just now' : b + ' ago'; }
      c.appendChild(d); c.appendChild(nm); c.appendChild(w); list.appendChild(c);
    });
    $('upd').textContent = data ? 'Updated ' + (function (s) { return s === 'now' ? 'just now' : s + ' ago'; })(short(Math.max(0, Math.floor((Date.now() - gotAt) / 1000)))) : '';
  }

  function poll() {
    if (!KEY || document.hidden) return;
    fetch(PUB + 'v-view.json?t=' + Date.now(), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (r) { if (r.status === 404) gone++; else gone = 0; if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (blob) {
        if (blob.kid !== KID) { badKey = true; return; }
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv), additionalData: AAD }, KEY, b64(blob.ct)).then(function (pt) {
          var p = JSON.parse(new TextDecoder().decode(pt));
          if (!p || !Array.isArray(p.sessions)) throw new Error('shape');
          if (data && p.at < data.at) return;
          if (!data || p.at !== data.at) { gotAt = Date.now(); skew = Math.floor(Date.now() / 1000) - p.at; }
          data = p; fails = 0; badKey = false;
        });
      })
      .catch(function () { fails++; })
      .then(render);
  }

  $('forget').addEventListener('click', function () {
    if (!confirm('Forget this phone? You will need to scan a new code at the terminal to see the sessions again.')) return;
    idb('readwrite', function (st) { return st.delete('v'); }).then(function () { KEY = null; KID = null; data = null; render(); });
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  takeKeyFromLink().catch(function () { return false; }).then(loadKey).catch(function () {}).then(function () {
    render(); poll(); timer = setInterval(poll, 5000); setInterval(render, 15000);
  });
})();
