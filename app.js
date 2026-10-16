import * as store from './storage.js';
import * as alarm from './alarm.js';

const EMOJIS = ['🪥', '🛁', '🍚', '🥛', '😴', '🚽', '👕', '🧹', '📚', '✏️', '🎨', '🎹', '🧸', '🏃', '📺', '🚗'];
const GOAL_EMOJIS = ['🎡', '🍦', '🧸', '🎮', '📺', '🍕', '🏊', '🎁'];
const MOODS = ['😀', '😐', '😢'];
const DAY_LABELS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const WEEKDAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

let tasks = [];
let doneMap = new Map(); // `${date}|${taskId}` -> { at, mood }
let startMap = new Map(); // `${date}|${taskId}` -> time the child pressed "start"
let offSet = new Set(); // days off: no alarms, not scored
let goal = null; // { key: 'goal', emoji, name, target, since }
let weekMsgs = new Map(); // meta key `week:<monday>` -> { key, text, audio }
let praiseList = []; // parents' recorded praise clips
let rewards = []; // rewards handed over: { emoji, name, target, at }

let wizard = null; // add-task wizard state
let alarmTask = null; // task shown in the alarm overlay
let alarmType = null; // 'start' | 'remind' | 'end'
let focusTask = null; // task shown full screen while the child works on it
let doneSheet = null; // { t, key, photo } after ticking: mood + photo
let parentWeek = 0; // week offset in parent stats / weekly praise
let reportWeek = 0; // week offset in the child's report
let photoDay = null; // day shown in the parent's photo section
let goalEmoji = GOAL_EMOJIS[0];
let lastHomeSig = '';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- date / time helpers ----------
const pad = n => String(n).padStart(2, '0');
const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const todayKey = () => dkey(new Date());
const wd = d => d.getDay() || 7; // Mon=1..Sun=7
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const toMin = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fmt = min => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const nowMin = () => {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60;
};
const minOfDay = ts => {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
};
const shortDay = k => `${fromKey(k).getDate()}/${fromKey(k).getMonth() + 1}`;

// ---------- task logic ----------
function applies(t, key) {
  if (offSet.has(key)) return false;
  if (t.deleted && key >= t.deleted) return false;
  if (t.date) return t.date === key;
  return key >= t.created && t.days.includes(wd(fromKey(key)));
}

const byStart = (a, b) => toMin(a.start) - toMin(b.start);
// Tasks the child added stay "pending" until a parent approves them: shown faded, no alarm, not scored.
const tasksOn = key => tasks.filter(t => !t.pending && applies(t, key)).sort(byStart);
const pendingOn = key => tasks.filter(t => t.pending && applies(t, key));
const isDone = (key, t) => doneMap.has(`${key}|${t.id}`);
const isStarted = (key, t) => startMap.has(`${key}|${t.id}`);

function dayStats(key) {
  const list = tasksOn(key);
  return { done: list.filter(t => isDone(key, t)).length, total: list.length };
}

const pct = s => (s.total ? Math.round((s.done * 100) / s.total) : 0);

function weekKeys(offset, base = new Date()) {
  const mon = addDays(base, -(wd(base) - 1) + offset * 7);
  return [...Array(7)].map((_, i) => dkey(addDays(mon, i)));
}

const weekRange = keys => `${shortDay(keys[0])} – ${shortDay(keys[6])}`;

// Week total counts only days up to today, so mid-week % is not dragged down by future days.
function weekStats(offset) {
  const tk = todayKey();
  return weekKeys(offset)
    .filter(k => k <= tk)
    .reduce((acc, k) => {
      const s = dayStats(k);
      return { done: acc.done + s.done, total: acc.total + s.total };
    }, { done: 0, total: 0 });
}

// Stars earned since the current reward goal was set.
function goalStars() {
  if (!goal) return 0;
  let n = 0;
  for (const r of doneMap.values()) if (r.at >= goal.since) n++;
  return n;
}

// Fraction of time left if the task is running now, else null.
function remaining(t) {
  const s = toMin(t.start);
  const n = nowMin();
  return n >= s && n < s + t.dur ? 1 - (n - s) / t.dur : null;
}

function leftText(t) {
  const left = toMin(t.start) + t.dur - nowMin();
  return left > 0 ? `Còn ${Math.ceil(left)} phút` : 'Hết giờ rồi';
}

const pieStyle = f => `background: conic-gradient(var(--orange) ${Math.round(f * 360)}deg, var(--pie-bg) 0)`;

async function load() {
  tasks = await store.getTasks();
  doneMap = new Map((await store.getDone()).map(d => [d.key, d]));
  startMap = new Map((await store.getStarts()).map(s => [s.key, s.at]));
  const meta = await store.getAllMeta();
  goal = meta.find(m => m.key === 'goal') || null;
  offSet = new Set(meta.find(m => m.key === 'off')?.dates || []);
  weekMsgs = new Map(meta.filter(m => m.key.startsWith('week:')).map(m => [m.key, m]));
  rewards = meta.find(m => m.key === 'rewards')?.list || [];
  praiseList = await store.getPraise();
}

// Voice recording if there is one, otherwise read the typed name aloud.
const announce = t => (t.audio ? alarm.playVoice(t.audio) : alarm.speak(t.name));
const canAnnounce = t => !!(t.audio || t.name);

// "Đã đến giờ" / "Sắp đến giờ" + the task: typed names in one sentence, recordings after the lead-in.
async function announceWith(lead, t) {
  if (t.audio || !t.name) {
    await alarm.speak(lead);
    await announce(t);
  } else {
    await alarm.speak(`${lead} ${t.name}`);
  }
}

// ---------- weekly report (positive highlights only) ----------
// "On time" = pressed start within 5 minutes of the start time, or finished within the time slot.
function onTime(key, t) {
  const s = toMin(t.start);
  const st = startMap.get(`${key}|${t.id}`);
  const d = doneMap.get(`${key}|${t.id}`);
  return (st !== undefined && minOfDay(st) <= s + 5) || (!!d && minOfDay(d.at) <= s + t.dur);
}

function taskLabel(t) {
  if (!t.name) return { text: `làm việc ${t.emoji}`, speech: 'làm việc này' };
  const n = t.name.charAt(0).toLowerCase() + t.name.slice(1);
  return { text: n, speech: n };
}

