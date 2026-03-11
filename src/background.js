// NHPOJ Sign-in Manager — Background v21
// ── Fixes ────────────────────────────────────────────────────────────────────
// [BG-1]  callSigninApi: await log() dời vào trong try-catch
// [BG-2]  cookie onChanged: debounce 1500ms + chỉ filter session cookies
// [BG-3]  POLL_MINUTES: 0.5 → 5 (Chrome min=1min, 0.5 gây 1440 call/ngày)
// [BG-4]  schedulePollAlarm: async + await clear trước khi create (tránh duplicate)
// [BG-5]  doAutoSignin: dùng UserCache thay vì double-fetchProfile
// [BG-6]  parseSigninResponse: check r.data.error TRƯỚC khi extract d
// [BG-7]  sighinstatus: handle cả boolean true lẫn string "true"
// [BG-8]  UPDATE_SETTINGS: whitelist field, không dùng Object.assign tự do
// [BG-9]  Thêm case 'DETECT_SESSION' vào handleMsg
// [BG-10] Startup: tránh double refresh() khi service worker wake
// [BG-11] CRITICAL: setTimeout → chrome.alarms cho random delay (SW có thể bị kill)
// [BG-12] checkLogin() ra ngoài retry loop, chỉ check 1 lần trước POST loop
// [BG-13] MAX_RETRY: 5 → 120 (retry 2 tiếng)
// [BG-14] ALARM_SIGNIN_RUN alarm mới cho delayed execution, không dùng setTimeout
// [BG-15] Thêm ALARM_SIGNIN_RETRY để retry loop survive SW termination
// [BG-16] Dùng last_sighin_time so sánh ngày LOCAL (không UTC) để xác định đã điểm danh
// [BG-17] Deadline chuỗi 07:00 — DEPRECATED (xem BG-21)
// [BG-18] Auto-trigger khi startup/poll: chưa điểm danh → tự gửi ngay
// [BG-19] Rewrite auto flow: dùng sighinstatus==="false" (string) thay vì last_sighin_time
//         checkSigninStatus() trực tiếp từ GET /api/signin, sendSignInPost() → bool
//         Bỏ checkLogin()/fetchProfile trong auto flow — /api/signin đủ data
//         Fix stray } thừa cuối checkAndAutoSignInIfNeeded
// [BG-20] FIX: isBeforeChainDeadline() chỉ gate retry loop
//         checkAndAutoSignInIfNeeded() KHÔNG còn bị chặn bởi 7h → chạy bất kể giờ nào
//         Bỏ deadline gate đầu runAutoSignIn() — chỉ giữ trong retry loop
//         CHECK_STATUS handler: nếu sighinstatus="false" + autoSignin → tự fire sign-in ngầm
// [BG-21] FIX LOGIC NGÀY THEO SERVER (+08:00, MỐC 07:00):
//         Server dùng 07:00 +08:00 làm mốc bắt đầu ngày mới (không phải 00:00)
//         getEffectiveDateStr(): nếu giờ hiện tại ở +08:00 < 07:00 → effectiveDate = hôm qua
//         isSignedInToday(): so sánh last_sighin_time với effectiveDate (không phải local date)
//         Bỏ hoàn toàn logic chặn POST sau 7h trong retry loop — server là source of truth
//         sighinstatus="true" → đã điểm danh; "false" → chưa → POST ngay
//         data=null → lỗi mạng/hết phiên → không POST
//         Thêm check profile trước khi POST (theo đặc tả)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const NHPOJ_BASE   = 'https://nhpoj.net';
const PROFILE_API  = `${NHPOJ_BASE}/api/profile`;
const SIGHIN_API   = `${NHPOJ_BASE}/api/sighin`;
const ALARM_SIGNIN     = 'nhpoj_signin';      // alarm đặt giờ hàng ngày
const ALARM_SIGNIN_RUN = 'nhpoj_signin_run';  // [BG-11/14] alarm thực thi sau random delay
const ALARM_POLL       = 'nhpoj_poll';

// [BG-3] FIX: Chrome Alarm tối thiểu 1 phút. 0.5 bị clamp thành 1 phút
// = 1440 network call/ngày → rate-limit + battery drain. 5 phút là hợp lý.
const POLL_MINUTES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// [BG-21] Timezone & ngày hiệu lực theo quy tắc server
//
// Server timezone: +08:00 (Asia/Shanghai / Asia/Taipei)
// Mốc ngày mới của server: 07:00 +08:00 (KHÔNG phải 00:00)
//
// Ví dụ:
//   Người dùng ở +07:00, lúc 06:30 sáng ngày 23/02:
//     → Giờ server (+08:00) = 07:30 → đã qua mốc 7h → effectiveDate = "2026-02-23"
//   Người dùng ở +07:00, lúc 05:30 sáng ngày 23/02:
//     → Giờ server (+08:00) = 06:30 → chưa qua mốc 7h → effectiveDate = "2026-02-22" (hôm qua)
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_UTC_OFFSET = 8;    // +08:00
const SERVER_DAY_START_HOUR = 7; // 07:00

