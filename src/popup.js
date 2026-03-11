'use strict';

const $ = id => document.getElementById(id);
const msg = (action, payload = {}) => chrome.runtime.sendMessage({ action, payload });


function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ───────────────────────────────────────────────────────────────
// Màu rank
// ───────────────────────────────────────────────────────────────
const RANK_COLORS = {
  'newbie':           '#565d5f',
  'pupil':            '#04b903',
  'specialist':       '#3cc0bf',
  'expert':           '#288ddc',
  'candidate master': '#c406c2',
  'master':           '#fe8d04',
  'grandmaster':      '#cf190b',
  'legend':           '#FFFF00',
};

function rankColor(rank) {
  if (!rank) return 'var(--txt3)';
  return RANK_COLORS[rank.toLowerCase()] || RANK_COLORS['newbie'];
}

// ───────────────────────────────────────────────────────────────
// Màu streak
// ───────────────────────────────────────────────────────────────
function streakColor(days) {
  const n = parseInt(days, 10);
  if (isNaN(n) || n < 1) return '#b6b4b5';
  if (n >= 1000) return '#339ce9';
  if (n >= 200)  return '#bb60ff';
  if (n >= 100)  return '#fa50c8';
  if (n >= 10)   return '#ff894c';
  return '#b6b4b5';
}

// ───────────────────────────────────────────────────────────────
// Avatar dự phòng
// ───────────────────────────────────────────────────────────────
const GRADS = [
  'linear-gradient(135deg,#4c8aff,#7b5dfa)',
  'linear-gradient(135deg,#34d475,#12b886)',
  'linear-gradient(135deg,#ff6b6b,#f03e3e)',
  'linear-gradient(135deg,#ffba56,#f08c00)',
  'linear-gradient(135deg,#9c5fff,#7048e8)',
  'linear-gradient(135deg,#20c9ff,#0078c8)',
  'linear-gradient(135deg,#ff8cc8,#e03997)',
  'linear-gradient(135deg,#60d864,#2f9e44)',
];
function gradFor(u) {
  let h = 0;
  for (const c of (u || '?')) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return GRADS[h % GRADS.length];
}

// ───────────────────────────────────────────────────────────────
// Helper ngày tháng
// ───────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  } catch { return null; }
}

function formatDatetime(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()} `
         + `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch { return iso; }
}

// ───────────────────────────────────────────────────────────────
// State
// ───────────────────────────────────────────────────────────────
let account = null;

// ───────────────────────────────────────────────────────────────
// Theme
// ───────────────────────────────────────────────────────────────
(function () {
  const t = localStorage.getItem('nhpoj-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  $('btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
})();

$('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  $('btn-theme').textContent = next === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('nhpoj-theme', next);
});

// ───────────────────────────────────────────────────────────────
// Tabs
// ───────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $(`tab-${b.dataset.tab}`).classList.add('active');
  if (b.dataset.tab === 'logs') { renderSigninLogs(); renderDebugLogs(); }
}));

document.querySelectorAll('.ltab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.ltab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.lpane').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $(`ltab-${b.dataset.ltab}`).classList.add('active');
}));

// ───────────────────────────────────────────────────────────────
// UI helpers
// ───────────────────────────────────────────────────────────────
function showView(view) {
  $('loading-state').style.display = view === 'loading' ? 'flex' : 'none';
  $('user-card').style.display     = view === 'user'    ? 'flex' : 'none';
  $('no-session').style.display    = view === 'none'    ? 'flex' : 'none';
}

function applyAvatar(url, username) {
  const img = $('av-img');
  const fb  = $('av-fb');
  fb.style.background = gradFor(username);
  fb.textContent = (username || '?').charAt(0).toUpperCase();
  img.onerror = () => { img.style.display = 'none'; fb.style.display = 'flex'; };
  if (url) {
    img.src = url;
    img.style.display = 'block';
    fb.style.display = 'none';
  } else {
    img.style.display = 'none';
    fb.style.display = 'flex';
  }
}

function renderRankAndUsername(rank, username) {
  const rankEl = $('user-rank-badge');
  const nameEl = $('user-username-display');
  nameEl.textContent = username || '?';
  if (rank) {
    rankEl.textContent   = `[${rank}]`;
    rankEl.style.color   = rankColor(rank);
    rankEl.style.display = 'inline';
  } else {
    rankEl.textContent   = '';
    rankEl.style.display = 'none';
  }
}

function setBadge(type, text) {
  const el = $('status-badge');
  el.className   = `badge badge-${type}`;
  el.textContent = text;
}

function setChain(days, lastTime) {
  if (days !== null && days !== undefined) {
    const el = $('chain-days');
    el.textContent = days;
    el.style.color = streakColor(days);
    $('chain-info').style.display = 'flex';
  } else {
    $('chain-info').style.display = 'none';
  }
  if (lastTime) {
    // lastTime từ API là "YYYY-MM-DD"
    const parts = lastTime.split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts;
      $('last-signin-val').textContent = `${d}/${m}/${y}`;
    } else {
      $('last-signin-val').textContent = lastTime;
    }
    $('last-signin-row').style.display = 'flex';
  } else {
    $('last-signin-row').style.display = 'none';
  }
}