function weekHighlights(offset) {
  const tk = todayKey();
  const keys = weekKeys(offset).filter(k => k <= tk && !offSet.has(k));
  const out = [];
  const add = (icon, text, speech = text) => out.push({ icon, text, speech });

  for (const t of tasks.filter(x => !x.pending).sort(byStart)) {
    const days = keys.filter(k => applies(t, k));
    if (days.length < 2) continue;
    const l = taskLabel(t);
    let run = 0, best = 0, onRun = 0, onBest = 0, onTotal = 0;
    for (const k of days) {
      run = isDone(k, t) ? run + 1 : 0;
      best = Math.max(best, run);
      const ok = onTime(k, t);
      onTotal += ok ? 1 : 0;
      onRun = ok ? onRun + 1 : 0;
      onBest = Math.max(onBest, onRun);
    }
    if (onBest >= 3) add('⏰', `Con ${l.text} đúng giờ ${onBest} ngày liên tục!`, `Con ${l.speech} đúng giờ ${onBest} ngày liên tục`);
    else if (onTotal >= 3) add('⏰', `Con ${l.text} đúng giờ ${onTotal} lần.`, `Con ${l.speech} đúng giờ ${onTotal} lần`);
    if (best === days.length && best >= 3) add(t.emoji, `Con ${l.text} đủ ${best}/${days.length} ngày, không bỏ ngày nào!`, `Con ${l.speech} đủ ${best} ngày, không bỏ ngày nào`);
    else if (best >= 3) add(t.emoji, `Con ${l.text} liên tục ${best} ngày!`, `Con ${l.speech} liên tục ${best} ngày`);
  }

  const perfect = keys.filter(k => {
    const s = dayStats(k);
    return s.total && s.done === s.total;
  }).length;
  if (perfect) add('🌟', `Con làm xong hết việc trong ${perfect} ngày.`);
  const stars = keys.reduce((n, k) => n + dayStats(k).done, 0);
  if (stars) add('⭐', `Cả tuần con nhận được ${stars} ngôi sao.`);
  const keySet = new Set(keys);
  const happy = [...doneMap.entries()].filter(([k, r]) => keySet.has(k.split('|')[0]) && r.mood === '😀').length;
  if (happy >= 2) add('😀', `Con thấy vui khi làm việc ${happy} lần.`);
  if (!out.length) add('💪', 'Con đang tập thói quen mới. Tuần sau mình cùng cố gắng thêm nhé!');
  return out;
}

const weekMsg = monday => weekMsgs.get(`week:${monday}`) || { key: `week:${monday}`, text: '', audio: null };

// ---------- "Thành tích" tab (child): reward goal, prizes received, weekly report ----------
function awardsHtml() {
  const got = goal ? Math.min(goalStars(), goal.target) : 0;
  const left = goal ? goal.target - got : 0;
  return `
    <section class="aw-goal ${goal && left <= 0 ? 'reached' : ''}">
      <div class="aw-goal-emoji">${goal ? goal.emoji : '🎁'}</div>
      <div class="aw-goal-body">
        <h2>${goal ? esc(goal.name) : 'Chưa có phần thưởng'}</h2>
        ${goal ? `<div class="gbar"><i style="width:${Math.round((got * 100) / goal.target)}%"></i></div>` : ''}
        <p>${!goal ? 'Bố mẹ sẽ đặt phần thưởng cho con nhé.'
          : left > 0 ? `${got}/${goal.target} ⭐ · Còn ${left} ngôi sao nữa thôi!`
          : '🎉 Con đã đủ sao! Nhắc bố mẹ trao quà nhé!'}</p>
      </div>
    </section>
    <section class="aw-shelf">
      <h3>🎁 Quà con đã nhận <span class="muted">· ⭐ tổng cộng ${doneMap.size} ngôi sao</span></h3>
      ${rewards.length
        ? `<div class="shelf">${[...rewards].reverse().map(r => `
            <div class="prize"><span>${r.emoji}</span><b>${esc(r.name)}</b><small>${shortDay(dkey(new Date(r.at)))}</small></div>`).join('')}</div>`
        : '<p class="muted">Chưa có quà nào. Cố lên nhé con!</p>'}
    </section>
    ${reportHtml()}`;
}

function reportHtml() {
  const keys = weekKeys(reportWeek);
  const hl = weekHighlights(reportWeek);
  const msg = weekMsg(keys[0]);
  return `
    <section class="aw-week">
      <div class="rep-top">
        <button class="nav" data-act="rep-wk" data-d="-1" aria-label="Tuần trước">‹</button>
        <h2>🏆 Bảng vàng ${reportWeek ? 'tuần' : 'tuần này'} · ${weekRange(keys)}</h2>
        <button class="nav" data-act="rep-wk" data-d="1" ${reportWeek >= 0 ? 'disabled' : ''} aria-label="Tuần sau">›</button>
      </div>
      <div class="rep-hero">🎉 Bố mẹ ghi nhận những điều con đã làm được 🎉</div>
      <div class="hl-list">${hl.map(h => `<div class="hl"><span class="hl-icon">${h.icon}</span><p>${esc(h.text)}</p></div>`).join('')}</div>
      ${msg.text || msg.audio ? `
        <div class="parent-msg">
          <h3>💌 Bố mẹ tuyên dương con</h3>
          ${msg.text ? `<p>${esc(msg.text)}</p>` : ''}
          ${msg.audio ? '<button class="btn ghost" data-act="rep-msg-play">▶ Nghe bố mẹ nói</button>' : ''}
        </div>` : ''}
      <button class="btn big orange" data-act="rep-read">🔊 Đọc cho con nghe</button>
    </section>`;
}

async function readReport() {
  await alarm.unlockAudio();
  const keys = weekKeys(reportWeek);
  const msg = weekMsg(keys[0]);
  await alarm.speak(reportWeek ? 'Bảng vàng tuần' : 'Bảng vàng tuần này');
  for (const h of weekHighlights(reportWeek)) {
    if (!$('.aw-week')) return;
    await alarm.speak(h.speech);
  }
  if (msg.text && $('.aw-week')) await alarm.speak(`Bố mẹ muốn nói với con. ${msg.text}`);
  if (msg.audio && $('.aw-week')) await alarm.playVoice(msg.audio);
}

// ---------- home (child) ----------
let tab = 'schedule'; // 'schedule' | 'awards'
let viewKey = null; // day being viewed on home; null = today
let lastTouch = Date.now();
const shownKey = () => viewKey || todayKey();

function renderHome() {
  if (tab === 'awards') return renderAwards();
  const key = shownKey();
  const isToday = key === todayKey();
  const d = fromKey(key);
  const list = [...tasksOn(key), ...pendingOn(key)].sort(byStart);
  const s = dayStats(key);
  const waiting = tasks.filter(t => t.pending && !t.deleted).length;
  const empty = offSet.has(key)
    ? (isToday ? '🏖️ Hôm nay con được nghỉ!' : '🏖️ Ngày nghỉ')
    : (isToday ? 'Bấm ➕ để thêm việc nhé!' : 'Ngày này không có việc nào');
  lastHomeSig = homeSig();
  $('#app').innerHTML = `
    ${tabBar(waiting)}
    <header class="top">
      <button class="nav" data-act="day-nav" data-d="-1" aria-label="Ngày trước">‹</button>
      <div class="date ${isToday ? '' : 'other'}">${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}</div>
      <button class="nav" data-act="day-nav" data-d="1" aria-label="Ngày sau">›</button>
      ${isToday ? '' : '<button class="btn orange go-today" data-act="go-today">Hôm nay</button>'}
      <div class="today-stars">⭐ ${s.done}/${s.total}<span class="pct">${pct(s)}%</span></div>
    </header>
    ${alarm.audioReady() ? '' : '<button class="mute-banner" data-act="unmute">🔇 Chạm để bật tiếng chuông</button>'}
    ${goalBar()}
    <main class="list">
      ${list.length ? list.map(t => card(t, key, isToday)).join('') : `<div class="empty">${empty}</div>`}
    </main>
    <footer class="week">${weekStrip(key)}</footer>
    <button class="add" data-act="add" aria-label="Thêm việc">➕</button>`;
}

