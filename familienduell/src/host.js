'use strict';
// ======================= Host / Spielleitung =======================
const LS = { game: 'fd_game', played: 'fd_played', settings: 'fd_settings', room: 'fd_room' };
const load = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const TONES = { family: 'Familienfreundlich', cheeky: 'Frech', adult: 'Erwachsene' };
const ACTIVE = ['faceoff', 'play', 'steal'];

let Q = [];
let played = load(LS.played) || {};          // qid -> {t, how:'played'|'skipped'}
let settings = Object.assign({
  teams: ['Team Rot', 'Team Blau'], topicsOff: {}, tones: { family: true, cheeky: true, adult: true },
  showQ: true, armMode: 'random', penaltyMs: 1000, peekAlways: false,
}, load(LS.settings) || {});
const newGame = () => ({ teams: [...settings.teams], scores: [0, 0], phase: 'idle', round: 0, mult: 1, q: null, answers: [], control: null, strikes: 0, award: null, buzz: null, showQ: settings.showQ, history: [] });
let S = load(LS.game) || newGame();
let undoStack = [];

// ---------- board(s) ----------
const board = createBoard($('#boardWrap'));
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('fd-board') : null;
let popBeat = 0;
if (bc) bc.onmessage = e => {
  const m = e.data;
  if (m.type === 'hello') bc.postMessage({ type: 'state', s: S });
  if (m.type === 'beat') { const was = isPopped(); popBeat = Date.now(); if (!was) renderAll(); }
};
const isPopped = () => Date.now() - popBeat < 3000;
setInterval(() => { const p = isPopped(); if (p !== $('#host').classList.contains('popped')) renderAll(); }, 1000);
function boardEvent(ev) { board.event(ev, S); if (bc) bc.postMessage({ type: 'ev', ev }); }

// ---------- persistence / undo ----------
function save() { store(LS.game, S); }
function savePlayed() { store(LS.played, played); }
function saveSettings() { store(LS.settings, settings); }
function act(fn) {
  undoStack.push(JSON.stringify(S)); if (undoStack.length > 80) undoStack.shift();
  fn(); save(); renderAll();
}
function undo() {
  if (!undoStack.length) return;
  S = JSON.parse(undoStack.pop()); save(); renderAll();
}

// ---------- questions ----------
function pool() {
  return Q.filter(q => !played[q.id] && settings.tones[q.tone] !== false && !settings.topicsOff[q.topic]);
}
function nextQuestion(skip = false) {
  if (!skip && ACTIVE.includes(S.phase) && bankOf(S) > 0 &&
      !confirm('Die Punkte dieser Runde wurden noch nicht vergeben. Trotzdem neue Frage?')) return;
  const p = pool();
  if (!p.length) { alert('Keine Fragen mehr verfügbar. In der Fragen-Verwaltung Kategorien aktivieren oder gespielte Fragen zurücksetzen.'); return; }
  const q = p[Math.floor(Math.random() * p.length)];
  played[q.id] = { t: Date.now(), how: 'played' }; savePlayed();
  disarm(true);
  broadcast({ t: 'disarm' }); boardEvent({ ev: 'disarm' }); // reset all buzzers (colour, result) for the new question
  act(() => {
    if (!skip) S.round++;
    if (S.round < 1) S.round = 1;
    S.q = { id: q.id, text: q.q, topic: q.topic, tone: q.tone };
    S.answers = q.answers.map(a => ({ a: a.a, p: a.p, st: 0 }));
    S.phase = 'faceoff'; S.control = null; S.strikes = 0; S.award = null; S.buzz = null; S.qShown = false;
  });
}
function skipQuestion() {
  if (!S.q || S.phase === 'over') return;
  if (S.phase === 'done') { alert('Diese Runde ist schon gewertet – einfach „Neue Frage“ nehmen.'); return; }
  if (bankOf(S) > 0 && !confirm('Frage überspringen? Bereits aufgedeckte Punkte verfallen.')) return;
  played[S.q.id] = { t: Date.now(), how: 'skipped' }; savePlayed();
  (S.history = S.history || []).push({ round: S.round, q: S.q.text, skipped: true });
  nextQuestion(true);
}

