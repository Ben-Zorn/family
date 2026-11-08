'use strict';
// ======================= Buzzer (phone) =======================
const params = new URLSearchParams(location.search);
let room = (params.get('room') || localStorage.getItem('fd_lastRoom') || '').toUpperCase();
let team = params.has('team') ? (params.get('team') === '1' ? 1 : 0) : null;
let cid = sessionStorage.getItem('fd_cid'); // per tab, survives reloads
if (!cid) { cid = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('fd_cid', cid); }

const pad = $('#pad'), btn = $('#buzzBtn'), msg = $('#msg');

function setState(st, label, text) {
  pad.className = 'buzz-body st-' + st;
  if (label != null) btn.textContent = label;
  if (text != null) msg.textContent = text;
}

// ======================= Clock sync =======================
// NTP-style: phone sends t0, host answers with its receive/send times t1/t2, phone notes t3.
//   rtt    = (t3 - t0) - (t2 - t1)
//   offset = ((t1 - t0) + (t2 - t3)) / 2      (host clock = phone clock + offset)
// Samples with the lowest RTT are the most symmetric/accurate, so we take the median offset
// of the best 30 % of the last 20 s of samples (a classic "minimum-delay filter").
const samples = [];
let offset = 0, err = Infinity, rttMed = null, rttMin = null, pingSeq = 0, synced = false;
function sendPing() {
  if (!conn || !conn.open) return;
  try { conn.send({ t: 'ping', id: ++pingSeq, t0: performance.now() }); } catch (e) {}
}
function onPong(m) {
  const t3 = performance.now();
  const rtt = (t3 - m.t0) - (m.t2 - m.t1);
  if (rtt < 0 || rtt > 5000) return;
  const off = ((m.t1 - m.t0) + (m.t2 - t3)) / 2;
  samples.push({ rtt, off, at: t3 });
  const now = t3;
  while (samples.length && (now - samples[0].at > 20000 || samples.length > 60)) samples.shift();
  const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
  const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length * 0.3)));
  const offs = best.map(s => s.off).sort((a, b) => a - b);
  offset = offs[Math.floor(offs.length / 2)];
  rttMin = byRtt[0].rtt;
  rttMed = byRtt[Math.floor(byRtt.length / 2)].rtt;
  // error bound: half the best RTT plus spread of the chosen offsets
  err = rttMin / 2 + (offs[offs.length - 1] - offs[0]) / 2;
  if (!synced && samples.length >= 8) { synced = true; if (state === 'idle') setState('idle', 'Warten', 'Bereit! Warte auf Freigabe …'); }
  $('#connInfo').textContent = `Ping ${Math.round(rttMed)} ms · Sync ±${Math.max(1, Math.round(err))} ms`;
}
let pingTimer = null, burstLeft = 0;
function startPinging() {
  clearInterval(pingTimer); burstLeft = 20;
  const loop = () => {
    sendPing();
    pingTimer = setTimeout(loop, burstLeft-- > 0 ? 70 : 400);
  };
  loop();
}
setInterval(() => {
  if (conn && conn.open && rttMed != null) try { conn.send({ t: 'sync', rttMin, rttMed, err }); } catch (e) {}
}, 1500);