/**
 * Trả về giờ hiện tại theo server timezone (+08:00) dưới dạng Date object
 * với giờ/phút/giây đã được điều chỉnh về UTC+8.
 */
function nowInServerTz() {
  const nowUtcMs = Date.now() + new Date().getTimezoneOffset() * 60_000;
  return new Date(nowUtcMs + SERVER_UTC_OFFSET * 3_600_000);
}

/**
 * [BG-21] Trả về "ngày hiệu lực" theo quy tắc server: YYYY-MM-DD
 *
 * Nếu giờ server hiện tại < 07:00 → trả về ngày HÔM QUA (ngày mới chưa bắt đầu)
 * Nếu giờ server hiện tại >= 07:00 → trả về ngày HÔM NAY
 *
 * Dùng để so sánh với last_sighin_time từ API.
 */
function getEffectiveDateStr() {
  const serverNow = nowInServerTz();
  const hour = serverNow.getHours();
  if (hour < SERVER_DAY_START_HOUR) {
    // Chưa qua 07:00 → lùi lại 1 ngày
    serverNow.setDate(serverNow.getDate() - 1);
  }
  // Format YYYY-MM-DD
  const y  = serverNow.getFullYear();
  const mo = String(serverNow.getMonth() + 1).padStart(2, '0');
  const d  = String(serverNow.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * [BG-21] Kiểm tra xem last_sighin_time có phải là "hôm nay" theo ngày hiệu lực không.
 * @param {string|null} lastSigninTime - "YYYY-MM-DD" từ server
 * @returns {boolean}
 */
function isSignedInToday(lastSigninTime) {
  if (!lastSigninTime) return false;
  return lastSigninTime >= getEffectiveDateStr();
}

// [BG-21] Kept for backward compat — không còn dùng trong logic chính
function getLocalDateStr() {
  return getEffectiveDateStr();
}

// ───────────────────────────────────────────────────────────────
// Logger
// ───────────────────────────────────────────────────────────────
async function log(level, cat, msg, data = null) {
  const line = `[NHPOJ][${cat}] ${msg}`;
  if (level === 'ERROR' || level === 'WARN') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
  try {
    const { devlogs = [] } = await chrome.storage.local.get('devlogs');
    devlogs.unshift({
      level, category: cat,
      message: data != null ? `${msg} | ${JSON.stringify(data)}` : msg,
      time: new Date().toLocaleString('vi-VN')
    });
    if (devlogs.length > 300) devlogs.length = 300;
    await chrome.storage.local.set({ devlogs });
  } catch (_) {}
}

// ───────────────────────────────────────────────────────────────
// Rank
// ───────────────────────────────────────────────────────────────
function getRankFromExp(exp) {
  const n = Number(exp);
  if (isNaN(n) || n < 0)  return null;
  if (n < 100)   return 'Newbie';
  if (n < 200)   return 'Pupil';
  if (n < 500)   return 'Specialist';
  if (n < 1000)  return 'Expert';
  if (n < 2500)  return 'Candidate master';
  if (n < 5000)  return 'Master';
  if (n < 10000) return 'Grandmaster';
  return 'Legend';
}

// ───────────────────────────────────────────────────────────────
// CSRF token
// ───────────────────────────────────────────────────────────────
async function getCsrfToken() {
  try {
    const cookie = await chrome.cookies.get({ url: NHPOJ_BASE, name: 'csrftoken' });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────
// Fetch /api/profile
// ───────────────────────────────────────────────────────────────
async function fetchProfile() {
  try {
    const csrf = await getCsrfToken();
    const resp = await fetch(PROFILE_API, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'X-CSRFToken': csrf || '',
        'Referer': `${NHPOJ_BASE}/`,
      }
    });
    if (!resp.ok) {
      await log('WARN', 'PROFILE', `HTTP ${resp.status}`);
      return { loggedIn: false, raw: null };
    }
    const json = await resp.json();
    const data = json?.data ?? null;
    return { loggedIn: !!data, raw: data };
  } catch (e) {
    await log('ERROR', 'PROFILE', 'fetchProfile failed', e.message);
    return { loggedIn: false, raw: null, error: e.message };
  }
}

function buildAccountFromProfile(data, prev) {
  if (!data) return null;
  const isSameUser = prev && prev.userId && prev.userId === data.user?.id;
  const exp = Number(data.experience ?? data.oi_problems_status?.experience ?? 0);
  const rank = getRankFromExp(exp);
  let avatarPath = data.avatar || data.oi_problems_status?.avatar || null;
  const avatar = avatarPath
    ? (avatarPath.startsWith('http') ? avatarPath : `${NHPOJ_BASE}${avatarPath}`)
    : null;
  return {
    userId:     data.user?.id       ?? null,
    profileId:  data.id             ?? null,
    username:   data.user?.username || '?',
    realName:   data.real_name      || null,
    rank, experience: exp, avatar,
    createTime: data.user?.create_time || null,
    signinTime: isSameUser ? (prev.signinTime || '00:01') : '00:01',
    autoSignin: isSameUser ? (prev.autoSignin ?? true)    : true,
    lastSignin: isSameUser ? (prev.lastSignin || null)    : null,
    savedAt:    new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────
// Cache
// ───────────────────────────────────────────────────────────────
const UserCache = {
  _account: null, _cachedAt: 0, _authState: 'UNKNOWN',
  setLoggedIn(a)  { this._account = {...a}; this._cachedAt = Date.now(); this._authState = 'LOGGED_IN'; },
  setLoggedOut()  { this._account = null;   this._cachedAt = Date.now(); this._authState = 'LOGGED_OUT'; },
  clear()         { this._account = null;   this._cachedAt = 0;          this._authState = 'UNKNOWN'; },
  get()           { return this._account; },
  authState()     { return this._authState; },
  isStale(ms = 60_000) { return (Date.now() - this._cachedAt) > ms; },
};

// ───────────────────────────────────────────────────────────────
// AuthManager
// ───────────────────────────────────────────────────────────────
const AuthManager = {
  _busy: false,

  async refresh() {
    if (this._busy) return;
    this._busy = true;
    try {
      const prevState = UserCache.authState();
      const { loggedIn, raw } = await fetchProfile();
      const { account: stored } = await chrome.storage.local.get('account');

      if (!loggedIn) {
        const wasLoggedIn = prevState !== 'LOGGED_OUT';
        if (wasLoggedIn || stored) {
          await log('INFO', 'AUTH', 'Đăng xuất — xóa state');
          await chrome.storage.local.remove('account');
        }
        UserCache.setLoggedOut();
        if (wasLoggedIn) this._broadcast({ loggedIn: false });
        return;
      }

      const account = buildAccountFromProfile(raw, stored);
      const switched = stored?.userId && account.userId && stored.userId !== account.userId;
      if (switched) await log('WARN', 'AUTH', 'Đổi tài khoản!', { from: stored.username, to: account.username });

      await chrome.storage.local.set({ account });
      UserCache.setLoggedIn(account);
      if (account.autoSignin) await scheduleSigninAlarm(account.signinTime);
      if (prevState !== 'LOGGED_IN' || switched) this._broadcast({ loggedIn: true, account });

      await log('OK', 'AUTH', `Đăng nhập: ${account.username} [${account.rank}] exp=${account.experience}`);
    } catch (e) {
      await log('ERROR', 'AUTH', 'refresh() lỗi', e.message);
    } finally {
      this._busy = false;
    }
  },

  _broadcast(payload) {
    chrome.runtime.sendMessage({ action: 'AUTH_CHANGED', payload }).catch(() => {});
  },

  async warmFromStorage() {
    const { account } = await chrome.storage.local.get('account');
    if (account) UserCache.setLoggedIn(account);
    else UserCache.clear();
  }
};

// ───────────────────────────────────────────────────────────────
// Cookie tracker — [BG-2] FIX: debounce + filter session cookies
// ───────────────────────────────────────────────────────────────
const SESSION_COOKIES = new Set(['csrftoken', 'sessionid']);
let _cookieDebounceTimer = null;

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!changeInfo.cookie.domain.includes('nhpoj.net')) return;
  if (!SESSION_COOKIES.has(changeInfo.cookie.name)) return;
  log('DEBUG', 'COOKIE', `"${changeInfo.cookie.name}" thay đổi (${changeInfo.cause})`);
  // [BG-2] FIX: debounce 1500ms — tránh N refresh đồng thời khi login tạo nhiều cookie
  clearTimeout(_cookieDebounceTimer);
  _cookieDebounceTimer = setTimeout(() => AuthManager.refresh(), 1500);
});

// ───────────────────────────────────────────────────────────────
// API sign-in — [BG-1] FIX: log() bên trong try
// ───────────────────────────────────────────────────────────────
async function callSigninApi(method) {
  const csrf = await getCsrfToken();
  try {
    await log('INFO', 'SIGNIN', `${method} ${SIGHIN_API}`); // [BG-1] FIX: trong try
    const opts = {
      method, credentials: 'include',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'X-CSRFToken': csrf || '',
        'Referer': `${NHPOJ_BASE}/`,
        'Origin': NHPOJ_BASE,
      }
    };
    if (method === 'POST') {
      opts.headers['Content-Type'] = 'application/json;charset=UTF-8';
      opts.body = JSON.stringify({});
    }
    const resp = await fetch(SIGHIN_API, opts);
    const data = await resp.json();
    await log('DEBUG', 'SIGNIN', `${method} response`, { status: resp.status, data });
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    await log('ERROR', 'SIGNIN', `${method} lỗi`, e.message);
    return { ok: false, status: 0, error: e.message };
  }
}

