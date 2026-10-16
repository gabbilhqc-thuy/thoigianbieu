// Alarm + sound. Web version: works while the page is open (iPad on a stand, screen kept on).
// When moving to a native iOS app, replace this module with local notifications.

let ctx;
let wakeLock;
let viVoice;

export function unlockAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Safari 16.4+: let sound play even when the device is in silent mode.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    // iOS only allows speech after it has been used once inside a tap.
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(' '));
  }
  return ctx.resume();
}

export const audioReady = () => !!ctx && ctx.state === 'running';

function tone(freq, at, len, vol) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + len + 0.05);
}

// Bell for "time to start" — rising, plays twice, ~1.6s total.
export function chime() {
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.05;
  [0, 0.8].forEach(off => [784, 988, 1175, 1568].forEach((f, i) => tone(f, t0 + off + i * 0.15, 0.5, 0.3)));
}

// Bell for "time is up" — falling, so it sounds different from the start bell.
export function chimeEnd() {
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.05;
  [0, 0.9].forEach(off => [1568, 1175, 988, 784].forEach((f, i) => tone(f, t0 + off + i * 0.18, 0.55, 0.3)));
}

// Single soft ding for "5 minutes to go".
export function ding() {
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.05;
  tone(1047, t0, 0.8, 0.2);
  tone(1319, t0 + 0.25, 0.9, 0.2);
}

// Short happy arpeggio when a task is ticked.
export function cheer() {
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.02;
  [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t0 + i * 0.08, 0.35, 0.25));
}

export async function playVoice(audio) {
  if (!ctx || !audio) return;
  const buffer = await ctx.decodeAudioData(audio.buf.slice(0));
  return new Promise(resolve => {
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = 1.5; // kids record quietly
    src.buffer = buffer;
    src.connect(g).connect(ctx.destination);
    src.onended = resolve;
    src.start();
  });
}

if ('speechSynthesis' in window) {
  const pick = () => { viVoice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith('vi')); };
  pick();
  speechSynthesis.onvoiceschanged = pick;
}

export function hasViVoice() {
  if (!viVoice && 'speechSynthesis' in window) {
    viVoice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith('vi'));
  }
  return !!viVoice;
}

// Reads text aloud with a Vietnamese voice (iPad has one built in).
// Without one it stays silent: an English voice reading Vietnamese is just noise.
export function speak(text) {
  return new Promise(resolve => {
    if (!text || !hasViVoice()) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    u.voice = viVoice;
    u.rate = 0.9;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
    setTimeout(resolve, 8000); // some browsers never fire onend
  });
}

export async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Not supported: rely on iPad setting Auto-Lock = Never.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ctx) ctx.resume();
  if (wakeLock !== undefined) keepAwake();
});

const toMin = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Polls the real clock and calls onEvent(type, task) when the clock passes one of a task's moments:
//   'soon'   — 5 minutes before the start time
//   'start'  — at the start time
//   'remind' — every 5 minutes after the start while the child has not pressed "start"
//   'end'    — when the time is up
// Only minutes the clock actually moved through since the previous poll count, so editing a task
// to a time that has already passed does not ring. After a pause (screen off) look back at most 2 minutes.
// getDue() returns today's approved tasks that are not done yet.
export function start(getDue, isStarted, onEvent, todayKey) {
  let lastMin = null;
  let lastKey = null;
  const check = () => {
    const n = new Date();
    const m = n.getHours() * 60 + n.getMinutes();
    const key = todayKey();
    const from = lastMin === null || key !== lastKey ? m - 1 : Math.max(lastMin, m - 2);
    lastMin = m;
    lastKey = key;
    if (from >= m) return;
    const passed = x => x > from && x <= m;
    for (const t of getDue()) {
      const s = toMin(t.start);
      const e = s + t.dur;
      if (passed(s - 5)) onEvent('soon', t);
      if (passed(s)) onEvent('start', t);
      if (passed(e)) onEvent('end', t);
      for (let r = s + 5; r < e; r += 5) {
        if (passed(r) && !isStarted(t)) onEvent('remind', t);
      }
    }
  };
  check();
  setInterval(check, 5000);
}