// ======================= Connection =======================
let peer = null, conn = null, reconnectTimer = null;
function start() {
  if (typeof Peer === 'undefined') { setState('locked', 'Offline', 'PeerJS konnte nicht geladen werden – Internetverbindung prüfen.'); return; }
  peer = new Peer(PEER_OPTS);
  peer.on('open', connect);
  peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1500));
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') { msg.textContent = `Spiel „${room}“ nicht gefunden – läuft die Spielleitung am Laptop?`; scheduleReconnect(2500); }
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { msg.textContent = 'Netzwerkproblem – versuche erneut …'; scheduleReconnect(3000); }
  });
}
function scheduleReconnect(ms) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, ms); }
function connect() {
  clearTimeout(reconnectTimer);
  if (!peer || peer.destroyed) return start();
  if (peer.disconnected) { peer.reconnect(); scheduleReconnect(2000); return; }
  if (conn) { try { conn.close(); } catch (e) {} }
  $('#connInfo').textContent = 'verbinde …';
  const c = peer.connect(PEER_PREFIX + room, { reliable: true, serialization: 'json' });
  conn = c;
  const openTimeout = setTimeout(() => { if (!c.open && conn === c) { try { c.close(); } catch (e) {} scheduleReconnect(500); } }, 8000);
  c.on('open', () => {
    clearTimeout(openTimeout);
    samples.length = 0; synced = false;
    c.send({ t: 'hello', cid, team });
    setState('idle', 'Warten', 'Verbunden – synchronisiere Uhr …');
    startPinging();
  });
  c.on('data', onMsg);
  c.on('close', () => {
    if (conn !== c) return;
    clearTimeout(pingTimer);
    $('#connInfo').textContent = 'getrennt';
    setState('locked', 'Offline', 'Verbindung verloren – verbinde neu …');
    scheduleReconnect(1500);
  });
  c.on('error', () => {});
}
// Full teardown + fresh Peer. A phone that was locked/backgrounded often keeps a dead signaling socket and
// stale WebRTC channel that never fire 'close', so a soft reconnect can hang forever – start from scratch instead.
function hardReset() {
  clearTimeout(reconnectTimer); clearTimeout(pingTimer);
  const oldPeer = peer; conn = null; peer = null;
  try { oldPeer && oldPeer.destroy(); } catch (e) {}
  $('#connInfo').textContent = 'verbinde …';
  setState('locked', 'Offline', 'Verbinde neu …');
  start();
}
setInterval(() => { // watchdog: no pong for a while -> full reset
  if (conn && conn.open && samples.length && performance.now() - samples[samples.length - 1].at > 6000) hardReset();
}, 2000);
window.addEventListener('online', hardReset);
window.addEventListener('pageshow', e => { if (e.persisted) hardReset(); });