// [BG-6]  FIX: check r.data.error TRƯỚC khi extract d
// [BG-7]  FIX: sighinstatus có thể là boolean true hoặc string "true"
// [BG-21] FIX: dùng isSignedInToday() + getEffectiveDateStr() thay vì so sánh với local date
//         Logic:
//           sighinstatus="true"  → đã điểm danh (server confirm)
//           sighinstatus="false" + last_sighin_time >= effectiveDate → vẫn coi là đã điểm danh
//           sighinstatus="false" + last_sighin_time < effectiveDate  → chưa điểm danh
function parseSigninResponse(r) {
  if (!r) return { status: 'error', error: 'Không có phản hồi' };
  if (r.error && !r.data) return { status: 'error', error: r.error };
  if (!r.ok) {
    if (r.status === 401 || r.status === 403)
      return { status: 'auth_error', error: `Phiên hết hạn (${r.status})` };
    return { status: 'error', error: r.error || `HTTP ${r.status}` };
  }
  if (r.data?.error) return { status: 'error', error: String(r.data.error) }; // [BG-6] FIX

  // [BG-21] Trả về null nếu server không trả data (lỗi mạng / hết phiên)
  const d = r.data?.data;
  if (d === null || d === undefined) {
    return { status: 'error', error: 'Server trả data=null (lỗi mạng hoặc hết phiên)' };
  }

  const effectiveDate = getEffectiveDateStr(); // [BG-21] ngày hiệu lực theo +08:00, mốc 7h
  const lastTime      = d?.last_sighin_time ?? null;

  // [BG-7] FIX: boolean true || string "true"
  const signedByStatus = d?.sighinstatus === true || d?.sighinstatus === 'true';
  // [BG-21] double-check: ngay cả khi server trả "false", nếu last_sighin_time >= effectiveDate
  // thì vẫn coi là đã điểm danh trong ngày hiệu lực (tránh điểm danh trùng)
  const signedByDate   = isSignedInToday(lastTime);
  const alreadySignedIn = signedByStatus || signedByDate;

  return {
    status: 'ok',
    signed:          signedByStatus,
    alreadySignedIn,
    today:           alreadySignedIn,          // alias cho popup
    continueDays:    d?.continue_sighin_days ?? null,
    lastSigninTime:  lastTime,
    effectiveDate,                              // debug — ngày hiệu lực đang dùng
    raw: r.data
  };
}