// ---------- game actions ----------
function award(t) {
  const pts = bankOf(S);
  S.scores[t] += pts; S.award = { team: t, pts }; S.phase = 'done';
  (S.history = S.history || []).push({ round: S.round, q: S.q ? S.q.text : '', team: t, pts });
  if (pts) Snd.win();
}
function reveal(i) {
  const a = S.answers[i]; if (!a || a.st) return;
  act(() => {
    a.st = ACTIVE.includes(S.phase) ? 1 : 2;
    Snd.ding();
    if (S.phase === 'steal') award(1 - S.control);
    else if (S.phase === 'play' && S.answers.every(x => x.st)) award(S.control);
  });
}
function strike() {
  if (!S.q) return;
  act(() => {
    Snd.strike();
    if (S.phase === 'play') {
      S.strikes = Math.min(3, S.strikes + 1);
      boardEvent({ ev: 'strike', n: S.strikes });
      if (S.strikes >= 3) S.phase = 'steal';
    } else if (S.phase === 'steal') {
      boardEvent({ ev: 'strike', n: 1 }); award(S.control);
    } else boardEvent({ ev: 'strike', n: 1 });
  });
}
function setControl(t) { if (S.phase !== 'faceoff' && S.phase !== 'play') return; act(() => { S.phase = 'play'; S.control = t; S.strikes = 0; }); }
function stealResult(ok) { if (S.phase !== 'steal') return; act(() => award(ok ? 1 - S.control : S.control)); }
function manualAward(t) { if (!ACTIVE.includes(S.phase)) return; act(() => award(t)); }
function revealRest() { act(() => S.answers.forEach(a => { if (!a.st) a.st = 2; })); }
function endGame() { if (confirm('Spiel beenden und Sieger anzeigen?')) act(() => { S.phase = 'over'; }); }
function correctScore() {
  for (const t of [0, 1]) {
    const v = prompt(`Punktestand ${S.teams[t]}:`, S.scores[t]);
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!isNaN(n)) act(() => { S.scores[t] = n; });
  }
}

// ======================= Networking (PeerJS / WebRTC) =======================
let room = load(LS.room) || genRoom();
store(LS.room, room);
function genRoom() { const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += L[Math.floor(Math.random() * L.length)]; return s; }

let peer = null;
const clients = new Map(); // cid -> {conn, cid, team, name, rttMin, rttMed, err, seen}
function setPeerStatus(txt, ok) {
  const el = $('#peerStatus'); el.classList.toggle('on', ok === true); el.classList.toggle('warn', ok === 'warn');
  el.lastElementChild.textContent = txt;
}
function startPeer() {
  if (typeof Peer === 'undefined') { setPeerStatus('PeerJS nicht geladen (Internet?)', false); return; }
  setPeerStatus('Verbinde …', 'warn');
  peer = new Peer(PEER_PREFIX + room, PEER_OPTS);
  peer.on('open', () => setPeerStatus('Online', true));
  peer.on('connection', onConn);
  peer.on('disconnected', () => { setPeerStatus('Signal-Server getrennt – neu verbinden …', 'warn'); setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 1500); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { setPeerStatus('Raum-ID noch belegt, neuer Versuch …', 'warn'); peer.destroy(); setTimeout(startPeer, 4000); }
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { setPeerStatus('Netzwerkfehler – neuer Versuch …', 'warn'); }
    else console.warn('peer error', e.type, e);
  });
}
function onConn(conn) {
  let cid = null;
  conn.on('data', m => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { const t1 = performance.now(); conn.send({ t: 'pong', id: m.id, t0: m.t0, t1, t2: performance.now() }); return; }
    const c = cid && clients.get(cid);
    if (m.t === 'hello') {
      cid = String(m.cid || conn.peer);
      const old = clients.get(cid);
      if (old && old.conn !== conn) try { old.conn.close(); } catch (e) {}
      clients.set(cid, { conn, cid, team: m.team === 1 ? 1 : 0, name: '', rttMin: null, rttMed: null, err: null, seen: Date.now() });
      sendWelcome(clients.get(cid));
      renderClients(); return;
    }
    if (!c) return;
    c.seen = Date.now();
    if (m.t === 'sync') { c.rttMin = m.rttMin; c.rttMed = m.rttMed; c.err = m.err; renderClients(); }
    if (m.t === 'buzz') onBuzz(c, m);
    if (m.t === 'false') onFalseStart(c, m);
  });
  conn.on('close', () => { if (cid && clients.get(cid)?.conn === conn) { clients.delete(cid); renderClients(); } });
  conn.on('error', () => {});
}
function sendWelcome(c) { try { c.conn.send({ t: 'welcome', team: c.team, teamName: S.teams[c.team], teams: S.teams }); } catch (e) {} }
function broadcast(m) { for (const c of clients.values()) { try { c.conn.send(m); } catch (e) {} } }
setInterval(() => { // drop stale
  for (const [k, c] of clients) if (Date.now() - c.seen > 8000) { clients.delete(k); try { c.conn.close(); } catch (e) {} }
  renderClients();
}, 2000);

