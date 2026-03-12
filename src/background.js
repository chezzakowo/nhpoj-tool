'use strict';

const NHPOJ_BASE   = 'https://nhpoj.net';
const PROFILE_API  = `${NHPOJ_BASE}/api/profile`;
const SIGHIN_API   = `${NHPOJ_BASE}/api/sighin`;
const ALARM_SIGNIN     = 'nhpoj_signin';
const ALARM_SIGNIN_RUN = 'nhpoj_signin_run';
const ALARM_POLL       = 'nhpoj_poll';
const POLL_MINUTES     = 5;
const SERVER_UTC_OFFSET      = 8;
const SERVER_DAY_START_HOUR  = 7;
const MAX_RETRY              = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Timezone & Effective Date
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trả về thời điểm hiện tại được quy đổi sang múi giờ server (+08:00).
 * @returns {Date} Đối tượng Date với giờ/phút/giây tương ứng UTC+8.
 */
function nowInServerTz() {
  const nowUtcMs = Date.now() + new Date().getTimezoneOffset() * 60_000;
  return new Date(nowUtcMs + SERVER_UTC_OFFSET * 3_600_000);
}

/**
 * Trả về "ngày hiệu lực" theo quy tắc server: mốc bắt đầu ngày là 07:00 +08:00.
 * Nếu giờ server hiện tại < 07:00, ngày hiệu lực là ngày hôm qua.
 * @returns {string} Chuỗi định dạng "YYYY-MM-DD".
 */