// ───────────────────────────────────────────────────────────────
// Auto sign-in v4 — [BG-19]
// Dùng GET /api/signin + sighinstatus string ("true"/"false")
// Không dùng /api/profile trong auto flow
// ───────────────────────────────────────────────────────────────

/** Trả về số phút ngẫu nhiên trong khoảng [1, 20] */
function getRandomDelayMin() {
  return Math.floor(Math.random() * 20) + 1;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * GET /api/signin → phân tích response theo logic [BG-21]
 *
 * Trả về object:
 *   { needSignIn: true }   → chưa điểm danh trong ngày hiệu lực → cần POST
 *   { needSignIn: false }  → đã điểm danh → không cần làm gì
 *   null                   → lỗi mạng / data=null / chưa đăng nhập → không POST
 *
 * Logic:
 *   1. data = null → lỗi → return null
 *   2. sighinstatus = "true" → đã điểm danh → return { needSignIn: false }
 *   3. sighinstatus = "false":
 *        + last_sighin_time >= effectiveDate → đã điểm danh trong ngày hiệu lực
 *          → return { needSignIn: false } (tránh POST trùng)
 *        + last_sighin_time < effectiveDate → chưa điểm danh
 *          → return { needSignIn: true }
 *
 * [BG-21] effectiveDate = ngày theo server +08:00 với mốc 07:00
 */
async function checkSigninStatus() {
  try {
    const csrf = await getCsrfToken();
    const resp = await fetch(SIGHIN_API, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'X-CSRFToken': csrf || '',
        'Referer': `${NHPOJ_BASE}/`,
        'Origin': NHPOJ_BASE,
      }
    });

    await log('DEBUG', 'AUTO', `checkSigninStatus HTTP ${resp.status}`);

    if (!resp.ok) {
      await log('WARN', 'AUTO', `checkSigninStatus HTTP ${resp.status} — not ok`);
      return null;
    }

    let json;
    try {
      json = await resp.json();
    } catch (parseErr) {
      await log('ERROR', 'AUTO', 'checkSigninStatus: JSON parse lỗi', parseErr.message);
      return null;
    }

    await log('DEBUG', 'AUTO', 'checkSigninStatus raw JSON', json);

    // Hỗ trợ nhiều cấu trúc nested khác nhau mà server có thể trả
    const inner =
      json?.data?.data ??   // { error:null, data: { sighinstatus:... } }
      json?.data       ??   // { sighinstatus:... }
      json             ??   // { sighinstatus:... } (root)
      null;

    // [BG-21] data = null → lỗi mạng hoặc hết phiên → không POST
    if (inner === null || typeof inner !== 'object') {
      await log('WARN', 'AUTO', 'checkSigninStatus: data=null hoặc không phải object → lỗi mạng/hết phiên', { json });
      return null;
    }

    if (!('sighinstatus' in inner)) {
      await log('WARN', 'AUTO', 'checkSigninStatus: sighinstatus không có trong response', { inner });
      return null;
    }

    const rawStatus   = inner.sighinstatus;
    const statusStr   = String(rawStatus);
    const lastTime    = inner.last_sighin_time ?? null;
    const effectiveDate = getEffectiveDateStr(); // [BG-21]

    await log('DEBUG', 'AUTO',
      `checkSigninStatus → sighinstatus="${statusStr}" last="${lastTime}" ` +
      `effectiveDate="${effectiveDate}" days=${inner.continue_sighin_days}`
    );

    // [BG-21] Case 1: server xác nhận đã điểm danh
    if (statusStr === 'true') {
      await log('OK', 'AUTO', 'sighinstatus="true" → đã điểm danh');
      return { needSignIn: false, reason: 'sighinstatus=true' };
    }

    // [BG-21] Case 2: sighinstatus="false" → kiểm tra last_sighin_time vs effectiveDate
    if (statusStr === 'false') {
      if (isSignedInToday(lastTime)) {
        // last_sighin_time >= effectiveDate → đã điểm danh trong ngày hiệu lực
        await log('OK', 'AUTO',
          `sighinstatus="false" nhưng last_sighin_time="${lastTime}" >= effectiveDate="${effectiveDate}" → đã điểm danh`
        );
        return { needSignIn: false, reason: 'lastSigninTime>=effectiveDate' };
      }
      // last_sighin_time < effectiveDate → CHƯA điểm danh
      await log('INFO', 'AUTO',
        `sighinstatus="false" + last_sighin_time="${lastTime}" < effectiveDate="${effectiveDate}" → CẦN điểm danh`
      );
      return { needSignIn: true, lastTime, effectiveDate };
    }

    // Trường hợp không xác định
    await log('WARN', 'AUTO', `checkSigninStatus: sighinstatus không xác định "${statusStr}"`, { inner });
    return null;

  } catch (e) {
    await log('ERROR', 'AUTO', 'checkSigninStatus lỗi', e.message);
    return null;
  }
}

