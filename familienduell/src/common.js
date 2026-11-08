// Shared helpers: sound, ids, board renderer
'use strict';

const PEER_PREFIX = 'familienduell-v1-';
// PeerJS options. Default uses the free PeerJS cloud broker + Google STUN.
const PEER_OPTS = {
  debug: 1,
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ] },
};

const Snd = (() => {
  let ctx;
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type = 'sine', vol = 0.3, when = 0, slide = null) {
    const c = ac(), t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  return {
    unlock: () => { try { ac(); } catch (e) {} },
    ding() { tone(880, 0.7, 'sine', 0.35); tone(1318, 0.9, 'sine', 0.2, 0.09); },
    strike() { tone(98, 0.8, 'sawtooth', 0.4); tone(104, 0.8, 'square', 0.18); },
    buzz() { tone(523, 0.12, 'square', 0.25); tone(784, 0.35, 'square', 0.25, 0.12); },
    go() { tone(1046, 0.15, 'sine', 0.35); },
    ready() { tone(660, 0.08, 'sine', 0.2); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, 'triangle', 0.3, i * 0.12)); },
    bad() { tone(200, 0.25, 'square', 0.2, 0, 120); },
  };
})();

// Stable id for a question (FNV-1a of its text)
function qid(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const fmtMs = ms => (ms / 1000).toFixed(3).replace('.', ',') + ' s';

function bankOf(s) {
  if (!s.answers || s.award) return 0;
  return s.answers.reduce((t, a) => t + (a.st === 1 ? a.p : 0), 0) * (s.mult || 1);
}

// ---------- Board renderer (used in host page and pop-out window) ----------
function createBoard(root) {
  root.innerHTML = `
  <div class="board">
    <div class="b-top">
      <div class="b-score A"><div class="name"></div><div class="pts">0</div></div>
      <div class="b-bank"><div class="lbl">PUNKTE</div><div class="pts">0</div><div class="mult"></div></div>
      <div class="b-score B"><div class="name"></div><div class="pts">0</div></div>
    </div>
    <div class="b-question"></div>
    <div class="b-status"></div>
    <div class="b-grid"></div>
    <div class="b-strikes"></div>
    <div class="b-overlay"><div class="big"></div><div class="small"></div></div>
    <button class="b-histbtn" title="Verlauf (V)">📜 Verlauf</button>
    <div class="b-history"><div class="h-head"></div><div class="h-list"></div><div class="h-hint">V oder Klick zum Schließen</div></div>
  </div>`;
  const el = {
    sA: $('.b-score.A', root), sB: $('.b-score.B', root),
    bank: $('.b-bank .pts', root), mult: $('.b-bank .mult', root),
    q: $('.b-question', root), status: $('.b-status', root), grid: $('.b-grid', root),
    strikes: $('.b-strikes', root), ov: $('.b-overlay', root),
    ovBig: $('.b-overlay .big', root), ovSmall: $('.b-overlay .small', root),
    hist: $('.b-history', root), histBtn: $('.b-histbtn', root), hHead: $('.b-history .h-head', root), hList: $('.b-history .h-list', root),
  };
  const tiles = [];
  for (let i = 0; i < 8; i++) {
    const t = document.createElement('div');
    t.className = 'tile empty';
    t.innerHTML = `<div class="inner"><div class="face front"><div class="num">${i + 1}</div></div><div class="face back"><span class="ans"></span><span class="p"></span></div></div>`;
    el.grid.appendChild(t); tiles.push(t);
  }
  let ovTimer = null, strikeTimer = null, goTimer = null, lastQ = null;

  function overlay(big, small = '', color = '#fff', ms = 2200, tint = null) {
    clearTimeout(ovTimer);
    el.ov.style.background = tint ? `color-mix(in srgb, ${tint} 40%, #000)` : '';
    el.ovBig.textContent = big; el.ovBig.style.color = color; el.ovSmall.textContent = small;
    el.ov.classList.add('show');
    if (ms) ovTimer = setTimeout(() => el.ov.classList.remove('show'), ms);
  }
  function hideOverlay() { clearTimeout(ovTimer); el.ov.classList.remove('show'); }

  let lastS = null;
  function renderHistory(s) {
    const col = t => (t === 0 ? 'var(--teamA)' : 'var(--teamB)');
    el.hHead.innerHTML = `<span style="color:var(--teamA)">${esc(s.teams[0])} ${s.scores[0]}</span> : <span style="color:var(--teamB)">${s.scores[1]} ${esc(s.teams[1])}</span>`;
    const h = s.history || [];
    el.hList.innerHTML = h.length ? h.map(e => `<div class="h-row"><span class="h-n">${e.round}</span><span class="h-q">${esc(e.q)}</span>` +
      (e.skipped ? '<span class="h-p muted">übersprungen</span>' : `<span class="h-p" style="color:${col(e.team)}">${e.pts ? '+' + e.pts : '0'} · ${esc(s.teams[e.team])}</span>`) + '</div>').reverse().join('')
      : '<div class="h-empty">Noch keine Runde gespielt.</div>';
  }
  function toggleHistory() { el.hist.classList.toggle('show'); if (lastS) renderHistory(lastS); }
  el.histBtn.addEventListener('click', toggleHistory);
  el.hist.addEventListener('click', toggleHistory);
  document.addEventListener('keydown', e => {
    if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) toggleHistory();
  });

  function render(s) {
    lastS = s; if (el.hist.classList.contains('show')) renderHistory(s);
    document.body.dataset.win = s.phase === 'faceoff' && s.buzz ? String(s.buzz.team) : '';
    const teamCol = t => (t === 0 ? 'var(--teamA)' : 'var(--teamB)');
    $('.name', el.sA).textContent = s.teams[0]; $('.pts', el.sA).textContent = s.scores[0];
    $('.name', el.sB).textContent = s.teams[1]; $('.pts', el.sB).textContent = s.scores[1];
    const activeTeam = s.phase === 'play' ? s.control : s.phase === 'steal' ? 1 - s.control : null;
    el.sA.classList.toggle('active', activeTeam === 0);
    el.sB.classList.toggle('active', activeTeam === 1);
    el.bank.textContent = bankOf(s);
    el.mult.textContent = s.phase === 'idle' || s.phase === 'over' ? '' : `Runde ${s.round}${s.mult > 1 ? ' · ' + s.mult + '-fache Punkte' : ''}`;

    if (s.phase === 'idle' || !s.q) {
      el.q.innerHTML = '<div class="b-logo">FAMILIEN-DUELL</div>';
    } else {
      el.q.textContent = s.showQ && s.qShown ? s.q.text : '';
    }
    let st = '';
    const tn = t => esc(s.teams[t]);
    if (s.phase === 'faceoff') st = s.buzz ? `⚡ <span style="color:${teamCol(s.buzz.team)}">${esc(s.buzz.name)}</span> war schneller!` : 'Face-Off!';
    if (s.phase === 'play') st = `<span style="color:${teamCol(s.control)}">${tn(s.control)}</span> spielt <span class="b-mini-strikes">${[1, 2, 3].map(n => `<i class="${s.strikes >= n ? 'on' : ''}">✕</i>`).join('')}</span>`;
    if (s.phase === 'steal') st = `<span style="color:${teamCol(1 - s.control)}">${tn(1 - s.control)}</span> darf klauen!`;
    if (s.phase === 'done' && s.award) st = s.award.pts ? `+${s.award.pts} Punkte für <span style="color:${teamCol(s.award.team)}">${tn(s.award.team)}</span>` : 'Runde beendet';
    el.status.innerHTML = st;

    const ans = s.answers || [];
    const qChanged = lastQ !== (s.q && s.q.id);
    lastQ = s.q && s.q.id;
    tiles.forEach((t, i) => {
      const a = ans[i];
      t.className = 'tile' + (!a ? ' empty' : '') + (a && a.st ? ' open' : '') + (a && a.st === 2 ? ' free' : '');
      $('.ans', t).textContent = a ? a.a : '';
      $('.p', t).textContent = a ? a.p : '';
    });
    if (s.phase === 'over') {
      const w = s.scores[0] === s.scores[1] ? null : s.scores[0] > s.scores[1] ? 0 : 1;
      overlay(w === null ? 'UNENTSCHIEDEN!' : `${s.teams[w]} GEWINNT!`, `${s.scores[0]} : ${s.scores[1]}`, w === null ? '#fff' : (w === 0 ? 'var(--teamA)' : 'var(--teamB)'), 0);
    } else if (el.ovBig.textContent.endsWith('GEWINNT!') || el.ovBig.textContent === 'UNENTSCHIEDEN!') hideOverlay();
  }

  function event(ev, s) {
    if (ev.ev === 'strike') {
      clearTimeout(strikeTimer);
      el.strikes.innerHTML = '<span>✕</span>'.repeat(Math.max(1, Math.min(3, ev.n || 1)));
      el.strikes.classList.add('show');
      strikeTimer = setTimeout(() => el.strikes.classList.remove('show'), 1300);
    }
    if (ev.ev === 'arm') {
      clearTimeout(goTimer);
      const goLocal = ev.goEpoch - performance.timeOrigin;
      hideOverlay();
      const tick = () => {
        if (performance.now() >= goLocal) { overlay('LOS!', '', 'var(--ok)', 900); return; }
        goTimer = requestAnimationFrame(tick);
      };
      goTimer = requestAnimationFrame(tick);
    }
    if (ev.ev === 'disarm') { cancelAnimationFrame(goTimer); hideOverlay(); }
    if (ev.ev === 'buzz') {
      cancelAnimationFrame(goTimer);
      const col = ev.team === 0 ? 'var(--teamA)' : 'var(--teamB)';
      overlay(ev.name, `${s ? s.teams[ev.team] : ''}${ev.detail ? ' · ' + ev.detail : ''}`, col, 2600, col);
    }
  }
  return { render, event, overlay, hideOverlay };
}