function setCardMsg(type, text, ms = 5000) {
  const el = $('card-msg');
  el.className   = `card-msg ${type}`;
  el.textContent = text;
  if (ms > 0) setTimeout(() => { el.className = 'card-msg'; el.textContent = ''; }, ms);
}

// ───────────────────────────────────────────────────────────────
// Render thông tin tài khoản
// ───────────────────────────────────────────────────────────────
function renderUser(acc) {
  if (!acc) return;
  account = acc;
  showView('user');

  applyAvatar(acc.avatar, acc.username);
  renderRankAndUsername(acc.rank, acc.username);

  const realNameEl  = $('user-realname');
  const displayName = (acc.realName || '').trim();
  if (displayName && displayName.toLowerCase() !== (acc.username || '').toLowerCase()) {
    realNameEl.textContent   = displayName;
    realNameEl.style.display = 'block';
  } else {
    realNameEl.textContent   = '';
    realNameEl.style.display = 'none';
  }

  const joinEl   = $('user-join-date');
  const joinDate = formatDate(acc.createTime);
  if (joinEl) {
    if (joinDate) { joinEl.textContent = `Tham gia: ${joinDate}`; joinEl.style.display = 'block'; }
    else          { joinEl.style.display = 'none'; }
  }

  if (timeInput) timeInput.value = acc.signinTime || '00:01';

  // [POP-1] FIX: guard null — element được thêm vào HTML, nhưng phòng thủ vẫn cần
  const autoToggleEl = $('auto-toggle');
  if (autoToggleEl) autoToggleEl.checked = acc.autoSignin ?? true;

  setBadge('idle', 'Chưa kiểm tra');
  $('chain-info').style.display      = 'none';
  $('last-signin-row').style.display = 'none';

  if (acc.lastSignin) {
    $('last-signin-val').textContent   = formatDatetime(acc.lastSignin);
    $('last-signin-row').style.display = 'flex';
  }

  if (timeInput) timeInput.value = account.signinTime || '00:01';
}

// ───────────────────────────────────────────────────────────────
// Chọn thời gian điểm danh
// ───────────────────────────────────────────────────────────────

const timeInput = $('time-input');

if (timeInput) {
  timeInput.addEventListener('change', () => {
    if (!account) return;
    const newTime = timeInput.value;
    if (!/^\d{2}:\d{2}$/.test(newTime)) return;
    msg('UPDATE_SETTINGS', { signinTime: newTime });
    account.signinTime = newTime;
  });
}

let _loadingTimeout = null;

chrome.runtime.onMessage.addListener((m) => {
  if (m.action !== 'AUTH_CHANGED') return;
  clearTimeout(_loadingTimeout);
  if (m.payload?.loggedIn && m.payload?.account) {
    renderUser(m.payload.account);
    checkStatus(true);
  } else {
    account = null;
    showView('none');
    $('no-desc').innerHTML = 'Đã đăng xuất. Mở <b>nhpoj.net</b> và đăng nhập lại.';
  }
});

async function init() {
  const cached = await msg('GET_ACCOUNT');

  if (cached?.account) {
    renderUser(cached.account);
    if (cached.fromCache) checkStatus(true);
  } else {
    showView('loading');

    // [POP-8] FIX: timeout 8s — không để popup stuck ở loading mãi mãi
    _loadingTimeout = setTimeout(() => {
      if ($('loading-state').style.display !== 'none') {
        showView('none');
        $('no-desc').innerHTML = 'Không thể kết nối. Mở <b>nhpoj.net</b> và thử lại.';
      }
    }, 8000);

    msg('DETECT_SESSION');
  }
}

// ───────────────────────────────────────────────────────────────
// Kiểm tra trạng thái điểm danh
// ───────────────────────────────────────────────────────────────
async function checkStatus(silent = false) {
  const btn = $('btn-check');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin-inline">⟳</span> Đang kiểm tra…';
  setBadge('idle', 'Đang kiểm tra…');

  const r = await msg('CHECK_STATUS');

  if ($('user-card').style.display !== 'none') {
    btn.disabled  = false;
    btn.innerHTML = '<span class="btn-icon">⟳</span> Kiểm tra chuỗi';
  }

  if (r?.accountCleared) {
    account = null;
    showView('none');
    $('no-desc').innerHTML = 'Phiên đăng nhập đã hết hạn. Mở <b>nhpoj.net</b> và đăng nhập lại.';
    return;
  }
  if (r?.status === 'error') {
    if (!silent) setCardMsg('err', `❌ ${r.error}`);
    setBadge('err', 'Lỗi kiểm tra');
    return;
  }
  if (r?.alreadySignedIn) {
    setBadge('ok', 'Đã điểm danh hôm nay');
    setChain(r.continueDays, r.lastSigninTime);
  } else {
    setBadge('warn', 'Chưa điểm danh hôm nay');
    setChain(r.continueDays, r.lastSigninTime);
  }
}