/**
 * POST /api/signin → trả về boolean (true = thành công)
 * [BG-19] success = json.data.error === null
 */
async function sendSignInPost() {
  try {
    const csrf = await getCsrfToken();
    if (!csrf) {
      await log('WARN', 'AUTO', 'sendSignInPost: không lấy được csrftoken');
      return false;
    }
    const resp = await fetch(SIGHIN_API, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'X-CSRFToken': csrf,
        'Referer': `${NHPOJ_BASE}/`,
        'Origin': NHPOJ_BASE,
      },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      await log('WARN', 'AUTO', `sendSignInPost HTTP ${resp.status}`);
      return false;
    }
    const json = await resp.json();
    await log('DEBUG', 'AUTO', 'sendSignInPost response', json);
    // success: data.error === null
    return json?.data?.error === null;
  } catch (e) {
    await log('ERROR', 'AUTO', 'sendSignInPost lỗi', e.message);
    return false;
  }
}

// [BG-13] 120 lần × 1 phút = retry tối đa 2 tiếng
const MAX_RETRY = 120;

/**
 * [BG-21] Flow chính — chạy hoàn toàn ngầm, không cần popup:
 *
 *  Bước 1: GET /api/profile → xác minh đăng nhập
 *          data=null → chưa đăng nhập → dừng (không POST)
 *
 *  Bước 2: GET /api/signin → checkSigninStatus()
 *          null            → lỗi mạng / data=null → không POST → báo lỗi
 *          needSignIn=false → đã điểm danh → thoát
 *          needSignIn=true  → chưa điểm danh → POST loop
 *
 *  POST loop tối đa MAX_RETRY lần, retry mỗi 1 phút.
 *  Không có deadline 7h — server là nguồn truth duy nhất.
 */