function tabBar(waiting) {
  return `
    <nav class="tabs">
      <button class="${tab === 'schedule' ? 'sel' : ''}" data-act="tab" data-v="schedule">📅 Lịch</button>
      <button class="${tab === 'awards' ? 'sel' : ''}" data-act="tab" data-v="awards">🏆 Thành tích</button>
      <button class="lock" data-act="parent" aria-label="Góc bố mẹ">🔒${waiting ? `<span class="badge">${waiting}</span>` : ''}</button>
    </nav>`;
}

function renderAwards() {
  lastHomeSig = homeSig();
  $('#app').innerHTML = `
    ${tabBar(tasks.filter(t => t.pending && !t.deleted).length)}
    ${alarm.audioReady() ? '' : '<button class="mute-banner" data-act="unmute">🔇 Chạm để bật tiếng chuông</button>'}
    <main class="awards">${awardsHtml()}</main>`;
}

function goalBar() {
  if (!goal) return '';
  const n = Math.min(goalStars(), goal.target);
  return `
    <div class="goal ${n >= goal.target ? 'reached' : ''}">
      <span class="ge">${goal.emoji}</span>
      <div class="gbar"><i style="width:${Math.round((n * 100) / goal.target)}%"></i></div>
      <b>${n >= goal.target ? '🎉 ' : ''}${n}/${goal.target} ⭐</b>
    </div>`;
}

const nameHtml = t => (t.name ? `<span class="name">${esc(t.name)}</span>` : '');
const playBtn = t => `<button class="play" data-act="play" data-id="${t.id}" ${canAnnounce(t) ? '' : 'disabled'} aria-label="Nghe">🔊</button>`;

// Only today's tasks can be ticked; other days are view-only.
function card(t, key, isToday) {
  if (t.pending) {
    return `
      <div class="card pending">
        <div class="time">${t.start}</div>
        <div class="emoji">${t.emoji}</div>
        <div class="mid"><div class="dur">${t.dur}′</div>${nameHtml(t)}<span class="wait">⏳ Chờ bố mẹ duyệt</span></div>
        ${playBtn(t)}
        <button class="check" disabled aria-label="Xong">✔</button>
      </div>`;
  }
  const done = isDone(key, t);
  const f = isToday ? remaining(t) : null;
  const started = isToday && isStarted(key, t);
  const late = isToday && !done && f === null && nowMin() >= toMin(t.start) + t.dur;
  return `
    <div class="card ${done ? 'done' : ''} ${f !== null ? 'now' : ''} ${late ? 'late' : ''}">
      <div class="time">${t.start}</div>
      <div class="emoji">${t.emoji}</div>
      <div class="mid">
        ${f !== null ? `<div class="pie" data-pie="${t.id}" style="${pieStyle(f)}"></div>` : `<div class="dur">${t.dur}′</div>`}
        ${nameHtml(t)}
        ${f !== null && !done && !started ? `<button class="btn orange begin" data-act="begin" data-id="${t.id}">▶ Bắt đầu</button>` : ''}
        ${f !== null && !done && started ? `<button class="doing" data-act="focus" data-id="${t.id}">▶ Đang làm</button>` : ''}
      </div>
      ${playBtn(t)}
      <button class="check ${done ? 'got' : ''}" data-act="toggle" data-id="${t.id}" ${isToday ? '' : 'disabled'} aria-label="Xong">${done ? '⭐' : '✔'}</button>
    </div>`;
}

function weekStrip(key) {
  const tk = todayKey();
  return weekKeys(0, fromKey(key)).map((k, i) => {
    const s = dayStats(k);
    const counted = s.total && k <= tk; // future days are not scored yet
    return `
      <button class="day ${k === tk ? 'today' : ''} ${k === key ? 'sel' : ''}" data-act="view-day" data-k="${k}">
        <div class="dl">${DAY_LABELS[i]}</div>
        <div class="bar"><i style="height:${counted ? pct(s) : 0}%"></i></div>
        <div class="ds">${offSet.has(k) ? '🏖️' : counted ? `⭐${s.done}` : '·'}</div>
      </button>`;
  }).join('');
}

function viewDay(k) {
  viewKey = k === todayKey() ? null : k;
  renderHome();
}

// Re-render home only when something visible changes; otherwise just refresh the countdowns.
function homeSig() {
  const key = shownKey();
  const n = nowMin();
  return tab + key + tasksOn(key).map(t => {
    const s = toMin(t.start);
    return n < s ? 'w' : n < s + t.dur ? 'r' : 'p';
  }).join('') + alarm.audioReady();
}

function tick() {
  // iPad sits on a stand: drift back to today's schedule after a minute without touches.
  if ((viewKey || tab !== 'schedule') && !$('#overlay').innerHTML && Date.now() - lastTouch > 60000) {
    viewKey = null;
    tab = 'schedule';
  }
  if (homeSig() !== lastHomeSig) renderHome();
  document.querySelectorAll('[data-pie]').forEach(el => {
    const t = tasks.find(x => x.id === el.dataset.pie);
    const f = t && remaining(t);
    el.setAttribute('style', pieStyle(f ?? 0));
  });
  document.querySelectorAll('[data-left]').forEach(el => {
    const t = tasks.find(x => x.id === el.dataset.left);
    if (t) el.textContent = leftText(t);
  });
}