// ======================= Fair buzzing =======================
// Each phone keeps a clock offset to this laptop (NTP-style, min-RTT filtered).
// "Freigeben" schedules GO at a common future instant (host clock). Every phone turns green at
// that same real-world moment and measures the reaction time from its *own* GO display to the
// touch event. The fastest reaction wins – network latency only has to be smaller than the lead
// time, it never decides the winner.
let armSeq = 0, armState = null, goSoundTimer = null;
function arm() {
  if (S.q && !S.qShown) { S.qShown = true; save(); renderAll(); } // question appears on the board only once buzzers are released
  const cl = [...clients.values()];
  if (!cl.length) { alert('Kein Buzzer verbunden.'); return; }
  disarm(true);
  const maxRtt = Math.max(60, ...cl.map(c => c.rttMed || 250));
  const minLead = maxRtt * 1.5 + 200;
  const lead = settings.armMode === 'random' ? Math.max(minLead, 1000 + Math.random() * 1500) : Math.max(minLead, 450);
  const goHost = performance.now() + lead;
  armState = { id: ++armSeq, goHost, expected: new Set(cl.map(c => c.cid)), buzzes: [], decided: false, timer: null, maxRtt, falses: [] };
  broadcast({ t: 'arm', id: armState.id, goHost, penaltyMs: settings.penaltyMs });
  boardEvent({ ev: 'arm', goEpoch: performance.timeOrigin + goHost });
  Snd.ready();
  goSoundTimer = setTimeout(() => Snd.go(), lead);
  $('#buzzRes').textContent = 'Warte auf LOS …';
  if (S.buzz) { S.buzz = null; save(); renderAll(); }
}
function disarm(silent) {
  clearTimeout(goSoundTimer);
  if (armState) { clearTimeout(armState.timer); if (!armState.decided) { broadcast({ t: 'disarm' }); boardEvent({ ev: 'disarm' }); } }
  armState = null;
  if (!silent) $('#buzzRes').textContent = 'Buzzer gesperrt';
}
function onFalseStart(c, m) {
  if (!armState || m.id !== armState.id) return;
  armState.falses.push(c.cid);
  $('#buzzRes').textContent = `Fehlstart: ${S.teams[c.team]}`;
  Snd.bad();
}
function onBuzz(c, m) {
  const A = armState;
  if (!A || m.id !== A.id || A.buzzes.some(b => b.cid === c.cid)) return;
  const rt = Number(m.rt);
  if (!isFinite(rt) || rt < 0) return;
  // sanity check: press time in host clock vs scheduled GO
  const drift = (m.pressHost - A.goHost) - rt;
  A.buzzes.push({ cid: c.cid, team: c.team, rt, drift, late: m.late || 0 });
  if (!A.decided) {
    const allIn = [...A.expected].every(id => A.buzzes.some(b => b.cid === id) || !clients.has(id));
    if (allIn) decide();
    else if (A.buzzes.length === 1) {
      const win = Math.min(1000, Math.max(250, A.maxRtt * 2 + 150));
      A.timer = setTimeout(decide, win);
    }
  } else if (rt < A.winner.rt) {
    decide(true); // late packet but faster -> correct the result
  } else showBuzzTimes();
}
function decide(corrected) {
  const A = armState; if (!A || !A.buzzes.length) return;
  clearTimeout(A.timer);
  A.buzzes.sort((a, b) => a.rt - b.rt);
  const w = A.buzzes[0], second = A.buzzes[1];
  A.decided = true; A.winner = w;
  const detail = `${fmtMs(w.rt)}` + (second ? ` · ${Math.round(second.rt - w.rt)} ms vor ${S.teams[second.team]}` : '');
  S.buzz = { team: w.team, name: S.teams[w.team], rt: w.rt };
  save(); renderAll();
  boardEvent({ ev: 'buzz', team: w.team, name: (corrected ? '(Korrektur) ' : '') + S.teams[w.team], detail });
  Snd.buzz();
  broadcast({ t: 'result', id: A.id, winner: w.cid, winnerTeam: w.team, winnerName: S.teams[w.team], list: A.buzzes.map(b => ({ cid: b.cid, team: b.team, rt: b.rt })) });
  showBuzzTimes(corrected);
}
function showBuzzTimes(corrected) {
  const A = armState; if (!A) return;
  const parts = A.buzzes.map((b, i) => `${i === 0 ? '⚡ ' : ''}${esc(S.teams[b.team])}: ${fmtMs(b.rt)}${Math.abs(b.drift) > 120 ? ' <span title="Uhr-Abweichung – Sync prüfen" style="color:orange">⚠</span>' : ''}`);
  A.falses.forEach(id => { const c = clients.get(id); if (c) parts.push(`<span style="color:orange">Fehlstart ${esc(S.teams[c.team])}</span>`); });
  $('#buzzRes').innerHTML = (corrected ? '<b style="color:orange">Korrigiert!</b> ' : '') + parts.join(' &nbsp;|&nbsp; ');
}