async function runAutoSignIn() {
  await log('INFO', 'AUTO', '━━━ runAutoSignIn bắt đầu ━━━');
  await chrome.alarms.clear(ALARM_SIGNIN_RUN);

  const { account: acc } = await chrome.storage.local.get('account');
  if (!acc?.autoSignin) {
    await log('DEBUG', 'AUTO', 'autoSignin=off — bỏ qua');
    return;
  }

  // [BG-21] Bước 1: xác minh đăng nhập trước (theo đặc tả)
  await log('INFO', 'AUTO', 'Bước 1: xác minh đăng nhập qua /api/profile');
  const { loggedIn } = await fetchProfile();
  if (!loggedIn) {
    await log('WARN', 'AUTO', '/api/profile trả data=null → chưa đăng nhập → không POST');
    await logSignin(acc.username || '?', false, 'Chưa đăng nhập (profile=null)');
    return;
  }

  // [BG-21] Bước 2: GET /api/signin để kiểm tra trạng thái
  await log('INFO', 'AUTO', 'Bước 2: kiểm tra trạng thái điểm danh');
  const statusResult = await checkSigninStatus();

  if (statusResult === null) {
    await log('WARN', 'AUTO', 'checkSigninStatus trả null (lỗi mạng hoặc data=null) — không POST');
    await logSignin(acc.username || '?', false, 'Không lấy được status (lỗi mạng/hết phiên)');
    return;
  }

  if (!statusResult.needSignIn) {
    await log('OK', 'AUTO', `Đã điểm danh (${statusResult.reason}) — không cần POST`);
    return;
  }

  // needSignIn=true → tiến hành POST loop
  await log('INFO', 'AUTO',
    `Chưa điểm danh (last="${statusResult.lastTime}", effectiveDate="${statusResult.effectiveDate}") → bắt đầu POST loop`
  );

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    await log('INFO', 'AUTO', `POST lần ${attempt}/${MAX_RETRY}`);
    const success = await sendSignInPost();

    if (success) {
      sendNotif('🎉 Điểm danh thành công!', 'Chuỗi được duy trì.');
      await logSignin(acc.username || '?', true, `Thành công sau ${attempt} lần`);
      const { account: latest } = await chrome.storage.local.get('account');
      if (latest) {
        latest.lastSignin = new Date().toISOString();
        await chrome.storage.local.set({ account: latest });
        UserCache.setLoggedIn(latest);
        AuthManager._broadcast({ loggedIn: true, account: latest });
      }
      await log('OK', 'AUTO', `━━━ Thành công sau ${attempt} lần ━━━`);
      return;
    }

    await log('WARN', 'AUTO', `POST lần ${attempt} thất bại — retry sau 1 phút`);
    if (attempt < MAX_RETRY) await sleep(60_000);
  }

  // Hết MAX_RETRY lần
  await log('ERROR', 'AUTO', `Hết ${MAX_RETRY} lần — bỏ cuộc`);
  sendNotif('NHPOJ ❌ Điểm danh thất bại', `Đã thử ${MAX_RETRY} lần (2 tiếng).`);
  await logSignin(acc.username || '?', false, `Hết ${MAX_RETRY} lần retry`);
}

// ───────────────────────────────────────────────────────────────
// [BG-18/21] Auto-trigger: không cần nhấn nút
// Gọi khi startup và mỗi ALARM_POLL.
// [BG-21] Dùng checkSigninStatus() mới trả về { needSignIn, reason } | null
// ───────────────────────────────────────────────────────────────
async function checkAndAutoSignInIfNeeded() {
  try {
    const { account } = await chrome.storage.local.get('account');
    if (!account?.autoSignin) return;

    // Tránh chạy song song với runAutoSignIn đang pending
    const existingRun = await chrome.alarms.get(ALARM_SIGNIN_RUN);
    if (existingRun) {
      await log('DEBUG', 'AUTO_CHK', 'ALARM_SIGNIN_RUN đang chờ — không trigger thêm');
      return;
    }

    await log('INFO', 'AUTO_CHK', `Kiểm tra tự động (effectiveDate=${getEffectiveDateStr()})`);

    const statusResult = await checkSigninStatus();

    if (statusResult === null) {
      await log('WARN', 'AUTO_CHK', 'Không lấy được status — bỏ qua (lỗi mạng/chưa login)');
      return;
    }
    if (!statusResult.needSignIn) {
      await log('DEBUG', 'AUTO_CHK', `Đã điểm danh (${statusResult.reason}) — không cần làm gì`);
      return;
    }

    // needSignIn=true → kích hoạt sign-in ngay
    await log('INFO', 'AUTO_CHK', `⚡ Chưa điểm danh (effectiveDate="${statusResult.effectiveDate}") → auto sign-in ngay`);
    await runAutoSignIn();
  } catch (e) {
    await log('ERROR', 'AUTO_CHK', 'checkAndAutoSignInIfNeeded lỗi', e.message);
  }
}