function getEffectiveDateStr() {
  const serverNow = nowInServerTz();
  if (serverNow.getHours() < SERVER_DAY_START_HOUR) {
    serverNow.setDate(serverNow.getDate() - 1);
  }
  const y  = serverNow.getFullYear();
  const mo = String(serverNow.getMonth() + 1).padStart(2, '0');
  const d  = String(serverNow.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/**
 * Kiểm tra xem thời điểm điểm danh gần nhất có thuộc ngày hiệu lực hiện tại không.
 * @param {string|null} lastSigninTime - Chuỗi "YYYY-MM-DD" trả về từ server.
 * @returns {boolean} `true` nếu đã điểm danh trong ngày hiệu lực.
 */
function isSignedInToday(lastSigninTime) {
  if (!lastSigninTime) return false;
  return lastSigninTime >= getEffectiveDateStr();
}

/**
 * Alias tương thích ngược — trả về ngày hiệu lực theo server.
 * @returns {string} Chuỗi định dạng "YYYY-MM-DD".
 */
function getLocalDateStr() {
  return getEffectiveDateStr();
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ghi log vào console và lưu vào `chrome.storage.local` (tối đa 300 bản ghi).
 * @param {'DEBUG'|'INFO'|'OK'|'WARN'|'ERROR'} level - Mức độ log.
 * @param {string} cat   - Danh mục / module phát sinh log.
 * @param {string} msg   - Nội dung thông điệp.
 * @param {*}      [data] - Dữ liệu bổ sung tuỳ chọn (sẽ được JSON.stringify).
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Rank
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trả về danh hiệu tương ứng với điểm kinh nghiệm của người dùng.
 * @param {number|string} exp - Điểm kinh nghiệm.
 * @returns {string|null} Danh hiệu, hoặc `null` nếu giá trị không hợp lệ.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// CSRF Token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lấy giá trị CSRF token từ cookie của trang NHPOJ.
 * @returns {Promise<string|null>} Giá trị token, hoặc `null` nếu không tìm thấy.
 */
async function getCsrfToken() {
  try {
    const cookie = await chrome.cookies.get({ url: NHPOJ_BASE, name: 'csrftoken' });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gọi GET `/api/profile` để xác minh trạng thái đăng nhập và lấy thông tin người dùng.
 * @returns {Promise<{loggedIn: boolean, raw: object|null, error?: string}>}
 *   - `loggedIn`: `true` nếu server trả về data hợp lệ.
 *   - `raw`: Dữ liệu thô từ server, hoặc `null` nếu chưa đăng nhập / lỗi.
 */
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

/**
 * Xây dựng đối tượng `account` từ dữ liệu profile thô và thông tin được lưu trước đó.
 * Bảo toàn các trường tuỳ chỉnh (signinTime, autoSignin, lastSignin) nếu cùng user.
 * @param {object|null} data - Dữ liệu profile thô từ server.
 * @param {object|null} prev - Dữ liệu account đang lưu trong storage.
 * @returns {object|null} Đối tượng account chuẩn hoá, hoặc `null` nếu `data` rỗng.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// UserCache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bộ nhớ đệm trong bộ nhớ cho thông tin tài khoản và trạng thái xác thực.
 * Giảm số lần gọi storage/network khi nhiều thành phần cùng truy vấn.
 */
const UserCache = {
  _account: null, _cachedAt: 0, _authState: 'UNKNOWN',

  /** Lưu tài khoản vào cache và đánh dấu trạng thái LOGGED_IN. */
  setLoggedIn(a)  { this._account = {...a}; this._cachedAt = Date.now(); this._authState = 'LOGGED_IN'; },

  /** Xoá cache tài khoản và đánh dấu trạng thái LOGGED_OUT. */
  setLoggedOut()  { this._account = null;   this._cachedAt = Date.now(); this._authState = 'LOGGED_OUT'; },

  /** Xoá toàn bộ cache, đặt lại trạng thái về UNKNOWN. */
  clear()         { this._account = null;   this._cachedAt = 0;          this._authState = 'UNKNOWN'; },

  /** Trả về đối tượng account đang được cache, hoặc `null`. */
  get()           { return this._account; },

  /** Trả về chuỗi trạng thái xác thực hiện tại: 'UNKNOWN' | 'LOGGED_IN' | 'LOGGED_OUT'. */
  authState()     { return this._authState; },

  /**
   * Kiểm tra cache có cũ quá ngưỡng cho phép không.
   * @param {number} [ms=60000] - Ngưỡng thời gian tính bằng mili-giây.
   * @returns {boolean} `true` nếu cache đã cũ.
   */
  isStale(ms = 60_000) { return (Date.now() - this._cachedAt) > ms; },
};

// ─────────────────────────────────────────────────────────────────────────────
// AuthManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quản lý vòng đời xác thực: làm mới thông tin người dùng, đồng bộ storage,
 * cập nhật cache và phát sự kiện thay đổi trạng thái đến các thành phần khác.
 */
const AuthManager = {
  _busy: false,

  /**
   * Làm mới trạng thái xác thực bằng cách gọi `/api/profile`.
   * Tự động cập nhật storage, cache và lên lịch alarm điểm danh nếu cần.
   * Có cơ chế chống gọi đồng thời (chỉ chạy một lần tại một thời điểm).
   */
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

  /**
   * Phát sự kiện `AUTH_CHANGED` đến tất cả các listener (popup, content script).
   * @param {object} payload - Dữ liệu đính kèm sự kiện.
   */
  _broadcast(payload) {
    chrome.runtime.sendMessage({ action: 'AUTH_CHANGED', payload }).catch(() => {});
  },

  /**
   * Tải trạng thái tài khoản từ `chrome.storage.local` vào bộ nhớ đệm.
   * Dùng khi service worker vừa thức dậy để tránh gọi network ngay lập tức.
   */
  async warmFromStorage() {
    const { account } = await chrome.storage.local.get('account');
    if (account) UserCache.setLoggedIn(account);
    else UserCache.clear();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Cookie Tracker
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_COOKIES = new Set(['csrftoken', 'sessionid']);
let _cookieDebounceTimer = null;

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (!changeInfo.cookie.domain.includes('nhpoj.net')) return;
  if (!SESSION_COOKIES.has(changeInfo.cookie.name)) return;
  log('DEBUG', 'COOKIE', `"${changeInfo.cookie.name}" thay đổi (${changeInfo.cause})`);
  clearTimeout(_cookieDebounceTimer);
  _cookieDebounceTimer = setTimeout(() => AuthManager.refresh(), 1500);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sign-in API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gọi API điểm danh `/api/sighin` với phương thức GET hoặc POST.
 * @param {'GET'|'POST'} method - Phương thức HTTP cần dùng.
 * @returns {Promise<{ok: boolean, status: number, data?: object, error?: string}>}
 *   Kết quả phản hồi thô từ server, hoặc thông tin lỗi nếu request thất bại.
 */
async function callSigninApi(method) {
  const csrf = await getCsrfToken();
  try {
    await log('INFO', 'SIGNIN', `${method} ${SIGHIN_API}`);
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

/**
 * Phân tích phản hồi thô từ API điểm danh thành trạng thái có cấu trúc.
 *
 * Logic xác định đã điểm danh:
 *  - `sighinstatus === true` hoặc `"true"` → đã điểm danh (server xác nhận).
 *  - `sighinstatus === "false"` nhưng `last_sighin_time >= effectiveDate` → vẫn coi là đã điểm danh.
 *  - `data === null` → lỗi mạng hoặc hết phiên → không POST.
 *
 * @param {object} r - Đối tượng phản hồi từ `callSigninApi`.
 * @returns {{
 *   status: 'ok'|'error'|'auth_error',
 *   signed?: boolean,
 *   alreadySignedIn?: boolean,
 *   today?: boolean,
 *   continueDays?: number|null,
 *   lastSigninTime?: string|null,
 *   effectiveDate?: string,
 *   raw?: object,
 *   error?: string
 * }}
 */
function parseSigninResponse(r) {
  if (!r) return { status: 'error', error: 'Không có phản hồi' };
  if (r.error && !r.data) return { status: 'error', error: r.error };
  if (!r.ok) {
    if (r.status === 401 || r.status === 403)
      return { status: 'auth_error', error: `Phiên hết hạn (${r.status})` };
    return { status: 'error', error: r.error || `HTTP ${r.status}` };
  }
  if (r.data?.error) return { status: 'error', error: String(r.data.error) };

  const d = r.data?.data;
  if (d === null || d === undefined) {
    return { status: 'error', error: 'Server trả data=null (lỗi mạng hoặc hết phiên)' };
  }

  const effectiveDate   = getEffectiveDateStr();
  const lastTime        = d?.last_sighin_time ?? null;
  const signedByStatus  = d?.sighinstatus === true || d?.sighinstatus === 'true';
  const signedByDate    = isSignedInToday(lastTime);
  const alreadySignedIn = signedByStatus || signedByDate;

  return {
    status: 'ok',
    signed:          signedByStatus,
    alreadySignedIn,
    today:           alreadySignedIn,
    continueDays:    d?.continue_sighin_days ?? null,
    lastSigninTime:  lastTime,
    effectiveDate,
    raw: r.data
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto Sign-in Core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tạo số phút trễ ngẫu nhiên trong khoảng [1, 20] để tránh gửi request đồng thời.
 * @returns {number} Số phút trễ.
 */
function getRandomDelayMin() {
  return Math.floor(Math.random() * 20) + 1;
}

/**
 * Dừng thực thi trong một khoảng thời gian xác định.
 * @param {number} ms - Thời gian chờ tính bằng mili-giây.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kiểm tra trạng thái điểm danh hiện tại bằng cách gọi GET `/api/sighin`.
 *
 * Trả về:
 *  - `{ needSignIn: false, reason }` — đã điểm danh trong ngày hiệu lực, không cần POST.
 *  - `{ needSignIn: true, lastTime, effectiveDate }` — chưa điểm danh, cần POST.
 *  - `null` — lỗi mạng, `data=null`, hoặc chưa đăng nhập; không nên POST.
 *
 * @returns {Promise<{needSignIn: boolean, reason?: string, lastTime?: string, effectiveDate?: string}|null>}
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

    const inner =
      json?.data?.data ??
      json?.data       ??
      json             ??
      null;

    if (inner === null || typeof inner !== 'object') {
      await log('WARN', 'AUTO', 'checkSigninStatus: data=null hoặc không phải object → lỗi mạng/hết phiên', { json });
      return null;
    }

    if (!('sighinstatus' in inner)) {
      await log('WARN', 'AUTO', 'checkSigninStatus: sighinstatus không có trong response', { inner });
      return null;
    }

    const rawStatus     = inner.sighinstatus;
    const statusStr     = String(rawStatus);
    const lastTime      = inner.last_sighin_time ?? null;
    const effectiveDate = getEffectiveDateStr();

    await log('DEBUG', 'AUTO',
      `checkSigninStatus → sighinstatus="${statusStr}" last="${lastTime}" ` +
      `effectiveDate="${effectiveDate}" days=${inner.continue_sighin_days}`
    );

    if (statusStr === 'true') {
      await log('OK', 'AUTO', 'sighinstatus="true" → đã điểm danh');
      return { needSignIn: false, reason: 'sighinstatus=true' };
    }

    if (statusStr === 'false') {
      if (isSignedInToday(lastTime)) {
        await log('OK', 'AUTO',
          `sighinstatus="false" nhưng last_sighin_time="${lastTime}" >= effectiveDate="${effectiveDate}" → đã điểm danh`
        );
        return { needSignIn: false, reason: 'lastSigninTime>=effectiveDate' };
      }
      await log('INFO', 'AUTO',
        `sighinstatus="false" + last_sighin_time="${lastTime}" < effectiveDate="${effectiveDate}" → CẦN điểm danh`
      );
      return { needSignIn: true, lastTime, effectiveDate };
    }

    await log('WARN', 'AUTO', `checkSigninStatus: sighinstatus không xác định "${statusStr}"`, { inner });
    return null;

  } catch (e) {
    await log('ERROR', 'AUTO', 'checkSigninStatus lỗi', e.message);
    return null;
  }
}

/**
 * Gửi POST `/api/sighin` để thực hiện điểm danh.
 * @returns {Promise<boolean>} `true` nếu server xác nhận thành công (`data.error === null`).
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
    return json?.data?.error === null;
  } catch (e) {
    await log('ERROR', 'AUTO', 'sendSignInPost lỗi', e.message);
    return false;
  }
}

/**
 * Luồng điểm danh tự động đầy đủ, chạy hoàn toàn ngầm.
 *
 * Bước 1: GET `/api/profile` — xác minh đăng nhập. Nếu chưa đăng nhập, dừng.
 * Bước 2: GET `/api/sighin` — kiểm tra trạng thái. Nếu đã điểm danh, thoát.
 * Bước 3: POST loop — gửi điểm danh tối đa `MAX_RETRY` lần, cách nhau 1 phút.
 *
 * Server là nguồn dữ liệu duy nhất; không có deadline cứng về giờ phía client.
 */
async function runAutoSignIn() {
  await log('INFO', 'AUTO', '━━━ runAutoSignIn bắt đầu ━━━');
  await chrome.alarms.clear(ALARM_SIGNIN_RUN);

  const { account: acc } = await chrome.storage.local.get('account');
  if (!acc?.autoSignin) {
    await log('DEBUG', 'AUTO', 'autoSignin=off — bỏ qua');
    return;
  }

  await log('INFO', 'AUTO', 'Bước 1: xác minh đăng nhập qua /api/profile');
  const { loggedIn } = await fetchProfile();
  if (!loggedIn) {
    await log('WARN', 'AUTO', '/api/profile trả data=null → chưa đăng nhập → không POST');
    await logSignin(acc.username || '?', false, 'Chưa đăng nhập (profile=null)');
    return;
  }

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

  await log('ERROR', 'AUTO', `Hết ${MAX_RETRY} lần — bỏ cuộc`);
  sendNotif('NHPOJ ❌ Điểm danh thất bại', `Đã thử ${MAX_RETRY} lần (2 tiếng).`);
  await logSignin(acc.username || '?', false, `Hết ${MAX_RETRY} lần retry`);
}

/**
 * Kiểm tra nhanh và tự kích hoạt điểm danh nếu cần.
 * Được gọi khi browser khởi động và sau mỗi chu kỳ poll.
 * Không làm gì nếu đã điểm danh, autoSignin tắt, hoặc đang có luồng chờ.
 */
async function checkAndAutoSignInIfNeeded() {
  try {
    const { account } = await chrome.storage.local.get('account');
    if (!account?.autoSignin) return;

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

    await log('INFO', 'AUTO_CHK', `⚡ Chưa điểm danh (effectiveDate="${statusResult.effectiveDate}") → auto sign-in ngay`);
    await runAutoSignIn();
  } catch (e) {
    await log('ERROR', 'AUTO_CHK', 'checkAndAutoSignInIfNeeded lỗi', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alarm Scheduling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lên lịch alarm điểm danh hàng ngày vào giờ chỉ định.
 * Nếu giờ chỉ định đã qua trong ngày hiện tại, alarm sẽ kích hoạt vào ngày hôm sau.
 * @param {string} timeStr - Chuỗi giờ dạng "HH:MM", ví dụ "07:30".
 */
async function scheduleSigninAlarm(timeStr) {
  const [h, m] = (timeStr || '00:01').split(':').map(Number);
  await chrome.alarms.clear(ALARM_SIGNIN);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  chrome.alarms.create(ALARM_SIGNIN, { when: t.getTime(), periodInMinutes: 24 * 60 });
  await log('INFO', 'ALARM', `Lên lịch điểm danh lúc ${t.toLocaleTimeString('vi-VN')}`);
}

/**
 * Khởi tạo alarm poll định kỳ mỗi `POLL_MINUTES` phút.
 * Alarm cũ sẽ bị xoá trước khi tạo mới để tránh chồng chéo.
 */
async function schedulePollAlarm() {
  await chrome.alarms.clear(ALARM_POLL);
  chrome.alarms.create(ALARM_POLL, { periodInMinutes: POLL_MINUTES });
}

/**
 * Xử lý các alarm được kích hoạt:
 *  - `ALARM_SIGNIN`     → Tạo `ALARM_SIGNIN_RUN` với độ trễ ngẫu nhiên 1–20 phút.
 *  - `ALARM_SIGNIN_RUN` → Thực thi `runAutoSignIn()`.
 *  - `ALARM_POLL`       → Làm mới auth + kiểm tra điểm danh tự động.
 */
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
    await checkAndAutoSignInIfNeeded();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ghi một bản ghi lịch sử điểm danh vào `chrome.storage.local` (tối đa 100 bản ghi).
 * @param {string}  username - Tên người dùng.
 * @param {boolean} success  - `true` nếu điểm danh thành công.
 * @param {string}  message  - Mô tả kết quả hoặc nguyên nhân thất bại.
 */
async function logSignin(username, success, message) {
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift({ username, success, message, time: new Date().toLocaleString('vi-VN') });
  if (logs.length > 100) logs.length = 100;
  await chrome.storage.local.set({ logs });
}

/**
 * Hiển thị thông báo hệ thống (Chrome Notification API).
 * @param {string} title   - Tiêu đề thông báo.
 * @param {string} message - Nội dung thông báo.
 */
function sendNotif(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title, message, priority: 1 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((m, _, sendResponse) => {
  handleMsg(m)
    .then(r  => { console.log('[MSG]', m.action, '→', r); sendResponse(r); })
    .catch(e => { console.error('[MSG ERR]', e);           sendResponse({ error: e.message }); });
  return true;
});

/**
 * Điều phối các message từ popup hoặc content script.
 *
 * Các action được hỗ trợ:
 *  - `GET_ACCOUNT`    — Lấy thông tin tài khoản từ cache hoặc storage.
 *  - `DETECT_SESSION` — Kích hoạt refresh auth ngầm, trả lời ngay.
 *  - `CHECK_STATUS`   — Kiểm tra trạng thái điểm danh, tự kích hoạt nếu cần.
 *  - `SIGNIN_NOW`     — Điểm danh thủ công ngay lập tức.
 *  - `UPDATE_SETTINGS`— Cập nhật signinTime / autoSignin (whitelist field).
 *  - `GET_LOGS`       — Lấy lịch sử điểm danh.
 *  - `GET_DEV_LOGS`   — Lấy debug logs.
 *  - `CLEAR_LOGS`     — Xoá lịch sử điểm danh.
 *  - `CLEAR_DEV_LOGS` — Xoá debug logs.
 *
 * @param {{action: string, payload?: object}} param0 - Message nhận được.
 * @returns {Promise<object>} Kết quả trả về cho sender.
 */
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

    case 'DETECT_SESSION': {
      await log('INFO', 'MSG', 'DETECT_SESSION — trigger refresh');
      AuthManager.refresh();
      return { queued: true };
    }

    case 'CHECK_STATUS': {
      await log('INFO', 'MSG', 'CHECK_STATUS');
      const statusResult = await checkSigninStatus();

      if (statusResult === null) {
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

      if (statusResult.needSignIn) {
        const { account: accChk } = await chrome.storage.local.get('account');
        if (accChk?.autoSignin) {
          await log('INFO', 'AUTO', 'CHECK_STATUS: cần điểm danh + autoSignin → fire sign-in ngầm');
          runAutoSignIn();
        }
      }

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

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Khởi tạo extension: warm cache, lên lịch poll alarm, refresh auth,
 * khôi phục alarm điểm danh, và kiểm tra tự động nếu chưa điểm danh.
 * @param {'installed/updated'|'browser-startup'} reason - Lý do khởi động.
 */
async function _startup(reason) {
  await log('INFO', 'INIT', `Khởi động (${reason})`);
  await AuthManager.warmFromStorage();
  await schedulePollAlarm();
  await AuthManager.refresh();
  const { account } = await chrome.storage.local.get('account');
  if (account?.autoSignin) await scheduleSigninAlarm(account.signinTime);
  await checkAndAutoSignInIfNeeded();
}

chrome.runtime.onInstalled.addListener(() => _startup('installed/updated'));
chrome.runtime.onStartup.addListener(()   => _startup('browser-startup'));

AuthManager.warmFromStorage().then(() => {
  if (UserCache.isStale(30_000)) AuthManager.refresh();
});

log('INFO', 'INIT', 'Service worker v22 — logic ngày theo server +08:00 mốc 07:00');