// ======================= Rendering =======================
let peekActive = false;
function renderAll() {
  board.render(S);
  if (bc) bc.postMessage({ type: 'state', s: S });
  const popped = isPopped();
  $('#host').classList.toggle('popped', popped);
  $('#btnPop').textContent = popped ? '🖥 Board-Fenster offen' : '🖥 Board-Fenster';
  const show = peekActive || settings.peekAlways || popped;
  $('#answers').innerHTML = (S.answers.length ? S.answers : []).map((a, i) =>
    `<button class="st${a.st}" data-i="${i}"><span class="txt">${i + 1}. ${show || a.st ? esc(a.a) : '<span class="veil">●●●●●●</span>'}</span><b>${show || a.st ? a.p : ''}</b></button>`).join('')
    || '<span class="muted">Noch keine Frage – „Neue Frage“ drücken.</span>';
  $('#gmQ').textContent = S.q ? S.q.text : '–';
  $('#btnPeek').classList.toggle('active', peekActive);
  const ph = S.phase, act = ACTIVE.includes(ph);
  $('#btnCtrlA').textContent = `${S.teams[0]} spielt`; $('#btnCtrlB').textContent = `${S.teams[1]} spielt`;
  $('#btnAwardA').textContent = `Punkte → ${S.teams[0]}`; $('#btnAwardB').textContent = `Punkte → ${S.teams[1]}`;
  $('#btnCtrlA').disabled = $('#btnCtrlB').disabled = !(ph === 'faceoff' || ph === 'play');
  $('#btnStealOk').disabled = $('#btnStealFail').disabled = ph !== 'steal';
  $('#btnAwardA').disabled = $('#btnAwardB').disabled = !act;
  $('#btnStrike').disabled = !act;
  $('#btnSkip').disabled = !S.q || ph === 'done' || ph === 'over';
  $('#btnRest').disabled = !S.answers.some(a => !a.st);
  $('#btnUndo').disabled = !undoStack.length;
  $('#mult').value = String(S.mult);
  $('#qInfo').textContent = S.q ? `Runde ${S.round} · ${S.q.topic} · ${TONES[S.q.tone] || ''} · noch ${pool().length} Fragen` : `${pool().length} Fragen verfügbar`;
}
function renderClients() {
  const html = [...clients.values()].sort((a, b) => a.team - b.team).map(c => {
    const ok = c.rttMed != null;
    const col = c.team === 0 ? 'var(--teamA)' : 'var(--teamB)';
    return `<span class="conn ${ok ? (c.err > 40 ? 'warn' : 'on') : 'warn'}" title="Ping (Median) / Sync-Genauigkeit"><span class="dot"></span><b style="color:${col}">${esc(S.teams[c.team])}</b> ${ok ? `${Math.round(c.rttMed)} ms · ±${Math.max(1, Math.round(c.err))} ms` : 'synchronisiere …'}</span>`;
  }).join(' ');
  $('#clients').innerHTML = html || '<span class="muted">Keine Buzzer verbunden</span>';
}