// ───────────────────────────────────────────────────────────────
// Alarms
// ───────────────────────────────────────────────────────────────
async function scheduleSigninAlarm(timeStr) {
  const [h, m] = (timeStr || '00:01').split(':').map(Number);
  await chrome.alarms.clear(ALARM_SIGNIN);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  chrome.alarms.create(ALARM_SIGNIN, { when: t.getTime(), periodInMinutes: 24 * 60 });
  await log('INFO', 'ALARM', `Lên lịch điểm danh lúc ${t.toLocaleTimeString('vi-VN')}`);
}

async function schedulePollAlarm() {
  await chrome.alarms.clear(ALARM_POLL);
  chrome.alarms.create(ALARM_POLL, { periodInMinutes: POLL_MINUTES });
}

// [BG-11/14] CRITICAL FIX: Dùng chrome.alarms cho random delay thay vì setTimeout.
// setTimeout trong SW không đáng tin — Chrome có thể kill SW trước khi timeout fires.
// ALARM_SIGNIN → tạo ALARM_SIGNIN_RUN với delay ngẫu nhiên → runAutoSignIn()
// [BG-18] ALARM_POLL → thêm checkAndAutoSignInIfNeeded() sau AuthManager.refresh()
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name === ALARM_SIGNIN) {
    const delayMin = getRandomDelayMin();
    await log('INFO', 'AUTO', `Alarm trigger → random delay ${delayMin} phút → sẽ điểm danh`);
    await chrome.alarms.clear(ALARM_SIGNIN_RUN);
    chrome.alarms.create(ALARM_SIGNIN_RUN, { delayInMinutes: delayMin });
  }
  if (name === ALARM_SIGNIN_RUN) {
    await runAutoSignIn();
  }
  if (name === ALARM_POLL) {
    await AuthManager.refresh();
    // [BG-18] Sau mỗi lần poll (5 phút), kiểm tra tự động nếu chưa điểm danh
    await checkAndAutoSignInIfNeeded();
  }
});

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────
async function logSignin(username, success, message) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift({ username, success, message, time: new Date().toLocaleString('vi-VN') });
  if (logs.length > 100) logs.length = 100;
  await chrome.storage.local.set({ logs });
}

function sendNotif(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title, message, priority: 1 });
}

// ───────────────────────────────────────────────────────────────
// Message Handler
// [BG-9] FIX: thêm case 'DETECT_SESSION'
// [BG-8] FIX: UPDATE_SETTINGS whitelist field
// ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((m, _, sendResponse) => {
  handleMsg(m)
    .then(r  => { console.log('[MSG]', m.action, '→', r); sendResponse(r); })
    .catch(e => { console.error('[MSG ERR]', e);           sendResponse({ error: e.message }); });
  return true;
});