function starBurst(emoji) {
  const el = document.createElement('div');
  el.className = 'burst';
  el.textContent = emoji;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function playPraise() {
  if (!praiseList.length) return;
  alarm.playVoice(praiseList[Math.floor(Math.random() * praiseList.length)].audio);
}

// Ticking opens the "how was it?" sheet (mood + optional photo for the parents).
async function toggleDone(id) {
  const key = todayKey();
  const k = `${key}|${id}`;
  const on = !doneMap.has(k);
  await store.setDone(key, id, on);
  if (!on) {
    doneMap.delete(k);
    renderHome();
    return;
  }
  doneMap.set(k, { key: k, date: key, taskId: id, at: Date.now() });
  alarm.cheer();
  starBurst('⭐');
  if (goal && goalStars() === goal.target) setTimeout(() => { starBurst(goal.emoji); alarm.cheer(); }, 900);
  setTimeout(playPraise, 700);
  renderHome();
  doneSheet = { t: tasks.find(x => x.id === id), key, photo: null };
  renderDoneSheet();
}

function renderDoneSheet() {
  const { t, key, photo } = doneSheet;
  const rec = doneMap.get(`${key}|${t.id}`) || {};
  $('#overlay').innerHTML = `
    <div class="donesheet">
      <div class="ds-head"><span class="alarm-emoji sm">${t.emoji}</span>${t.name ? `<span class="alarm-name">${esc(t.name)}</span>` : ''}<span class="ds-star">⭐</span></div>
      <h2>Giỏi lắm! Con thấy việc này thế nào?</h2>
      <div class="moods">${MOODS.map(m => `<button class="${rec.mood === m ? 'sel' : ''}" data-act="mood" data-m="${m}">${m}</button>`).join('')}</div>
      <label class="btn big ghost photo-btn">📷 ${photo ? 'Chụp lại' : 'Chụp ảnh cho bố mẹ xem'}<input id="photoInput" type="file" accept="image/*" capture="environment" hidden></label>
      ${photo ? `<img class="photo-preview" src="${photo}" alt="">` : ''}
      <button class="btn big green" data-act="close">✔ Xong</button>
    </div>`;
}

// Downscale to ≤800px JPEG so a year of photos stays small.
async function compressPhoto(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
  return { buf: await blob.arrayBuffer(), type: 'image/jpeg' };
}

async function savePhoto(file) {
  const { t, key } = doneSheet;
  const img = await compressPhoto(file);
  await store.putPhoto({ key: `${key}|${t.id}`, date: key, taskId: t.id, img });
  if (!doneSheet) return;
  if (doneSheet.photo) URL.revokeObjectURL(doneSheet.photo);
  doneSheet.photo = URL.createObjectURL(new Blob([img.buf], { type: img.type }));
  renderDoneSheet();
}

async function begin(id) {
  const key = todayKey();
  await store.setStarted(key, id);
  startMap.set(`${key}|${id}`, Date.now());
  alarm.cheer();
  renderHome();
  openFocus(tasks.find(x => x.id === id));
}

async function playTask(id) {
  const t = tasks.find(x => x.id === id);
  await alarm.unlockAudio();
  if (t) announce(t);
}

// ---------- full-screen "working on it" view ----------
function openFocus(t) {
  alarmTask = null;
  focusTask = t;
  $('#overlay').innerHTML = `
    <div class="focus">
      <div class="ds-head"><span class="alarm-emoji sm">${t.emoji}</span>${t.name ? `<span class="alarm-name">${esc(t.name)}</span>` : ''}</div>
      <div class="pie giant" data-pie="${t.id}" style="${pieStyle(remaining(t) ?? 0)}"></div>
      <div class="focus-left" data-left="${t.id}">${leftText(t)}</div>
      <div class="alarm-actions">
        <button class="btn big ghost" data-act="close">⬅ Về lịch</button>
        <button class="btn big green" data-act="overlay-done" data-id="${t.id}">✔ Xong rồi</button>
      </div>
    </div>`;
}

// ---------- alarms ----------
function showToast(t) {
  $('#toast')?.remove();
  const el = document.createElement('button');
  el.id = 'toast';
  el.className = 'toast';
  el.dataset.act = 'toast-close';
  el.innerHTML = `⏳ 5 phút nữa: <span>${t.emoji}</span> ${t.name ? esc(t.name) : ''}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 60000);
}

async function fire(type, t) {
  if (type === 'soon') {
    showToast(t);
    alarm.ding();
    await sleep(1200);
    await announceWith('Sắp đến giờ', t);
    return;
  }
  $('#toast')?.remove();
  focusTask = null;
  doneSheet = null;
  alarmTask = t;
  alarmType = type;
  renderAlarm();
  if (type === 'end') alarm.chimeEnd();
  else alarm.chime();
  await sleep(1800);
  if (type === 'end') {
    if (alarmTask === t) await alarm.speak('Hết giờ rồi');
    return;
  }
  for (let i = 0; i < (type === 'start' ? 2 : 1) && alarmTask === t; i++) {
    await announceWith('Đã đến giờ', t);
    await sleep(700);
  }
}

function renderAlarm() {
  const t = alarmTask;
  const end = alarmType === 'end';
  const title = end ? '⌛ Hết giờ rồi!' : alarmType === 'remind' ? '⏰ Con ơi, đến giờ rồi!' : '🔔 Đến giờ rồi!';
  $('#overlay').innerHTML = `
    <div class="alarm ${end ? 'end' : ''}">
      <div class="alarm-title">${title}</div>
      <div class="alarm-emoji">${t.emoji}</div>
      ${t.name ? `<div class="alarm-name">${esc(t.name)}</div>` : ''}
      ${end ? '' : `<div class="pie big" data-pie="${t.id}" style="${pieStyle(remaining(t) ?? 1)}"></div>`}
      <div class="alarm-time">${t.start} · ${t.dur} phút</div>
      <div class="alarm-actions">
        <button class="btn big ghost" data-act="play" data-id="${t.id}" ${canAnnounce(t) ? '' : 'disabled'}>🔊</button>
        ${end
          ? `<button class="btn big green" data-act="overlay-done" data-id="${t.id}">✔ Xong rồi</button>
             <button class="btn big ghost" data-act="close">⏳ Chưa xong</button>`
          : `<button class="btn big orange" data-act="begin" data-id="${t.id}">▶ Con bắt đầu</button>
             <button class="btn big green" data-act="overlay-done" data-id="${t.id}">✔ Xong rồi</button>`}
      </div>
    </div>`;
}

// ---------- recording (task name, parents' praise, weekly praise message) ----------
let recorder = null;
let recTarget = null; // 'wizard' | 'praise' | 'weekmsg'
let recWeek = null; // monday of the week a weekly message is recorded for
let recTimer = null;
const isRec = target => !!recorder && recorder.state === 'recording' && recTarget === target;
const rerender = target => (target === 'wizard' ? renderWizard() : $('.parent') && renderParent());

async function startRec(target, maxMs) {
  stopRec();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ['audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const chunks = [];
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType });
      recorder = null;
      recTarget = null;
      await onRecorded(target, { buf: await blob.arrayBuffer(), type: rec.mimeType });
    };
    recorder = rec;
    recTarget = target;
    rec.start();
    recTimer = setTimeout(stopRec, maxMs);
    rerender(target);
  } catch (e) {
    // Keep the browser's reason so a parent can tell "permission denied" from "not supported".
    const reason = `${e.name || 'Error'}${e.message ? `: ${e.message}` : ''}`;
    if (target === 'wizard' && wizard) {
      wizard.micError = reason;
      renderWizard();
    } else {
      alert(`Không mở được micro (${reason}). Kiểm tra quyền micro trong Cài đặt.`);
    }
  }
}

function stopRec() {
  clearTimeout(recTimer);
  if (recorder && recorder.state === 'recording') recorder.stop();
}

async function onRecorded(target, audio) {
  if (target === 'wizard') {
    if (!wizard) return;
    wizard.audio = audio;
    renderWizard();
  } else if (target === 'praise') {
    const p = { id: crypto.randomUUID(), audio };
    await store.putPraise(p);
    praiseList.push(p);
    rerender(target);
  } else if (target === 'weekmsg') {
    const m = { ...weekMsg(recWeek), audio };
    await store.putMeta(m);
    weekMsgs.set(m.key, m);
    rerender(target);
  }
  alarm.playVoice(audio);
}

// ---------- add-task wizard ----------
function openWizard() {
  const n = new Date();
  const m = Math.ceil((n.getHours() * 60 + n.getMinutes()) / 5) * 5;
  const h = Math.floor(m / 60) % 24;
  wizard = {
    step: 1,
    mode: 'voice', // 'voice' | 'text'
    audio: null,
    name: '',
    micError: false,
    emoji: null,
    hour: h % 12 || 12, // 1..12 shown on the digital clock
    min: m % 60,
    night: h >= 18 || h < 6,
    dur: 30,
    repeat: null, // 'today' | 'tomorrow' | 'days'
    days: [], // tap a day to turn it on
  };
  renderWizard();
}

// ☀️ covers 06:00–17:55, 🌙 covers 18:00–05:55, so a 12-hour clock is never ambiguous for a child.
function startMinute(w) {
  const h = w.hour % 12;
  const hour = w.night ? (h >= 6 ? h + 12 : h) : (h < 6 ? h + 12 : h);
  return hour * 60 + w.min;
}

function canNext(w) {
  return {
    1: !!w.audio || !!w.name.trim() || w.micError,
    2: !!w.emoji,
    3: true,
    4: !!w.repeat && (w.repeat !== 'days' || w.days.length > 0),
  }[w.step];
}

function renderWizard() {
  const w = wizard;
  const steps = { 1: stepName, 2: stepEmoji, 3: stepClock, 4: stepRepeat };
  const ok = canNext(w);
  $('#overlay').innerHTML = `
    <div class="wizard">
      <div class="wz-top">
        <button class="btn ghost" data-act="${w.step > 1 ? 'wz-back' : 'close'}">${w.step > 1 ? '⬅' : '✖'}</button>
        <div class="dots">${[1, 2, 3, 4].map(i => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div>
        <button id="wzNext" class="btn ${ok ? 'green' : 'off'}" data-act="${w.step < 4 ? 'wz-next' : 'wz-save'}" ${ok ? '' : 'disabled'}>${w.step < 4 ? '➡' : '✔ Lưu'}</button>
      </div>
      <div class="wz-body">${steps[w.step](w)}</div>
    </div>`;
  if (w.step === 1 && w.mode === 'text') $('#nameInput').focus();
}

// Typing must not re-render (keeps keyboard focus), so only the Next button is refreshed.
function refreshNext() {
  const ok = canNext(wizard);
  const btn = $('#wzNext');
  btn.disabled = !ok;
  btn.className = `btn ${ok ? 'green' : 'off'}`;
}

function stepName(w) {
  const recording = isRec('wizard');
  return `
    <h2>Việc gì?</h2>
    <div class="mode-tabs">
      <button class="${w.mode === 'voice' ? 'sel' : ''}" data-act="name-mode" data-v="voice">🎤 Nói</button>
      <button class="${w.mode === 'text' ? 'sel' : ''}" data-act="name-mode" data-v="text">⌨️ Gõ chữ</button>
    </div>
    ${w.mode === 'text'
      ? `<input id="nameInput" class="name-input" maxlength="40" autocomplete="off" placeholder="Ví dụ: Đọc sách" value="${esc(w.name)}">`
      : `<button class="mic ${recording ? 'rec' : ''}" data-act="${recording ? 'rec-stop' : 'rec-start'}">${recording ? '⏹' : '🎤'}</button>
         ${w.audio && !recording ? `
           <div class="row-btns">
             <button class="btn big ghost" data-act="rec-play">▶ Nghe lại</button>
             <button class="btn big ghost" data-act="rec-start">🔁 Nói lại</button>
           </div>` : ''}
         ${w.micError ? `<p class="err">Không mở được micro. Bố mẹ kiểm tra quyền micro (Cài đặt → Safari → Micrô), hoặc chọn ⌨️ Gõ chữ.<br><small>${esc(w.micError)}</small></p>` : ''}`}`;
}

function stepEmoji(w) {
  return `
    <h2>Chọn hình</h2>
    <div class="emoji-grid">${EMOJIS.map(e => `<button class="${w.emoji === e ? 'sel' : ''}" data-act="pick-emoji" data-e="${e}">${e}</button>`).join('')}</div>`;
}

const stepper = (field, d, label) => `<button class="dg-arrow" data-act="t-step" data-f="${field}" data-d="${d}" aria-label="${label}">${d > 0 ? '▲' : '▼'}</button>`;

function stepClock(w) {
  const s = startMinute(w);
  return `
    <h2>Mấy giờ làm? Làm bao lâu?</h2>
    <div class="digital-row">
      <div class="digital ${w.night ? 'night' : ''}">
        <div class="dg-col">${stepper('hour', 1, 'Tăng giờ')}<div class="dg-num" id="dgHour">${pad(w.hour)}</div>${stepper('hour', -1, 'Giảm giờ')}</div>
        <div class="dg-colon">:</div>
        <div class="dg-col">${stepper('min', 1, 'Tăng phút')}<div class="dg-num" id="dgMin">${pad(w.min)}</div>${stepper('min', -1, 'Giảm phút')}</div>
      </div>
      <div class="sunmoon">
        <button class="${w.night ? '' : 'sel'}" data-act="set-night" data-v="0" aria-label="Ban ngày">☀️</button>
        <button class="${w.night ? 'sel' : ''}" data-act="set-night" data-v="1" aria-label="Buổi tối">🌙</button>
      </div>
    </div>
    <div class="dur-row">
      <span class="dur-icon">⏳</span>
      <button class="dur-btn" data-act="t-step" data-f="dur" data-d="-1" aria-label="Bớt thời gian">−</button>
      <div class="dur-num" id="durNum">${w.dur} phút</div>
      <button class="dur-btn" data-act="t-step" data-f="dur" data-d="1" aria-label="Thêm thời gian">+</button>
    </div>
    <p class="clock-read" id="clockRead">${fmt(s)} → ${fmt(s + w.dur)} · ${w.dur} phút</p>`;
}

// Hour wraps 1..12, minute steps 5 and wraps, duration steps 15 within 15..180.
function stepTime(field, d) {
  const w = wizard;
  if (field === 'hour') w.hour = ((w.hour - 1 + d + 12) % 12) + 1;
  else if (field === 'min') w.min = (w.min + d * 5 + 60) % 60;
  else w.dur = Math.min(180, Math.max(15, w.dur + d * 15));
  renderWizard();
}

function stepRepeat(w) {
  return `
    <h2>Làm hôm nào?</h2>
    <div class="repeat-btns">
      <button class="${w.repeat === 'today' ? 'sel' : ''}" data-act="set-repeat" data-v="today">📍 Hôm nay</button>
      <button class="${w.repeat === 'tomorrow' ? 'sel' : ''}" data-act="set-repeat" data-v="tomorrow">🌅 Ngày mai</button>
      <button class="${w.repeat === 'days' ? 'sel' : ''}" data-act="set-repeat" data-v="days">🔁 Lặp lại</button>
    </div>
    ${w.repeat === 'days' ? `
      <div class="chips">${DAY_LABELS.map((l, i) => `<button class="chip ${w.days.includes(i + 1) ? 'on' : ''}" data-act="wz-day" data-day="${i + 1}">${l}</button>`).join('')}</div>` : ''}`;
}

async function saveWizard() {
  const w = wizard;
  const today = new Date();
  const t = {
    id: crypto.randomUUID(),
    emoji: w.emoji,
    name: w.name.trim() || null,
    audio: w.audio,
    start: fmt(startMinute(w)),
    dur: w.dur,
    created: dkey(today),
    days: w.repeat === 'days' ? [...w.days].sort() : null,
    date: w.repeat === 'today' ? dkey(today) : w.repeat === 'tomorrow' ? dkey(addDays(today, 1)) : null,
    pending: true,
  };
  await store.putTask(t);
  tasks.push(t);
  closeOverlay();
  starBurst('⭐');
  alarm.cheer();
}

// ---------- parent area ----------
function openGate() {
  const a = 3 + Math.floor(Math.random() * 7);
  const b = 3 + Math.floor(Math.random() * 7);
  $('#overlay').innerHTML = `
    <div class="sheet gate">
      <h2>Góc bố mẹ</h2>
      <p>${a} × ${b} = ?</p>
      <input id="gateInput" type="number" inputmode="numeric" autocomplete="off">
      <div class="row-btns">
        <button class="btn ghost" data-act="close">Huỷ</button>
        <button class="btn green" data-act="gate-ok" data-ans="${a * b}">Vào</button>
      </div>
    </div>`;
  $('#gateInput').focus();
}

function renderParent() {
  const keys = weekKeys(parentWeek);
  const ws = weekStats(parentWeek);
  const ts = dayStats(todayKey());
  const live = tasks.filter(t => !t.deleted).sort(byStart);
  const pending = live.filter(t => t.pending);
  const approved = live.filter(t => !t.pending);
  $('#overlay').innerHTML = `
    <div class="parent">
      <div class="ph"><h2>Góc bố mẹ</h2><button class="btn ghost" data-act="close">✖ Đóng</button></div>
      ${alarm.hasViVoice() ? '' : '<p class="voice-warn">⚠️ Máy này chưa có giọng đọc tiếng Việt nên app không đọc chữ (chỉ phát chuông và giọng đã thu âm). iPad có sẵn giọng tiếng Việt.</p>'}
      ${pending.length ? `
        <section class="pending-sec">
          <h3>⏳ Con vừa thêm — chờ duyệt (${pending.length})</h3>
          <p class="muted">Sửa lại nếu cần rồi bấm ✔ Duyệt. Chưa duyệt thì chưa có chuông và chưa tính %.</p>
          ${pending.map(taskRow).join('')}
        </section>` : ''}
      <section>
        <h3>Hoàn thành</h3>
        <div class="kpis">
          <div><b>${pct(ts)}%</b><span>Hôm nay (${ts.done}/${ts.total})</span></div>
          <div><b>${pct(ws)}%</b><span>${parentWeek ? 'Tuần đó' : 'Tuần này'} (${ws.done}/${ws.total})</span></div>
        </div>
        <div class="weeknav">
          <button class="btn ghost" data-act="wk" data-d="-1">‹</button>
          <span>${weekRange(keys)}</span>
          <button class="btn ghost" data-act="wk" data-d="1" ${parentWeek >= 0 ? 'disabled' : ''}>›</button>
        </div>
        <div class="bars">${keys.map((k, i) => {
          const s = dayStats(k);
          const counted = s.total && k <= todayKey();
          return `<div class="b"><div class="bv"><i style="height:${counted ? pct(s) : 0}%"></i></div><span>${DAY_LABELS[i]}</span><small>${offSet.has(k) ? '🏖️' : counted ? `${pct(s)}%` : '–'}</small></div>`;
        }).join('')}</div>
      </section>
      ${weekPraiseSection(keys)}
      ${photoSection()}
      ${goalSection()}
      ${praiseSection()}
      ${offSection()}
      <section>
        <h3>Công việc (${approved.length})</h3>
        ${approved.length ? approved.map(taskRow).join('') : '<p class="muted">Chưa có việc nào.</p>'}
      </section>
      <section>
        <h3>Sao lưu</h3>
        <p class="muted">Dữ liệu chỉ nằm trên máy này. Nên xuất file sao lưu mỗi tuần.</p>
        <div class="row-btns left">
          <button class="btn ghost" data-act="export">⬇ Xuất file</button>
          <label class="btn ghost">⬆ Nhập file<input id="importFile" type="file" accept=".json,application/json" hidden></label>
        </div>
      </section>
    </div>`;
  fillPhotos();
}

function weekPraiseSection(keys) {
  const msg = weekMsg(keys[0]);
  return `
    <section>
      <h3>🏆 Tuyên dương tuần ${weekRange(keys)}</h3>
      <p class="muted">App tự tìm điểm tốt của con. Bố mẹ thêm lời khen riêng — con xem ở nút 🏆 trên màn hình chính.</p>
      <ul class="hl-preview">${weekHighlights(parentWeek).map(h => `<li>${h.icon} ${esc(h.text)}</li>`).join('')}</ul>
      <textarea id="weekMsg" data-week="${keys[0]}" rows="3" maxlength="500" placeholder="Ví dụ: Tuần này con tự dậy đúng giờ cả 5 ngày, bố mẹ rất tự hào về con!">${esc(msg.text || '')}</textarea>
      <div class="row-btns left">
        ${msg.audio ? '<button class="btn ghost" data-act="weekmsg-play">▶ Nghe lời đã thu</button><button class="btn ghost" data-act="weekmsg-del">🗑 Xoá ghi âm</button>' : ''}
        <button class="btn ${isRec('weekmsg') ? 'red' : 'orange'}" data-act="rec-toggle" data-target="weekmsg" data-week="${keys[0]}">${isRec('weekmsg') ? '⏹ Dừng thu' : '🎤 Thu lời tuyên dương'}</button>
      </div>
    </section>`;
}

function photoSection() {
  const k = photoDay || todayKey();
  const list = tasksOn(k);
  return `
    <section>
      <h3>📷 Ảnh & cảm xúc của con</h3>
      <div class="weeknav">
        <button class="btn ghost" data-act="photo-day" data-d="-1">‹</button>
        <span>${WEEKDAY_NAMES[fromKey(k).getDay()]} ${shortDay(k)}</span>
        <button class="btn ghost" data-act="photo-day" data-d="1" ${k >= todayKey() ? 'disabled' : ''}>›</button>
      </div>
      ${list.length ? list.map(t => {
        const r = doneMap.get(`${k}|${t.id}`);
        return `
          <div class="prow">
            <span class="em">${t.emoji}</span>
            <span class="pname">${t.name ? esc(t.name) : t.start}</span>
            <span class="pdone">${r ? '✔ Xong' : '— Chưa'}</span>
            <span class="pmood">${r && r.mood ? r.mood : ''}</span>
            <img class="thumb" data-photo="${k}|${t.id}" data-act="thumb" alt="" hidden>
          </div>`;
      }).join('') : '<p class="muted">Không có việc nào trong ngày này.</p>'}
    </section>`;
}

async function fillPhotos() {
  for (const img of document.querySelectorAll('img[data-photo]')) {
    const p = await store.getPhoto(img.dataset.photo);
    if (!p || !img.isConnected) continue;
    img.src = URL.createObjectURL(new Blob([p.img.buf], { type: p.img.type }));
    img.hidden = false;
  }
}

function goalSection() {
  const n = goalStars();
  const reached = goal && n >= goal.target;
  return `
    <section>
      <h3>🎁 Phần thưởng</h3>
      ${goal ? `
        <div class="goal-now">
          <span class="ge">${goal.emoji}</span>
          <div><b>${esc(goal.name)}</b><div class="muted">${Math.min(n, goal.target)}/${goal.target} ⭐${reached ? ' — 🎉 Con đã đạt!' : ''}</div></div>
          ${reached ? '<button class="btn green" data-act="goal-reset">✔ Đã trao quà · đếm lại</button>' : ''}
        </div>` : '<p class="muted">Chưa có mục tiêu. Mỗi việc xong = 1 ⭐, đủ sao thì con được thưởng.</p>'}
      <div class="goal-form">
        <div class="chips">${GOAL_EMOJIS.map(e => `<button class="chip ${goalEmoji === e ? 'on' : ''}" data-act="goal-emoji" data-e="${e}">${e}</button>`).join('')}</div>
        <input id="goalName" type="text" maxlength="40" placeholder="Phần thưởng, ví dụ: Đi công viên">
        <label class="goal-target"><input id="goalTarget" type="number" min="1" value="${goal ? goal.target : 30}"> ⭐</label>
        <button class="btn orange" data-act="goal-save">${goal ? 'Đặt mục tiêu mới (đếm lại từ 0)' : 'Đặt mục tiêu'}</button>
      </div>
    </section>`;
}

function praiseSection() {
  return `
    <section>
      <h3>🎙 Lời khen của bố mẹ (${praiseList.length})</h3>
      <p class="muted">Thu vài câu như "Giỏi quá con ơi!". Mỗi lần con làm xong việc sẽ nghe ngẫu nhiên 1 câu.</p>
      <div class="praise-list">${praiseList.map((p, i) => `
        <span class="praise-item">
          <button class="btn ghost sm" data-act="praise-play" data-id="${p.id}">▶ Câu ${i + 1}</button>
          <button class="btn ghost sm" data-act="praise-del" data-id="${p.id}" aria-label="Xoá">🗑</button>
        </span>`).join('')}</div>
      <button class="btn ${isRec('praise') ? 'red' : 'orange'}" data-act="rec-toggle" data-target="praise">${isRec('praise') ? '⏹ Dừng thu' : '🎤 Thu lời khen'}</button>
    </section>`;
}

function offSection() {
  const from = dkey(addDays(new Date(), -30));
  const days = [...offSet].filter(k => k >= from).sort();
  return `
    <section>
      <h3>🏖️ Ngày nghỉ</h3>
      <p class="muted">Ngày con ốm, đi chơi… không có chuông và không tính %.</p>
      <div class="row-btns left">
        <input id="offDate" type="date" value="${todayKey()}">
        <button class="btn orange" data-act="off-add">Đánh dấu nghỉ</button>
      </div>
      <div class="chips left">${days.map(k => `<button class="chip on" data-act="off-del" data-k="${k}">${WEEKDAY_NAMES[fromKey(k).getDay()]} ${shortDay(k)} ✖</button>`).join('')}</div>
    </section>`;
}

async function saveOff() {
  await store.putMeta({ key: 'off', dates: [...offSet].sort() });
  renderParent();
}

function taskRow(t) {
  const durs = DURATIONS.includes(t.dur) ? DURATIONS : [...DURATIONS, t.dur].sort((a, b) => a - b);
  return `
    <div class="trow" data-id="${t.id}">
      <span class="em">${t.emoji}</span>
      <button class="btn ghost sm" data-act="play" data-id="${t.id}" ${canAnnounce(t) ? '' : 'disabled'}>🔊</button>
      <input type="text" class="tname" maxlength="40" placeholder="Tên việc" value="${esc(t.name || '')}" data-field="name" data-id="${t.id}">
      <input type="time" step="300" value="${t.start}" data-field="start" data-id="${t.id}">
      <select data-field="dur" data-id="${t.id}">${durs.map(d => `<option value="${d}" ${d === t.dur ? 'selected' : ''}>${d} phút</option>`).join('')}</select>
      ${t.date
        ? `<input type="date" value="${t.date}" data-field="date" data-id="${t.id}">`
        : `<span class="chips sm">${DAY_LABELS.map((l, i) => `<button class="chip ${t.days.includes(i + 1) ? 'on' : ''}" data-act="task-day" data-id="${t.id}" data-day="${i + 1}">${l}</button>`).join('')}</span>`}
      ${t.pending
        ? `<span class="row-end"><button class="btn green sm" data-act="approve" data-id="${t.id}">✔ Duyệt</button>
           <button class="btn ghost sm" data-act="reject" data-id="${t.id}">✖ Bỏ</button></span>`
        : `<button class="btn ghost sm del row-end" data-act="del" data-id="${t.id}">🗑</button>`}
    </div>`;
}

async function updateTask(id, patch) {
  const t = tasks.find(x => x.id === id);
  Object.assign(t, patch);
  await store.putTask(t);
}

async function exportBackup() {
  const blob = new Blob([await store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `thoigianbieu-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  if (!confirm('Thay toàn bộ dữ liệu hiện tại bằng file này?')) return;
  try {
    await store.importJSON(await file.text());
    await load();
    renderParent();
    alert('Đã nhập xong.');
  } catch (e) {
    alert(`Nhập lỗi: ${e.message}`);
  }
}

function closeOverlay() {
  stopRec();
  if (doneSheet && doneSheet.photo) URL.revokeObjectURL(doneSheet.photo);
  wizard = null;
  alarmTask = null;
  alarmType = null;
  focusTask = null;
  doneSheet = null;
  $('#overlay').innerHTML = '';
  renderHome();
}

// ---------- events ----------
const actions = {
  parent: openGate,
  add: openWizard,
  close: closeOverlay,
  unmute: () => alarm.unlockAudio().then(renderHome),
  play: el => playTask(el.dataset.id),
  toggle: el => toggleDone(el.dataset.id),
  begin: el => begin(el.dataset.id),
  focus: el => openFocus(tasks.find(x => x.id === el.dataset.id)),
  'overlay-done': el => {
    alarmTask = null;
    focusTask = null;
    toggleDone(el.dataset.id);
  },
  mood: async el => {
    const k = `${doneSheet.key}|${doneSheet.t.id}`;
    await store.updateDone(k, { mood: el.dataset.m });
    doneMap.get(k).mood = el.dataset.m;
    renderDoneSheet();
  },
  'toast-close': el => el.remove(),
  tab: el => {
    tab = el.dataset.v;
    reportWeek = 0;
    renderHome();
  },
  'rep-wk': el => {
    reportWeek = Math.min(0, reportWeek + Number(el.dataset.d));
    renderHome();
  },
  'rep-read': readReport,
  'rep-msg-play': () => alarm.unlockAudio().then(() => alarm.playVoice(weekMsg(weekKeys(reportWeek)[0]).audio)),
  'view-day': el => viewDay(el.dataset.k),
  'day-nav': el => viewDay(dkey(addDays(fromKey(shownKey()), Number(el.dataset.d)))),
  'go-today': () => viewDay(todayKey()),
  'name-mode': el => {
    stopRec();
    wizard.mode = el.dataset.v;
    renderWizard();
  },
  'rec-start': () => {
    alarm.unlockAudio();
    startRec('wizard', 8000);
  },
  'rec-stop': stopRec,
  'rec-play': () => alarm.playVoice(wizard.audio),
  'rec-toggle': el => {
    if (isRec(el.dataset.target)) return stopRec();
    alarm.unlockAudio();
    recWeek = el.dataset.week || null;
    startRec(el.dataset.target, el.dataset.target === 'weekmsg' ? 60000 : 10000);
  },
  'pick-emoji': el => {
    wizard.emoji = el.dataset.e;
    renderWizard();
  },
  't-step': el => stepTime(el.dataset.f, Number(el.dataset.d)),
  'set-night': el => {
    wizard.night = el.dataset.v === '1';
    renderWizard();
  },
  'set-repeat': el => {
    wizard.repeat = el.dataset.v;
    renderWizard();
  },
  'wz-day': el => {
    const d = Number(el.dataset.day);
    wizard.days = wizard.days.includes(d) ? wizard.days.filter(x => x !== d) : [...wizard.days, d];
    renderWizard();
  },
  'wz-next': () => {
    stopRec();
    wizard.step++;
    renderWizard();
  },
  'wz-back': () => {
    wizard.step--;
    renderWizard();
  },
  'wz-save': saveWizard,
  'gate-ok': el => {
    if (Number($('#gateInput').value) === Number(el.dataset.ans)) {
      parentWeek = 0;
      photoDay = null;
      renderParent();
    } else {
      openGate();
    }
  },
  wk: el => {
    parentWeek = Math.min(0, parentWeek + Number(el.dataset.d));
    renderParent();
  },
  'photo-day': el => {
    photoDay = dkey(addDays(fromKey(photoDay || todayKey()), Number(el.dataset.d)));
    renderParent();
  },
  thumb: el => el.classList.toggle('big'),
  'task-day': async el => {
    const t = tasks.find(x => x.id === el.dataset.id);
    const d = Number(el.dataset.day);
    const days = t.days.includes(d) ? t.days.filter(x => x !== d) : [...t.days, d].sort();
    if (!days.length) return;
    await updateTask(t.id, { days });
    renderParent();
  },
  // Approved repeating tasks count from the approval day, so days spent waiting do not lower the %.
  approve: async el => {
    const t = tasks.find(x => x.id === el.dataset.id);
    await updateTask(t.id, { pending: false, created: t.date ? t.created : todayKey() });
    renderParent();
  },
  reject: async el => {
    if (!confirm('Bỏ việc con vừa thêm?')) return;
    await updateTask(el.dataset.id, { deleted: todayKey() });
    renderParent();
  },
  del: async el => {
    if (!confirm('Xoá việc này? (Thống kê các ngày trước vẫn giữ)')) return;
    await updateTask(el.dataset.id, { deleted: todayKey() });
    renderParent();
  },
  'goal-emoji': el => {
    goalEmoji = el.dataset.e;
    document.querySelectorAll('[data-act="goal-emoji"]').forEach(b => b.classList.toggle('on', b === el));
  },
  'goal-save': async () => {
    const name = $('#goalName').value.trim();
    const target = Number($('#goalTarget').value);
    if (!name || !(target >= 1)) {
      alert('Nhập tên phần thưởng và số sao (≥ 1).');
      return;
    }
    goal = { key: 'goal', emoji: goalEmoji, name, target: Math.round(target), since: Date.now() };
    await store.putMeta(goal);
    renderParent();
  },
  // The prize goes on the child's shelf, then counting starts again for the same goal.
  'goal-reset': async () => {
    rewards.push({ emoji: goal.emoji, name: goal.name, target: goal.target, at: Date.now() });
    await store.putMeta({ key: 'rewards', list: rewards });
    goal.since = Date.now();
    await store.putMeta(goal);
    renderParent();
  },
  'praise-play': el => alarm.unlockAudio().then(() => alarm.playVoice(praiseList.find(p => p.id === el.dataset.id).audio)),
  'praise-del': async el => {
    if (!confirm('Xoá câu khen này?')) return;
    await store.delPraise(el.dataset.id);
    praiseList = praiseList.filter(p => p.id !== el.dataset.id);
    renderParent();
  },
  'weekmsg-play': () => alarm.unlockAudio().then(() => alarm.playVoice(weekMsg(weekKeys(parentWeek)[0]).audio)),
  'weekmsg-del': async () => {
    const m = { ...weekMsg(weekKeys(parentWeek)[0]), audio: null };
    await store.putMeta(m);
    weekMsgs.set(m.key, m);
    renderParent();
  },
  'off-add': async () => {
    const k = $('#offDate').value;
    if (!k) return;
    offSet.add(k);
    await saveOff();
  },
  'off-del': async el => {
    offSet.delete(el.dataset.k);
    await saveOff();
  },
  export: exportBackup,
};

document.addEventListener('click', e => {
  lastTouch = Date.now();
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled && actions[el.dataset.act]) actions[el.dataset.act](el);
});

document.addEventListener('input', e => {
  if (e.target.id === 'nameInput') {
    wizard.name = e.target.value;
    refreshNext();
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'importFile' && el.files[0]) {
    await importBackup(el.files[0]);
    return;
  }
  if (el.id === 'photoInput' && el.files[0]) {
    await savePhoto(el.files[0]);
    return;
  }
  if (el.id === 'weekMsg') {
    const m = { ...weekMsg(el.dataset.week), text: el.value.trim() };
    await store.putMeta(m);
    weekMsgs.set(m.key, m);
    return;
  }
  const field = el.dataset.field;
  if (!field) return;
  const value = field === 'dur' ? Number(el.value) : el.value.trim();
  if (!value && field !== 'name') return;
  await updateTask(el.dataset.id, { [field]: value || null });
  if ($('.parent')) renderParent(); // panel may have been closed (or replaced by an alarm) meanwhile
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'gateInput') $('[data-act="gate-ok"]').click();
  if (e.key === 'Enter' && e.target.id === 'nameInput' && canNext(wizard)) $('#wzNext').click();
});

$('#startBtn').addEventListener('click', async () => {
  await alarm.unlockAudio();
  alarm.keepAwake();
  $('#start').remove();
  renderHome();
  alarm.start(
    () => tasksOn(todayKey()).filter(t => !isDone(todayKey(), t)),
    t => isStarted(todayKey(), t),
    fire,
    todayKey,
  );
  setInterval(tick, 5000);
});

await load();
renderHome();