// ======================= Modals =======================
function openModal(id) { $(id).classList.remove('hidden'); }
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.hasAttribute('data-close')) { m.classList.add('hidden'); renderAll(); } }));

function buzzerUrl(team) {
  const u = new URL('buzzer.html', location.href); u.search = `?room=${room}&team=${team}`; return u.href;
}
$('#btnQR').onclick = () => {
  $('#qrRoom').textContent = room;
  for (const [t, k] of [[0, 'A'], [1, 'B']]) {
    const url = buzzerUrl(t); const box = $('#qr' + k); box.innerHTML = '';
    $('#qrUrl' + k).textContent = url; $('#qrName' + k).textContent = S.teams[t];
    if (typeof QRCode !== 'undefined') new QRCode(box, { text: url, width: 220, height: 220 });
    else box.innerHTML = '<p class="muted">(QR-Bibliothek nicht geladen – Link abtippen)</p>';
  }
  openModal('#mQR');
};

$('#btnSettings').onclick = () => {
  $('#teamA').value = S.teams[0]; $('#teamB').value = S.teams[1];
  document.querySelectorAll('input[name=armMode]').forEach(r => r.checked = r.value === settings.armMode);
  $('#penalty').value = settings.penaltyMs; $('#showQ').checked = settings.showQ; $('#peekAlways').checked = settings.peekAlways;
  openModal('#mSettings');
};
function applySettings() {
  const tA = $('#teamA').value.trim() || 'Team A', tB = $('#teamB').value.trim() || 'Team B';
  settings.teams = [tA, tB];
  settings.armMode = document.querySelector('input[name=armMode]:checked')?.value || 'random';
  settings.penaltyMs = Math.max(0, parseInt($('#penalty').value, 10) || 0);
  settings.showQ = $('#showQ').checked; settings.peekAlways = $('#peekAlways').checked;
  saveSettings();
  S.teams = [tA, tB]; S.showQ = settings.showQ; save(); renderAll(); renderClients();
  for (const c of clients.values()) sendWelcome(c);
}
['#teamA', '#teamB', '#penalty', '#showQ', '#peekAlways'].forEach(id => $(id).addEventListener('change', applySettings));
document.querySelectorAll('input[name=armMode]').forEach(r => r.addEventListener('change', applySettings));
$('#btnNewGame').onclick = () => { if (confirm('Neues Spiel starten? Punkte werden auf 0 gesetzt (gespielte Fragen bleiben gesperrt).')) { undoStack = []; S = newGame(); save(); renderAll(); $('#mSettings').classList.add('hidden'); } };
$('#btnNewRoom').onclick = () => {
  if (!confirm('Neuen Raumcode erzeugen? Die Buzzer müssen sich danach neu verbinden.')) return;
  room = genRoom(); store(LS.room, room); $('#room').textContent = room;
  for (const c of clients.values()) try { c.conn.close(); } catch (e) {}
  clients.clear(); if (peer) peer.destroy(); startPeer(); renderClients();
};