async function handleMsg({ action, payload = {} }) {
  switch (action) {

    case 'GET_ACCOUNT': {
      const state = UserCache.authState();
      if (state === 'LOGGED_IN' && !UserCache.isStale(60_000)) {
        return { account: UserCache.get(), authState: state, fromCache: true };
      }
      await AuthManager.warmFromStorage();
      return { account: UserCache.get(), authState: UserCache.authState(), fromCache: false };
    }

    // [BG-9] FIX: DETECT_SESSION — popup gửi khi không có cache
    // Background refresh và sẽ broadcast AUTH_CHANGED nếu đăng nhập
    case 'DETECT_SESSION': {
      await log('INFO', 'MSG', 'DETECT_SESSION — trigger refresh');
      AuthManager.refresh(); // không await — trả lời ngay, broadcast sẽ đến sau
      return { queued: true };
    }

    case 'CHECK_STATUS': {
      await log('INFO', 'MSG', 'CHECK_STATUS');
      const statusResult = await checkSigninStatus();

      if (statusResult === null) {
        // null → lỗi mạng hoặc data=null → xác minh lại bằng /api/profile
        await log('WARN', 'AUTO', 'checkSigninStatus null → fallback fetchProfile để xác minh login');
        const { loggedIn } = await fetchProfile();
        if (!loggedIn) {
          await chrome.storage.local.remove('account');
          UserCache.setLoggedOut();
          return { status: 'error', accountCleared: true, error: 'Phiên đăng nhập đã hết hạn.' };
        }
        await log('WARN', 'AUTO', 'fetchProfile OK nhưng /api/signin trả null — kiểm tra debug log');
        return { status: 'error', error: 'Không lấy được trạng thái điểm danh — kiểm tra debug log.' };
      }

      // [BG-21] Nếu chưa điểm danh + autoSignin bật → tự gửi POST ngầm
      if (statusResult.needSignIn) {
        const { account: accChk } = await chrome.storage.local.get('account');
        if (accChk?.autoSignin) {
          await log('INFO', 'AUTO', 'CHECK_STATUS: cần điểm danh + autoSignin → fire sign-in ngầm');
          runAutoSignIn(); // không await — chạy nền
        }
      }

      // Trả kết quả từ parseSigninResponse về popup
      return parseSigninResponse(await callSigninApi('GET'));
    }

    case 'SIGNIN_NOW': {
      await log('INFO', 'MSG', 'SIGNIN_NOW');
      const { loggedIn } = await fetchProfile();
      if (!loggedIn) {
        await chrome.storage.local.remove('account');
        UserCache.setLoggedOut();
        return { status: 'error', accountCleared: true, error: 'Phiên đăng nhập đã hết hạn.' };
      }
      const { account } = await chrome.storage.local.get('account');
      const result = parseSigninResponse(await callSigninApi('POST'));
      if (result.status === 'ok') {
        const { account: acc } = await chrome.storage.local.get('account');
        if (acc) {
          acc.lastSignin = new Date().toISOString();
          await chrome.storage.local.set({ account: acc });
          UserCache.setLoggedIn(acc);
          AuthManager._broadcast({ loggedIn: true, account: acc });
        }
        await logSignin(account?.username || '?', true, `Chuỗi: ${result.continueDays} ngày`);
      } else if (result.status !== 'auth_error') {
        await logSignin(account?.username || '?', false, result.error);
      }
      return result;
    }

    case 'UPDATE_SETTINGS': {
      const { account } = await chrome.storage.local.get('account');
      if (!account) return { success: false };
      // [BG-8] FIX: chỉ cho phép sửa 2 field an toàn — không dùng Object.assign tự do
      const ALLOWED = ['signinTime', 'autoSignin'];
      for (const key of ALLOWED) {
        if (key in payload) account[key] = payload[key];
      }
      await chrome.storage.local.set({ account });
      UserCache.setLoggedIn(account);
      if (account.autoSignin) await scheduleSigninAlarm(account.signinTime);
      else await chrome.alarms.clear(ALARM_SIGNIN);
      return { success: true };
    }

    case 'GET_LOGS':       { const { logs = [] }    = await chrome.storage.local.get('logs');    return { logs }; }
    case 'GET_DEV_LOGS':   { const { devlogs = [] } = await chrome.storage.local.get('devlogs'); return { devlogs }; }
    case 'CLEAR_LOGS':     { await chrome.storage.local.set({ logs: [] });    return { success: true }; }
    case 'CLEAR_DEV_LOGS': { await chrome.storage.local.set({ devlogs: [] }); return { success: true }; }

    default: return { error: `Hành động không xác định: ${action}` };
  }
}

// ───────────────────────────────────────────────────────────────
// Startup — [BG-4] await schedulePollAlarm; [BG-10] tránh double refresh
// ───────────────────────────────────────────────────────────────
async function _startup(reason) {
  await log('INFO', 'INIT', `Khởi động (${reason})`);
  await AuthManager.warmFromStorage();
  await schedulePollAlarm();
  await AuthManager.refresh();
  const { account } = await chrome.storage.local.get('account');
  if (account?.autoSignin) await scheduleSigninAlarm(account.signinTime);

  // [BG-18] Khi browser mở lại — nếu chưa điểm danh hôm nay + còn trước 7h → tự sign-in
  await checkAndAutoSignInIfNeeded();
}

chrome.runtime.onInstalled.addListener(() => _startup('installed/updated'));
chrome.runtime.onStartup.addListener(()   => _startup('browser-startup'));

// [BG-10] FIX: service worker wake — warm cache, chỉ refresh nếu thực sự stale
// Tránh double fetchProfile khi vừa chạy qua onInstalled/onStartup
AuthManager.warmFromStorage().then(() => {
  if (UserCache.isStale(30_000)) AuthManager.refresh();
});

log('INFO', 'INIT', 'Service worker v22 — [BG-21] logic ngày theo server +08:00 mốc 07:00, isSignedInToday(), bỏ deadline 7h trong retry');