$('btn-check').addEventListener('click', () => checkStatus(false));

// ───────────────────────────────────────────────────────────────
// Điểm danh ngay
// ───────────────────────────────────────────────────────────────
$('btn-signin').addEventListener('click', async () => {
  const btn = $('btn-signin');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spin-inline">⟳</span> Đang gửi…';
  $('card-msg').className   = 'card-msg';
  $('card-msg').textContent = '';

  const r = await msg('SIGNIN_NOW');
  btn.disabled  = false;
  btn.innerHTML = '<span class="btn-icon">✓</span> Điểm danh ngay';

  if (r?.accountCleared) {
    account = null;
    showView('none');
    $('no-desc').innerHTML = 'Phiên đăng nhập đã hết hạn. Mở <b>nhpoj.net</b> và đăng nhập lại.';
    return;
  }
  if (r?.status === 'error') {
    setCardMsg('err', `❌ ${r.error}`);
    setBadge('err', 'Điểm danh thất bại');
    return;
  }
  if (r?.alreadySignedIn) {
    setBadge('ok', 'Đã điểm danh hôm nay');
    setChain(r.continueDays, r.lastSigninTime);
    setCardMsg('info', `ℹ️ Đã điểm danh rồi. Chuỗi: ${r.continueDays} ngày`);
  } else {
    setBadge('ok', '🎉 Điểm danh thành công!');
    setChain(r.continueDays, r.lastSigninTime);
    setCardMsg('ok', `🎉 Đã điểm danh thành công! Chuỗi: ${r.continueDays} ngày`);
  }
});

// ───────────────────────────────────────────────────────────────
// Bật / tắt tự động điểm danh
// ───────────────────────────────────────────────────────────────
const autoToggle = $('auto-toggle');
if (autoToggle) {
  autoToggle.addEventListener('change', () => {
    if (!account) return;
    msg('UPDATE_SETTINGS', { autoSignin: autoToggle.checked });
    account.autoSignin = autoToggle.checked;
  });
}

const btnAvRefresh = $('btn-av-refresh');
if (btnAvRefresh) {
  btnAvRefresh.addEventListener('click', async () => {
    if (!account) return;
    btnAvRefresh.disabled = true;
    try {
      const res = await msg('GET_ACCOUNT');
      if (res?.account?.avatar !== undefined) {
        applyAvatar(res.account.avatar, res.account.username);
        account.avatar = res.account.avatar;
      }
    } finally {
      btnAvRefresh.disabled = false;
    }
  });
}

const btnRetry = $('btn-retry');
if (btnRetry) {
  btnRetry.addEventListener('click', () => {
    showView('loading');
    _loadingTimeout = setTimeout(() => {
      if ($('loading-state').style.display !== 'none') {
        showView('none');
        $('no-desc').innerHTML = 'Không thể kết nối. Mở <b>nhpoj.net</b> và thử lại.';
      }
    }, 8000);
    msg('DETECT_SESSION');
  });
}

async function renderSigninLogs() {
  const { logs = [] } = await msg('GET_LOGS');
  const el = $('log-signin');
  el.innerHTML = '';
  if (!logs.length) { el.innerHTML = '<div class="empty">Chưa có log.</div>'; return; }

  const frag = document.createDocumentFragment();
  for (const e of logs) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.innerHTML = `
      <div class="dot ${e.success ? 'ok' : 'fail'}"></div>
      <div class="lb">
        <div class="lh">
          <span class="lu">${esc(e.username)}</span>
          <span class="lt">${esc(e.time)}</span>
        </div>
        <div class="lm">${esc(e.message)}</div>
      </div>`;
    frag.appendChild(item);
  }
  el.appendChild(frag);
}

async function renderDebugLogs() {
  const { devlogs = [] } = await msg('GET_DEV_LOGS');
  const el = $('log-debug');
  el.innerHTML = '';
  if (!devlogs.length) { el.innerHTML = '<div class="empty">Chưa có debug log.</div>'; return; }
  
  const frag = document.createDocumentFragment();
  for (const e of devlogs) {
    const item = document.createElement('div');
    item.className = 'di';
    item.innerHTML = `
      <div class="dh">
        <span class="dlv lv-${esc(e.level)}">${esc(e.level)}</span>
        <span class="dc">[${esc(e.category)}]</span>
        <span class="dd">${esc(e.time)}</span>
      </div>
      <div class="dm">${esc(e.message)}</div>`;
    frag.appendChild(item);
  }
  el.appendChild(frag);
}

$('btn-dbg-refresh').addEventListener('click', renderDebugLogs);
$('btn-clear').addEventListener('click', async () => {
  if (!confirm('Xóa tất cả log?')) return;
  await msg('CLEAR_LOGS');
  await msg('CLEAR_DEV_LOGS');
  renderSigninLogs();
  renderDebugLogs();
});

// ───────────────────────────────────────────────────────────────
// Khởi động
// ───────────────────────────────────────────────────────────────
init();