function renderQuestions() {
  const avail = pool().length;
  $('#poolInfo').innerHTML = `<b>${avail}</b> von ${Q.length} Fragen verfügbar (gefiltert, noch nicht gespielt).`;
  $('#toneChips').innerHTML = Object.entries(TONES).map(([k, l]) => {
    const tot = Q.filter(q => q.tone === k).length, left = Q.filter(q => q.tone === k && !played[q.id]).length;
    return `<label class="chip"><input type="checkbox" data-tone="${k}" ${settings.tones[k] !== false ? 'checked' : ''}> ${l} <small>${left}/${tot}</small></label>`;
  }).join('');
  const topics = [...new Set(Q.map(q => q.topic))].sort((a, b) => a.localeCompare(b, 'de'));
  $('#topicChips').innerHTML = topics.map(t => {
    const tot = Q.filter(q => q.topic === t).length, left = Q.filter(q => q.topic === t && !played[q.id]).length;
    return `<label class="chip"><input type="checkbox" data-topic="${esc(t)}" ${settings.topicsOff[t] ? '' : 'checked'}> ${esc(t)} <small>${left}/${tot}</small></label>`;
  }).join('');
  const byId = new Map(Q.map(q => [q.id, q]));
  const list = Object.entries(played).filter(([id]) => byId.has(id)).sort((a, b) => b[1].t - a[1].t);
  $('#playedList').innerHTML = list.length ? list.map(([id, p]) => {
    const q = byId.get(id);
    return `<div class="qitem"><span class="tag ${p.how}">${p.how === 'skipped' ? 'übersprungen' : 'gespielt'}</span><span class="t">${esc(q.q)}</span><span class="tag">${esc(q.topic)}</span><button data-reset="${id}">Zurücksetzen</button></div>`;
  }).join('') : '<p class="muted">Noch keine Fragen gespielt.</p>';
}
$('#btnQuestions').onclick = () => { renderQuestions(); openModal('#mQuestions'); };
$('#mQuestions').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.tone) settings.tones[t.dataset.tone] = t.checked;
  if (t.dataset.topic) { if (t.checked) delete settings.topicsOff[t.dataset.topic]; else settings.topicsOff[t.dataset.topic] = true; }
  saveSettings(); renderQuestions(); renderAll();
});
$('#mQuestions').addEventListener('click', e => {
  const id = e.target.dataset?.reset;
  if (id) { delete played[id]; savePlayed(); renderQuestions(); renderAll(); }
});
$('#topicsAll').onclick = () => { settings.topicsOff = {}; saveSettings(); renderQuestions(); renderAll(); };
$('#topicsNone').onclick = () => { Q.forEach(q => settings.topicsOff[q.topic] = true); saveSettings(); renderQuestions(); renderAll(); };
$('#resetSkipped').onclick = () => { for (const k in played) if (played[k].how === 'skipped') delete played[k]; savePlayed(); renderQuestions(); renderAll(); };
$('#resetAll').onclick = () => { if (confirm('Wirklich ALLE gespielten Fragen wieder freigeben?')) { played = {}; savePlayed(); renderQuestions(); renderAll(); } };

// ======================= Controls & keys =======================
$('#btnNext').onclick = () => nextQuestion();
$('#btnSkip').onclick = skipQuestion;
$('#mult').onchange = e => act(() => { S.mult = parseInt(e.target.value, 10) || 1; });
$('#btnUndo').onclick = undo;
$('#btnArm').onclick = arm;
$('#btnDisarm').onclick = () => disarm();
$('#btnStrike').onclick = strike;
$('#btnCtrlA').onclick = () => setControl(0);
$('#btnCtrlB').onclick = () => setControl(1);
$('#btnStealOk').onclick = () => stealResult(true);
$('#btnStealFail').onclick = () => stealResult(false);
$('#btnAwardA').onclick = () => manualAward(0);
$('#btnAwardB').onclick = () => manualAward(1);
$('#btnRest').onclick = revealRest;
$('#btnScore').onclick = correctScore;
$('#btnEnd').onclick = endGame;
$('#answers').onclick = e => { const b = e.target.closest('button[data-i]'); if (b) reveal(+b.dataset.i); };
const setPeek = v => { if (peekActive !== v) { peekActive = v; renderAll(); } };
$('#btnPeek').addEventListener('pointerdown', () => setPeek(true));
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => $('#btnPeek').addEventListener(t, () => setPeek(false)));
$('#btnPop').onclick = () => window.open('board.html', 'fdboard', 'popup,width=1280,height=720');
$('#btnFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); };
document.addEventListener('pointerdown', Snd.unlock, { once: true });

document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') { setPeek(true); return; }
  if (e.repeat) return;
  if (k === ' ') { e.preventDefault(); arm(); }
  else if (k === 'escape') disarm();
  else if (k >= '1' && k <= '8') reveal(+k - 1);
  else if (k === 'x') strike();
  else if (k === 'n') nextQuestion();
  else if (k === 's') skipQuestion();
  else if (k === 'z') undo();
});
document.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'h') setPeek(false); });
window.addEventListener('blur', () => setPeek(false));

// ======================= Boot =======================
$('#room').textContent = room;
renderAll(); renderClients();
Promise.resolve(window.__QUESTIONS).then(list => {
  Q = list.map(q => Object.assign({ id: qid(q.q) }, q));
  renderAll();
}).catch(e => alert('questions.json konnte nicht geladen werden: ' + e));
startPeer();