// ======================= Buzz logic =======================
let state = 'idle', armId = null, goLocal = 0, shownAt = 0, lockUntil = 0, penaltyMs = 1000, buzzedId = null, rafId = null;
let teamNameStr = '';
function onMsg(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'pong') return onPong(m);
  if (m.t === 'welcome') {
    teamNameStr = m.teamName;
    $('#teamName').textContent = m.teamName;
    $('#teamName').style.color = m.team === 0 ? 'var(--teamA)' : 'var(--teamB)';
    document.title = 'Buzzer – ' + m.teamName;
  }
  if (m.t === 'arm') onArm(m);
  if (m.t === 'disarm') { cancelAnimationFrame(rafId); delete pad.dataset.win; armId = null; state = 'idle'; setState('idle', 'Warten', 'Gesperrt – warte auf Freigabe …'); }
  if (m.t === 'result') onResult(m);
}
function onArm(m) {
  cancelAnimationFrame(rafId); delete pad.dataset.win;
  armId = m.id; penaltyMs = m.penaltyMs ?? 1000; buzzedId = null; lockUntil = 0;
  goLocal = m.goHost - offset;            // the shared GO instant, in this phone's clock
  state = 'ready';
  setState('idle', 'Warten', 'Gleich …'); // no yellow warning screen; GO appears at the synced instant
  const myArm = armId;
  const spin = () => {
    if (armId !== myArm || state !== 'ready') return;
    if (performance.now() >= goLocal - 4) { showGo(); return; }
    rafId = requestAnimationFrame(spin);
  };
  rafId = requestAnimationFrame(spin);
  // timer fallback in case animation frames are throttled
  setTimeout(() => { if (armId === myArm && state === 'ready') showGo(); }, Math.max(0, goLocal - performance.now()));
}
function showGo() {
  if (state !== 'ready') return;
  state = 'go';
  shownAt = performance.now();         // the moment GO is put on screen (painted this frame)
  if (shownAt < lockUntil) {
    setState('locked', 'Gesperrt', 'Fehlstart-Sperre …');
    // reaction time still counts from the real GO moment – the lockout is the penalty
    setTimeout(() => { if (state === 'go' && buzzedId !== armId) setState('go', 'BUZZ!', ''); }, lockUntil - shownAt);
  } else setState('go', 'BUZZ!', '');
}
function press(ts) {
  if (!conn || !conn.open) return;
  if (state === 'ready') return; // GO not shown yet (only the short ping-compensation lead) – ignore

  if (state === 'go' && buzzedId !== armId) {
    if (ts < lockUntil || ts < shownAt) return;
    buzzedId = armId; state = 'pressed';
    const rt = ts - shownAt;
    conn.send({ t: 'buzz', id: armId, rt, pressHost: ts + offset, late: shownAt - goLocal });
    setState('pressed', 'Gedrückt', `Reaktion: ${fmtMs(rt)}`);
    navigator.vibrate?.(40);
  }
}
function onResult(m) {
  if (m.id !== armId) return;
  cancelAnimationFrame(rafId);
  const me = m.list.find(x => x.cid === cid);
  const w = m.list[0];
  const col = m.winnerTeam === 0 ? 'var(--teamA)' : 'var(--teamB)';
  document.documentElement.style.setProperty('--winCol', col); // winner's colour on every phone
  pad.dataset.win = m.winnerTeam === 0 ? '0' : '1';
  if (m.winner === cid) {
    state = 'win'; setState('win', 'Erster!', `${fmtMs(me.rt)}${m.list[1] ? ` · ${Math.round(m.list[1].rt - me.rt)} ms schneller` : ''}`);
    navigator.vibrate?.([120, 60, 120]);
  } else {
    state = 'lose';
    const who = m.winnerName || 'Das andere Team';
    setState('lose', 'Zu spät', `${who} hat bereits gebuzzt` + (me ? ` · ${fmtMs(me.rt)} (${Math.round(me.rt - w.rt)} ms langsamer)` : ''));
    navigator.vibrate?.(40);
  }
}
// pointerdown fires earliest; event.timeStamp is the hardware-ish event time on the same clock as performance.now()
btn.addEventListener('pointerdown', e => {
  e.preventDefault();
  let ts = e.timeStamp; const now = performance.now();
  if (!(ts > 0) || Math.abs(now - ts) > 1000) ts = now;
  press(ts);
  requestWakeLock();
});
['contextmenu', 'dblclick', 'gesturestart'].forEach(t => document.addEventListener(t, e => e.preventDefault()));

// ---------- keep screen awake ----------
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  requestWakeLock();
  const last = samples.length ? samples[samples.length - 1].at : 0;
  // after a screen lock the old connection is usually dead even if it still says "open"
  if (!conn || !conn.open || performance.now() - last > 3000) hardReset();
  else startPinging();
});

// ---------- join screen ----------
if (!room || team === null) {
  $('#join').classList.remove('hidden');
  $('#roomIn').value = room;
  let pick = team ?? 0;
  const mark = () => document.querySelectorAll('.teampick button').forEach(b => b.classList.toggle('sel', +b.dataset.team === pick));
  mark();
  document.querySelectorAll('.teampick button').forEach(b => b.onclick = () => { pick = +b.dataset.team; mark(); });
  $('#joinBtn').onclick = () => {
    const r = $('#roomIn').value.trim().toUpperCase();
    if (r.length !== 4) { alert('Bitte den 4-stelligen Raumcode eingeben.'); return; }
    location.search = `?room=${r}&team=${pick}`;
  };
} else {
  localStorage.setItem('fd_lastRoom', room);
  pad.classList.remove('hidden');
  start();
}

