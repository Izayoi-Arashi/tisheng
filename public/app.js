/* Tisheng · Vue 3 前端（vendor 本地化，无构建步骤） */
"use strict";

const { createApp, reactive, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

// ================= 响应式全局状态 =================
const S = reactive({
  booted: false,
  me: null, // {username, uid}
  view: "banks", // login|banks|home|study|wrong|me|account|privacy
  bankId: null, // 当前题库
  bank: null, // 当前题库数据（学习态，无答案）
  cloudLoaded: false,
  progress: { q: {}, d: {} }, // 当前题库进度
  progressCache: {}, // bankId -> 进度（访问过的题库）
  pending: [], // 待同步增量（仅云备份）
  ach: {}, // 成就解锁记录（id -> 时间戳，云同步）
  achTier: {}, // 成就当前档位（id -> 0-3，进阶成就随指标增长）
  equip: [], // 佩戴中的成就徽章（最多 3 枚 id，云同步）
  rankEq: {}, // 排行榜各用户的佩戴（uid -> 装备数组，客户端拉取缓存）
  study: null, // 答题会话
  studyConf: null, // { mode: "module"|"wrong"|"single"|"endless", modIdx, qid, scope }
  studyRev: 0, // 递增以强制重建学习会话（同模式重启时使用）
  endlessScope: null, // 上次选择的无尽模式题源（记住选择）
  tsCfgFetched: false,
  tsSiteKey: null,
  ui: { importOpen: false, actId: null, settingsOpen: false, avatarOpen: false },
  avatar: null, // {t, d} 云端头像
  impName: "",
  impJson: "",
  impErr: "",
  impBusy: false,
  actBusy: false,
  tsToken: null, // 账号页共用验证令牌
  tsId: undefined,
  banksRev: 0, // 题库列表刷新信号（localStorage 变化不触发响应式）
  filterRev: 0, // 题集列表刷新信号（localStorage 变化不触发响应式）
  filterSync: { state: "idle", at: 0 },
});

// ================= 基础工具 =================
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const REDUCED_MOTION = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ================= 持久化 =================
const bankKey = (id) => `ts_bank_${id}`;
const progKey = (id) => `ts_prog_${id}`;
const PEND_KEY = "ts_pend_v1";
const LOCAL_BANKS_KEY = "ts_local_banks_v1";
const FILTER_SETS_KEY_BASE = "ts_filter_sets_v1";
const FILTER_TOMBSTONE_TTL = 90 * 86400_000;
const FILTER_SET_LIMIT = 200;

function getLocalBanks() {
  try { return JSON.parse(localStorage.getItem(LOCAL_BANKS_KEY)) || []; } catch { return []; }
}

function filterSetsKey() {
  const uid = S.me && S.me.uid ? S.me.uid : "guest";
  return `${FILTER_SETS_KEY_BASE}_${uid}`;
}
function normalizeStoredFilterSets(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && typeof item.id === "string").map((item) => ({ ...item, filters: item.filters && typeof item.filters === "object" ? item.filters : {} }));
}
function getStoredFilterSets() {
  try { return normalizeStoredFilterSets(JSON.parse(localStorage.getItem(filterSetsKey()))); } catch { return []; }
}
function getFilterSets() { return getStoredFilterSets().filter((x) => !x.deleted); }
function saveFilterSets(list) {
  localStorage.setItem(filterSetsKey(), JSON.stringify(normalizeStoredFilterSets(list)));
}
function mergeFilterSets(a, b) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    if (!item || typeof item !== "object" || !item.id) continue;
    const old = map.get(item.id);
    const at = Number(item.updatedAt || item.createdAt || 0);
    const bt = old ? Number(old.updatedAt || old.createdAt || 0) : -1;
    if (!old || at >= bt) map.set(item.id, item);
  }
  const now = Date.now();
  return [...map.values()].filter((item) => !item.deleted || now - Number(item.updatedAt || item.createdAt || 0) < FILTER_TOMBSTONE_TTL).sort((x, y) => Number(y.updatedAt || y.createdAt || 0) - Number(x.updatedAt || x.createdAt || 0));
}
let filterSyncBusy = false;
let filterSyncAgain = false;
let pendingRestoreFilterSets = null;
async function syncFilterSets() {
  if (!S.me) return false;
  if (filterSyncBusy) { filterSyncAgain = true; return false; }
  filterSyncBusy = true;
  S.filterSync = { state: "syncing", at: Date.now() };
  try {
    do {
      filterSyncAgain = false;
      const r = await api("/api/collections");
      const merged = mergeFilterSets(getStoredFilterSets(), Array.isArray(r.sets) ? r.sets : []);
      saveFilterSets(merged);
      S.filterRev++;
      await api("/api/collections", { method: "PUT", body: { sets: merged } });
    } while (filterSyncAgain);
    S.filterSync = { state: "ok", at: Date.now() };
    return true;
  } catch {
    S.filterSync = { state: "error", at: Date.now() };
    return false;
  } finally {
    filterSyncBusy = false;
  }
}
function saveLocalBanks(list) {
  localStorage.setItem(LOCAL_BANKS_KEY, JSON.stringify(list));
}
function getLocalBank(id) {
  return getLocalBanks().find((b) => b.id === id) || null;
}
function removeLocalBank(id) {
  saveLocalBanks(getLocalBanks().filter((b) => b.id !== id));
  localStorage.removeItem(bankKey(id));
  localStorage.removeItem(progKey(id));
  delete S.progressCache[id];
}
function loadProg(id) {
  try { return JSON.parse(localStorage.getItem(progKey(id))) || { q: {}, d: {} }; } catch { return { q: {}, d: {} }; }
}
function saveProg(id, p) {
  localStorage.setItem(progKey(id || (S.bank && S.bank.id)), JSON.stringify(p));
}
function progStats(p) {
  const vals = Object.values((p && p.q) || {});
  return {
    mastered: vals.filter((v) => v.s === "m").length,
    learning: vals.filter((v) => v.s === "l").length,
    wrong: vals.filter((v) => v.s === "w").length,
  };
}
function loadLocal() {
  try {
    const pend = JSON.parse(localStorage.getItem(PEND_KEY));
    if (Array.isArray(pend)) S.pending = pend;
  } catch {}
}
function savePendLocal() {
  localStorage.setItem(PEND_KEY, JSON.stringify(S.pending));
}
// 跨题库合并的每日答题数（打卡/日历/周图/成就判定）
function mergedDays() {
  const merged = {};
  for (const p of Object.values(S.progressCache)) {
    for (const [k, v] of Object.entries(p.d || {})) merged[k] = (merged[k] || 0) + v;
  }
  // 进度缓存只含访问过的题库，未访问的本地题库打卡史从存储补上
  for (const b of getLocalBanks()) {
    if (S.progressCache[b.id]) continue;
    for (const [k, v] of Object.entries(loadProg(b.id).d || {})) merged[k] = (merged[k] || 0) + v;
  }
  return merged;
}
function calcStreak(days) {
  const DAY = 86400000;
  const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  let streak = 0;
  let cursor = new Date(today0);
  if (!((days[keyOf(cursor)] || 0) > 0)) cursor = new Date(today0.getTime() - DAY);
  while ((days[keyOf(cursor)] || 0) > 0) {
    streak++;
    cursor = new Date(cursor.getTime() - DAY);
  }
  return streak;
}
// 清空账号数据，但保留设备上的本地题库及其进度
function clearAccountStorage(uid = S.me && S.me.uid) {
  actPend = {};
  const theme = localStorage.getItem("ts_theme");
  const banks = getLocalBanks();
  const progs = banks.map((b) => ({ id: b.id, p: loadProg(b.id) }));
  localStorage.clear();
  localStorage.removeItem(`${FILTER_SETS_KEY_BASE}_guest`);
  localStorage.removeItem(FILTER_SETS_KEY_BASE);
  if (uid) localStorage.removeItem(`${FILTER_SETS_KEY_BASE}_${uid}`);
  if (theme) localStorage.setItem("ts_theme", theme);
  saveLocalBanks(banks);
  progs.forEach((x) => localStorage.setItem(progKey(x.id), JSON.stringify(x.p)));
}

// ================= API =================
async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      // 字符串 body 视为已序列化，直接透传；其余类型自动 JSON 序列化
      body: opts.body === undefined ? undefined : (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    const e = new Error("网络异常，请检查网络后重试");
    e.status = 0;
    throw e;
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error((data && data.error) || `请求失败 (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// 备份文件在导出前用独立密码客户端加密；密码不发给服务端
function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(value) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function backupCryptoKey(password, salt, usages) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310000 }, base, { name: "AES-GCM", length: 256 }, false, usages);
}
async function sealBackupVault(vault, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await backupCryptoKey(password, salt, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(vault)));
  return { fmt: "tisheng-client-vault", v: 1, kdf: "PBKDF2-SHA256-310000", salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(data)) };
}
async function openBackupVault(packaged, password) {
  if (!packaged || packaged.fmt !== "tisheng-client-vault" || !packaged.salt || !packaged.iv || !packaged.data) throw new Error("备份文件格式不支持");
  const key = await backupCryptoKey(password, b64ToBytes(packaged.salt), ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(packaged.iv) }, key, b64ToBytes(packaged.data));
  } catch { throw new Error("备份密码错误"); }
  return JSON.parse(new TextDecoder().decode(plain));
}
async function unpackBackupFile(raw) {
  if (!raw || typeof raw !== "object") throw new Error("备份文件格式不支持");
  if (raw.fmt !== "tisheng-client-vault") return raw; // 兼容旧版服务端加密备份
  const password = prompt("请输入备份密码");
  if (password === null) return null;
  if (!password) throw new Error("请输入备份密码");
  return openBackupVault(raw, password);
}

let syncing = false;
async function flushSync() {
  if (syncing || !S.me || S.pending.length === 0) return;
  syncing = true;
  const batch = S.pending.splice(0, 300);
  const note = showEdgeBanner('<i class="spin"></i>同步中......', "", 0, { sticky: true, html: true });
  try {
    await api("/api/progress", { method: "POST", body: { d: batch } });
    savePendLocal();
    note.set("同步成功");
    note.close(900);
  } catch {
    S.pending.unshift(...batch);
    savePendLocal();
    note.set("同步失败");
    note.close(1400);
  } finally {
    syncing = false;
  }
}

// 排行榜活动量：每日答题总数（云备份 + 本地题库都计入），仅上报数量不含题目内容
let actPend = (() => { try { return JSON.parse(localStorage.getItem("ts_act")) || {}; } catch { return {}; } })();
let actLast = 0;
function recordActivity(n) {
  const day = todayStr();
  actPend[day] = (actPend[day] || 0) + n;
  localStorage.setItem("ts_act", JSON.stringify(actPend));
}
async function flushActivity() {
  if (!S.me || !Object.keys(actPend).length) return;
  const now = Date.now();
  if (now - actLast < 20_000) return; // 聚合上报，别每题一请求
  actLast = now;
  const d = actPend;
  actPend = {};
  try {
    await api("/api/activity", { method: "POST", body: { d, eq: S.equip } });
    localStorage.setItem("ts_act", "{}");
  } catch {
    for (const [k, v] of Object.entries(d)) actPend[k] = (actPend[k] || 0) + v;
    localStorage.setItem("ts_act", JSON.stringify(actPend));
  }
}

// 佩戴徽章：本地即时生效，PUT /api/equip 云同步（失败进待重传队列）
async function saveEquip(list) {
  S.equip = list;
  localStorage.setItem("ts_equip", JSON.stringify(list));
  if (!S.me) return;
  try {
    const r = await api("/api/equip", { method: "PUT", body: { eq: list } });
    S.equip = Array.isArray(r.eq) ? r.eq : list; // 以服务端校验结果为准
    localStorage.setItem("ts_equip", JSON.stringify(S.equip));
    localStorage.removeItem("ts_equippend");
  } catch {
    localStorage.setItem("ts_equippend", JSON.stringify(list));
  }
}
async function flushEquipPend() {
  if (!S.me) return;
  let pend = null;
  try { pend = JSON.parse(localStorage.getItem("ts_equippend") || "null"); } catch {}
  if (!pend) return;
  try {
    const r = await api("/api/equip", { method: "PUT", body: { eq: pend } });
    S.equip = Array.isArray(r.eq) ? r.eq : S.equip;
    localStorage.removeItem("ts_equippend");
  } catch {}
}

// 登录/启动时全量校准排行榜历史：云端 + 本地题库的每日答题数回传，
// 服务端按较大值落库（幂等），首次登录也能立刻看到历史答题量
async function backfillActivity() {
  if (!S.me) return;
  if (Date.now() - +(localStorage.getItem("ts_actfull") || 0) < 12 * 3600_000) return;
  try {
    const r = await api("/api/mybank"); // 云题库打卡史（服务端为准）
    const all = Object.assign({}, (r.progress && r.progress.d) || {});
    for (const b of getLocalBanks()) {
      for (const [k, v] of Object.entries(loadProg(b.id).d || {})) all[k] = (all[k] || 0) + v;
    }
    // 排行榜窗口最多看近 30 天（键 40 天过期），校准回传最近 35 天，分片避开子请求上限
    const days = Object.keys(all).filter((k) => all[k] > 0).sort().slice(-35);
    for (let i = 0; i < days.length; i += 20) {
      const chunk = {};
      for (const day of days.slice(i, i + 20)) chunk[day] = all[day];
      await api("/api/activity", { method: "POST", body: { d: chunk, init: true, eq: S.equip } });
    }
    localStorage.setItem("ts_actfull", String(Date.now()));
  } catch {}
}

// ================= 成就系统 =================
// 判定在客户端（数据不出设备的模型不变），解锁记录经 /api/ach 云同步
// tiers 非空的为三档进阶成就（1 墨 / 2 银 / 3 金），档位随指标增长自动升档；其余为独立成就
const ACHIEVEMENTS = [
  { id: "first_checkin", name: "初来乍到", icon: "calendar-check", cat: 0, tier: 1, desc: "完成第一次打卡", check: (c) => c.daysN >= 1 },
  { id: "streak_ladder", name: "持之以恒", icon: "flame", cat: 0, tiers: [3, 7, 30], descs: ["连续打卡 3 天", "连续打卡 7 天", "连续打卡 30 天"], metric: (c) => c.streak },
  { id: "streak_100", name: "百日长征", icon: "mountain", cat: 0, tier: 3, desc: "连续打卡 100 天", check: (c) => c.streak >= 100 },
  { id: "days_total", name: "日积月累", icon: "calendar-days", cat: 0, tiers: [10, 50, 200], descs: ["累计打卡 10 天", "累计打卡 50 天", "累计打卡 200 天"], metric: (c) => c.daysN },
  { id: "first_kill", name: "开门红", icon: "medal", cat: 1, tier: 1, desc: "掌握第一道题", check: (c) => c.killed >= 1 },
  { id: "kill_ladder", name: "掌握之路", icon: "swords", cat: 1, tiers: [50, 200, 1000], descs: ["累计掌握 50 题", "累计掌握 200 题", "累计掌握 1000 题"], metric: (c) => c.killed },
  { id: "bank_clear", name: "题库终结者", icon: "trophy", cat: 1, tier: 3, desc: "掌握一个题库的全部题目", check: (c) => c.bankClear },
  { id: "answers_day", name: "单日冲刺", icon: "zap", cat: 2, tiers: [50, 200, 500], descs: ["单日答题 50 题", "单日答题 200 题", "单日答题 500 题"], metric: (c) => c.maxDay },
  { id: "answers_total", name: "题海无涯", icon: "gauge", cat: 2, tiers: [200, 1000, 5000], descs: ["累计答题 200 题", "累计答题 1000 题", "累计答题 5000 题"], metric: (c) => c.totalN },
  { id: "perfect_round", name: "百步穿杨", icon: "crosshair", cat: 3, tier: 2, desc: "单轮 20 题以上全对", check: null }, // 会话结束时判定
  { id: "wrong_ladder", name: "扫地僧", icon: "sparkles", cat: 3, tiers: [10, 30, 100], descs: ["累计攻克错题 10 题", "累计攻克错题 30 题", "累计攻克错题 100 题"], metric: (c) => c.wfix },
  { id: "night_owl", name: "夜猫子", icon: "moon", cat: 3, tier: 1, desc: "在凌晨 0-5 点刷题", check: null }, // 答题时判定
  { id: "all_ach", name: "大满贯", icon: "gem", cat: 4, tier: 3, desc: "解锁其他全部成就", check: null }, // 其余成就全解锁时判定
];
const achPrevTier = {}; // 上次评估的档位（升档横幅用，首轮只建基线不提醒）
let achPend = (() => { try { return JSON.parse(localStorage.getItem("ts_achpend")) || {}; } catch { return {}; } })();
let achEvalTimer = null;

function unlockCore(id) {
  if (S.ach[id]) return false;
  S.ach[id] = Date.now();
  achPend[id] = S.ach[id];
  return true;
}
function unlockAch(ids) {
  const names = [];
  for (const id of ids) if (unlockCore(id)) names.push((ACHIEVEMENTS.find((x) => x.id === id) || {}).name);
  if (!names.length) return;
  localStorage.setItem("ts_achpend", JSON.stringify(achPend));
  showEdgeBanner(`解锁成就 · ${names[0]}${names.length > 1 ? ` 等 ${names.length} 项` : ""}`, "「我的」页可查看徽章墙");
  flushAch();
}
async function flushAch() {
  if (!S.me || !Object.keys(achPend).length) return;
  const add = achPend;
  achPend = {};
  try {
    const r = await api("/api/ach", { method: "PUT", body: { add } });
    for (const [k, v] of Object.entries(r.ach || {})) if (!S.ach[k]) S.ach[k] = v; // 以服务端合并结果为准
    localStorage.setItem("ts_achpend", "{}");
  } catch {
    for (const [k, v] of Object.entries(add)) if (!achPend[k]) achPend[k] = v;
    localStorage.setItem("ts_achpend", JSON.stringify(achPend));
  }
}
async function loadAch() {
  if (!S.me) return;
  try {
    const r = await api("/api/ach");
    for (const [k, v] of Object.entries(r.ach || {})) if (!S.ach[k]) S.ach[k] = v;
    S.equip = Array.isArray(r.eq) ? r.eq : [];
    localStorage.setItem("ts_equip", JSON.stringify(S.equip));
  } catch {
    try { S.equip = JSON.parse(localStorage.getItem("ts_equip")) || []; } catch {}
  }
  evalAchievements();
}
function scheduleAchEval() {
  clearTimeout(achEvalTimer);
  achEvalTimer = setTimeout(evalAchievements, 1500);
}
const TIER_LABEL = ["", "", "白银档", "黄金档"];
function evalAchievements() {
  if (!S.me) return;
  const merged = mergedDays();
  const daysN = Object.keys(merged).length;
  let totalN = 0, maxDay = 0;
  for (const v of Object.values(merged)) { totalN += v; if (v > maxDay) maxDay = v; }
  let killed = 0, bankClear = false;
  const checkBank = (prog, total) => {
    const k = Object.values((prog && prog.q) || {}).filter((v) => v.s === "m").length;
    killed += k;
    if (total > 0 && k >= total) bankClear = true;
  };
  const cloudMeta = (() => { try { return JSON.parse(localStorage.getItem(bankKey("cloud")) || "null"); } catch { return null; } })();
  checkBank(S.progressCache.cloud, cloudMeta ? (cloudMeta.questions || []).length : 0);
  for (const b of getLocalBanks()) checkBank(loadProg(b.id), (b.questions || []).length);
  let wfix = (S.progressCache.cloud && S.progressCache.cloud.wf) || 0;
  for (const b of getLocalBanks()) wfix += (loadProg(b.id).wf || 0);
  const ctx = { daysN, streak: calcStreak(merged), totalN, maxDay, killed, bankClear, wfix };
  const firsts = [], ups = [];
  for (const a of ACHIEVEMENTS) {
    let tier = 0;
    if (a.tiers) tier = a.tiers.filter((t) => a.metric(ctx) >= t).length;
    else if (a.check && a.check(ctx)) tier = a.tier || 1;
    S.achTier[a.id] = tier;
    if (!tier) { achPrevTier[a.id] = 0; continue; }
    const known = achPrevTier[a.id];
    const first = unlockCore(a.id);
    if (first) firsts.push(a.name);
    else if (a.tiers && known !== undefined && known < tier) ups.push({ name: a.name, tier }); // 首轮只建基线
    achPrevTier[a.id] = tier;
  }
  if (!S.ach["all_ach"]) {
    const others = ACHIEVEMENTS.filter((x) => x.id !== "all_ach");
    if (others.every((x) => S.ach[x.id]) && unlockCore("all_ach")) firsts.push("大满贯");
  }
  if (firsts.length) {
    localStorage.setItem("ts_achpend", JSON.stringify(achPend));
    showEdgeBanner(`解锁成就 · ${firsts[0]}${firsts.length > 1 ? ` 等 ${firsts.length} 项` : ""}`, "「我的」页可查看徽章墙");
    flushAch();
  } else if (ups.length) {
    const u = ups[ups.length - 1];
    showEdgeBanner(`成就升档 · ${u.name}`, `已达${TIER_LABEL[u.tier]}`);
  }
}

// ================= 轻提示 =================
// 常规提示走右侧贴边滑入（打卡横幅同款）；欢迎语等少数场景用 centerToast 顶部居中
function toast(msg, holdMs = 2200) {
  showEdgeBanner(msg, "", holdMs);
}
function centerToast(msg, holdMs = 1800) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(centerToast._t);
  centerToast._t = setTimeout(() => el.classList.remove("show"), holdMs);
}

// ================= 云端题库 =================
// activate=false 时仅刷新云端缓存与统计，不切换当前使用的题库
async function loadCloudBank(activate = true) {
  const r = await api("/api/mybank");
  if (!r.bank || !Array.isArray(r.questions)) throw new Error("云端题库为空，请重新导入");
  const bank = {
    id: "cloud",
    name: r.bank.name,
    v: r.bank.v,
    modules: r.bank.modules,
    questions: r.questions,
  };
  // 无答案缓存：题库列表页展示名字/题量用
  localStorage.setItem(bankKey("cloud"), JSON.stringify(bank));
  const prog = r.progress || { q: {}, d: {} };
  S.progressCache.cloud = prog;
  if (activate) {
    S.bank = bank;
    S.bankId = "cloud";
    S.qkeys = r.questions.map((q) => q.i);
    S.progress = prog;
  }
  S.cloudLoaded = true;
  S.banksRev++;
}

// 把本地题库上传为云备份题库，并切换到云端
async function promoteToCloud(localId) {
  const lb = getLocalBank(localId);
  if (!lb) throw new Error("本地题库不存在");
  await api("/api/mybank", {
    method: "PUT",
    body: { bank: { name: lb.name, questions: lb.questions }, progress: loadProg(localId) },
  });
  localStorage.setItem("ts_last", "cloud");
  S.bank = null;
  S.progress = { q: {}, d: {} };
  S.progressCache = {};
  await loadCloudBank();
}

// ================= 题库列表视图数据 =================
function banksView() {
  S.banksRev; // 建立响应式依赖，refreshBanksView 时触发重算
  const view = [];
  if (S.me) {
    let name = "云备份";
    let total = 0;
    try {
      const cb = JSON.parse(localStorage.getItem(bankKey("cloud")));
      if (cb) { name = cb.name; total = (cb.questions || []).length; }
    } catch {}
    const cp = S.progressCache.cloud || loadProg("cloud");
    const cs = progStats(cp);
    view.push({ id: "cloud", name, total, cloud: true, ...cs });
  }
  for (const b of getLocalBanks()) {
    const p = S.progressCache[b.id] || loadProg(b.id);
    const cs = progStats(p);
    view.push({ id: b.id, name: b.name, total: (b.questions || []).length, cloud: false, ...cs });
  }
  return view;
}
function refreshBanksView() {
  S.banksRev++;
}

// ================= 头像压缩 =================
async function compressAvatar(file) {
  const bmp = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const s = Math.min(bmp.width, bmp.height);
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/webp", 0.85));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { type: blob.type || "image/webp", data: btoa(bin) };
}

// ================= 本地题库 =================
function validateLocalQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 50) return { error: "题库需至少 50 题" };
  const seen = new Set();
  for (const q of questions) {
    if (!Number.isInteger(q.i) || q.i <= 0) return { error: `题目 id 非法: ${q.i}` };
    if (seen.has(q.i)) return { error: `题目 id 重复: ${q.i}` };
    seen.add(q.i);
    if (!q.q || !Array.isArray(q.o) || q.o.length < 2) return { error: `题目 ${q.i} 选项缺失或非法` };
    const keys = q.o.map((o) => o.k).join("");
    if (!q.a || [...q.a].some((ch) => !keys.includes(ch))) return { error: `题目 ${q.i} 答案不在选项中` };
  }
  return {};
}
function importLocalBank(name, questions) {
  const byCat = new Map();
  for (const q of questions) {
    const cat = q.c || "未分类";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(q.i);
  }
  const bank = {
    id: "l" + Date.now().toString(36),
    name: (name || "").trim().slice(0, 30) || "本地题库",
    v: 1,
    modules: [...byCat.entries()].map(([n, qids]) => ({ name: n, qids })),
    questions,
    local: true,
  };
  const list = getLocalBanks();
  list.push(bank);
  saveLocalBanks(list);
  return bank;
}

// ================= 本地判分（与云端规则一致） =================
function stateAfterCorrectLocal(prev, now) {
  const GAP = 4 * 3600 * 1000;
  if (prev && (prev.s === "m" || (prev.s === "l" && now - prev.t >= GAP))) return "m";
  return "l";
}
function localGrade(q, selStr) {
  const answer = [...q.a].sort().join("");
  const correct = selStr === answer && selStr.length > 0;
  const prev = S.progress.q[q.i];
  const st = correct ? stateAfterCorrectLocal(prev, Date.now()) : "w";
  return { ok: 1, correct, a: q.a, x: q.x || null, st };
}

// ================= 作答记录（本地立即更新，云端进待同步队列） =================
// opts.consolidation：巩固题（昨日未掌握混合复习）——照常推进状态机与错题本，
// 但不计入每日答题数/打卡、排行榜答题量（云端增量不带 day，服务端同样不聚合）
function recordAnswer(qid, correct, st, opts = {}) {
  const day = todayStr();
  if (!opts.consolidation) {
    recordActivity(1); // 排行榜计数：云/本地题库都算
    flushActivity();
    if (new Date().getHours() < 6) unlockAch(["night_owl"]); // 凌晨刷题成就
  }
  scheduleAchEval();
  const firstOfDay = !opts.consolidation && !(S.progress.d[day] > 0);
  const prevQ = S.progress.q[qid];
  if (correct && prevQ && prevQ.s === "w") S.progress.wf = (S.progress.wf || 0) + 1; // 攻克错题累计（扫地僧口径）
  S.progress.q[qid] = { s: st, t: Date.now() };
  if (!opts.consolidation) S.progress.d[day] = (S.progress.d[day] || 0) + 1;
  if (S.bank && !S.bank.local) {
    const rec = { i: qid, r: correct ? 1 : 0 };
    if (!opts.consolidation) rec.day = day; // 巩固题不带 day：服务端仅推进状态，不聚合每日计数
    S.pending.push(rec);
    savePendLocal(); // 同步由独立周期任务（8s 轮询/可见/联网）执行，答题本身不触发
  } else if (S.bank) {
    saveProg(S.bank.id, S.progress);
  }
  S.banksRev++;
  if (firstOfDay) showEdgeBanner("今日已打卡 ✓", `已连续 ${calcStreak(mergedDays())} 天 · 答对 ${S.progress.d[day]} 题`);
}

// ================= 章节巩固候选：昨日答过且当前未掌握（w 错题 / l 待巩固） =================
function yesterdayUnmasteredQids() {
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  const DAY = 86400000;
  const from = t0.getTime() - DAY, to = t0.getTime();
  const out = [];
  for (const q of S.bank.questions) {
    const p = S.progress.q[q.i];
    if (p && (p.s === "w" || p.s === "l") && p.t >= from && p.t < to) out.push(q.i);
  }
  return out;
}
// 把 extra 均匀穿插进 base（两者各自保持相对顺序）
function interleave(base, extra) {
  const out = [...base];
  for (let k = extra.length - 1; k >= 0; k--) {
    out.splice(Math.round(((out.length + 1) * (k + 1)) / (extra.length + 1)), 0, extra[k]);
  }
  return out;
}

// ================= 单题练习 =================
function startSingleStudy(qid) {
  const n = Number(qid);
  if (!S.bank || !Number.isInteger(n) || !S.bank.questions.some((q) => q.i === n)) { toast("题目不存在或题库已更新"); return; }
  S.studyConf = { mode: "single", qid: n };
  go("#/study/single/" + n);
}

// ================= Turnstile =================
async function ensureTurnstile() {
  if (!S.tsCfgFetched) {
    try {
      const cfg = await api("/api/config");
      S.tsSiteKey = cfg.tsSiteKey || null;
      S.tsCfgFetched = true;
    } catch {}
  }
  if (!S.tsSiteKey) return null;
  if (!window.turnstile) {
    if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
      const sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      sc.async = true;
      document.head.appendChild(sc);
    }
    const loaded = await new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.turnstile) { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > 15000) { clearInterval(iv); resolve(false); }
      }, 250);
    });
    if (!loaded) return null;
  }
  return S.tsSiteKey;
}
function renderTsWidget(box, onToken) {
  try {
    return window.turnstile.render(box, {
      sitekey: S.tsSiteKey,
      theme: "auto",
      callback: (t) => onToken(t),
      "expired-callback": () => onToken(null),
      "error-callback": () => onToken(null),
    });
  } catch {
    return undefined;
  }
}

// ================= 打卡横幅 =================
function showEdgeBanner(title, sub, holdMs = 2200, opts = {}) {
  const el = document.createElement("div");
  el.className = "checkin";
  const titleEl = document.createElement("b");
  if (opts.html) titleEl.innerHTML = title; // 仅限代码内常量（如同步旋转指示），调用方数据一律走默认 textContent
  else titleEl.textContent = title;
  el.append(titleEl);
  let subEl;
  if (sub) {
    subEl = document.createElement("span");
    subEl.textContent = sub;
    el.append(subEl);
  }
  // 多条横幅同时出现时依次下移，避免重叠
  el.style.top = `calc(16% + ${document.querySelectorAll(".checkin.show").length * 72}px)`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const handle = {
    set(t, s) { el.innerHTML = `<b>${t}</b>` + (s ? `<span>${s}</span>` : ""); },
    close(afterMs = 0) {
      setTimeout(() => {
        el.classList.remove("show");
        setTimeout(() => el.remove(), 400);
      }, afterMs);
    },
  };
  // sticky 时由调用方在完成后 set 新文案并 close
  if (!opts.sticky) handle.close(holdMs);
  return handle;
}

// ================= 图标（Lucide，vendored 无构建） =================
// 向宿主元素内部注入 Lucide 的 SVG；不替换宿主节点，避免破坏 Vue 的 DOM 管理
function setIcon(el, name) {
  const L = window.lucide;
  if (!L || !L.icons || !name) return;
  const pascal = name.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
  const node = L.icons[pascal];
  if (!node) return;
  el.innerHTML = "";
  el.appendChild(L.createElement(node, { "stroke-width": "1.8" }));
}

// ================= Vue 应用 =================
const app = Vue.createApp({
  setup() {
    // 学习会话 key：模式或题源变化时强制重建组件，避免 Vue 复用实例导致 start() 不执行
    const studyKey = Vue.computed(() => {
      const c = S.studyConf;
      if (!c) return "none";
      return [c.mode, c.modIdx ?? "", c.qid ?? "", c.scope ? JSON.stringify(c.scope) : "", S.studyRev || 0].join("|");
    });
    return { S, view: Vue.computed(() => S.view), studyKey };
  },
  template: `
  <div v-if="!S.booted" style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--mut)">加载中…</div>
  <div v-else-if="S.netError" style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--mut)">网络异常，请刷新重试</div>
  <view-login v-else-if="view === 'login'" />
  <view-banks v-else-if="view === 'banks'" />
  <view-home v-else-if="view === 'home'" />
  <view-collections v-else-if="view === 'collections'" />
  <view-saved-collections v-else-if="view === 'saved-collections'" />
  <view-study v-else-if="view === 'study'" :key="studyKey" />
  <view-wrong v-else-if="view === 'wrong'" />
  <view-rank v-else-if="view === 'rank'" />
  <view-ach v-else-if="view === 'ach'" />
  <view-stats v-else-if="view === 'stats'" />
  <view-me v-else-if="view === 'me'" />
  <view-account v-else-if="view === 'account'" />
  <view-privacy v-else />`,
});

// 全局错误兜底：捕获组件渲染错误，避免黑屏
app.config.errorHandler = (err, instance, info) => {
  console.error("Vue Error:", err, "info:", info);
  const el = document.querySelector("#app");
  if (el && !el.innerHTML) {
    const box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;justify-content:center;height:100vh;color:#999;padding:20px;text-align:center";
    box.textContent = "页面渲染出错，请刷新重试\n" + String(err).slice(0, 100);
    box.style.whiteSpace = "pre-wrap";
    el.append(box);
  }
};

// 模板内可直接使用 go()（hash 路由）
app.config.globalProperties.go = go;

// 图标指令：v-icon 绑定 Lucide kebab-case 图标名
app.directive("icon", {
  mounted(el, binding) { setIcon(el, binding.value); },
  updated(el, binding) { if (binding.value !== binding.oldValue) setIcon(el, binding.value); },
});

// ---- 数字滚动指令 ----
app.directive("count", {
  mounted(el, binding) {
    const target = Number(binding.value) || 0;
    if (REDUCED_MOTION() || !window.countUp || !window.countUp.CountUp) { el.textContent = target; return; }
    const cu = new window.countUp.CountUp(el, target, { duration: 0.7, decimalPlaces: 0, separator: "" });
    if (!cu.error) cu.start(); else el.textContent = target;
  },
  updated(el, binding) {
    const v = Number(binding.value) || 0;
    if (el.textContent !== String(v)) el.textContent = v;
  },
});

// ================= 登录 / 注册 =================
function fmtTime(ts) {
  if (!ts) return "无记录";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

app.component("view-login", {
  data: () => ({ mode: "login", username: "", password: "", invite: "", consent: localStorage.getItem("ts_consent") === "1", remember: true, tsToken: null, tsId: undefined, busy: false, err: "", imp: { open: false, step: "pick", info: null, vault: null, name: "", pw: "", busy: false, err: "" } }),
  watch: {
    // 勾选状态持久化：勾过一次后刷新/重访仍保持勾选，手动取消才取消
    consent(v) { localStorage.setItem("ts_consent", v ? "1" : "0"); },
  },
  mounted() { this.initTs(); },
  methods: {
    async initTs() {
      const sk = await ensureTurnstile();
      if (!sk || !this.$refs.tsBox) return;
      this.$nextTick(() => {
        if (this.$refs.tsBox) this.tsId = renderTsWidget(this.$refs.tsBox, (t) => { this.tsToken = t; });
      });
    },
    resetTs() {
      if (this.tsId !== undefined && window.turnstile) { try { window.turnstile.reset(this.tsId); } catch {} }
      this.tsToken = null;
    },
    openImp() {
      this.imp = { open: true, step: "pick", info: null, vault: null, name: "", pw: "", busy: false, err: "" };
    },
    closeImp() { this.imp.open = false; },
    fmtTime,
    async onRestoreFile(e) {
      const f = e.target.files[0];
      if (!f) return;
      this.imp.busy = true;
      this.imp.err = "";
      try {
        const vault = await unpackBackupFile(JSON.parse(await f.text()));
        if (!vault) return;
        const r = await api("/api/import", { method: "POST", timeout: 60000, body: { vault } });
        this.imp.vault = vault;
        this.imp.info = r;
        this.imp.name = r.action === "create" ? r.username || "" : "";
        this.imp.step = r.action;
      } catch (err) {
        this.imp.err = err.message || "读取备份失败";
      } finally {
        this.imp.busy = false;
        e.target.value = "";
      }
    },
    async applyLocalPart(local) {
      if (!local) return;
      if (Array.isArray(local.banks)) {
        const list = getLocalBanks();
        for (const b of local.banks) {
          const i = list.findIndex((x) => x.id === b.id);
          if (i >= 0) list[i] = b; else list.push(b);
        }
        saveLocalBanks(list);
        for (const p of local.progress || []) localStorage.setItem(progKey(p.id), JSON.stringify(p.p));
      }
      if (Array.isArray(local.filterSets)) {
        if (S.me) {
          saveFilterSets(mergeFilterSets(getStoredFilterSets(), local.filterSets));
          S.filterRev++;
          syncFilterSets();
        } else {
          pendingRestoreFilterSets = local.filterSets;
        }
      }
    },
    async finishRestore() {
      S.me = await api("/api/me");
      S.bank = null;
      S.progress = { q: {}, d: {} };
      S.progressCache = {};
      S.pending = [];
      localStorage.setItem("ts_last", "cloud");
      await loadCloudBank();
      loadAch();
      if (pendingRestoreFilterSets) {
        saveFilterSets(mergeFilterSets(getStoredFilterSets(), pendingRestoreFilterSets));
        pendingRestoreFilterSets = null;
        S.filterRev++;
        syncFilterSets();
      }
      syncFilterSets();
      go("#/");
      centerToast("备份恢复成功，欢迎回来！");
    },
    async doRestore(mode) {
      this.imp.busy = true;
      this.imp.err = "";
      try {
        const body = { vault: this.imp.vault, mode, password: this.imp.pw };
        if (mode === "create") body.rename = this.imp.name;
        const r = await api("/api/import", { method: "POST", timeout: 60000, body });
        await this.applyLocalPart(r.local);
        await this.finishRestore();
      } catch (err) {
        this.imp.err = err.message || "恢复失败，请重试";
      } finally {
        this.imp.busy = false;
      }
    },
    async submit() {
      this.err = "";
      if (!this.consent) { this.err = "请先阅读并同意《隐私政策》"; return; }
      if (S.tsSiteKey && !this.tsToken) { this.err = "请先完成人机验证"; return; }
      this.busy = true;
      try {
        const body = { username: this.username, password: this.password, remember: this.remember, tsToken: this.tsToken };
        if (this.mode === "reg") body.invite = this.invite;
        await api(this.mode === "reg" ? "/api/register" : "/api/login", { method: "POST", body });
        S.me = await api("/api/me");
        clearAccountStorage();
        S.bank = null;
        S.progress = { q: {}, d: {} };
        S.progressCache = {};
        S.pending = [];
        localStorage.setItem("ts_last", "cloud");
        await loadCloudBank();
        go("#/");
        backfillActivity(); // 首次登录即校准排行榜历史，榜单立刻有数据
        loadAch(); // 拉取成就并补判（如首次打卡）
    centerToast(this.mode === "reg" ? "欢迎加入 Tisheng！" : "欢迎回来！");
      } catch (e) {
        this.err = e.message;
        this.resetTs();
      } finally {
        this.busy = false;
      }
    },
  },
  template: `
  <div class="login-wrap">
    <div class="login-logo">
      <div class="mark"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 24V8.5M18.5 14 24 8.5 29.5 14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><g transform="translate(7.5 17) scale(1.3)" fill="var(--ink)" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3 3z"/></g></svg></div>
          <h1>Tisheng</h1>
      <p>多题库刷题 · 云端同步</p>
    </div>
    <div class="card login-card">
      <div class="tabs">
        <button :class="['tab-btn', { on: mode === 'login' }]" @click="mode = 'login'; err = ''">登录</button>
        <button :class="['tab-btn', { on: mode === 'reg' }]" @click="mode = 'reg'; err = ''">注册</button>
      </div>
      <form @submit.prevent="submit">
        <div class="field"><input v-model.trim="username" placeholder="用户名" autocomplete="username" required></div>
        <div class="field"><input v-model="password" type="password" placeholder="密码" autocomplete="current-password" required></div>
        <div class="field" v-if="mode === 'reg'"><input v-model="invite" placeholder="邀请码（注册必填）" autocomplete="off"></div>
        <label class="remember-row"><input type="checkbox" v-model="remember"><span>7天免密登录</span></label>
        <div class="ts-wrap"><div ref="tsBox"></div></div>
        <label class="remember-row"><input type="checkbox" v-model="consent"><span>我已阅读并同意 <a href="#/privacy">《隐私政策》</a></span></label>
        <div class="form-err">{{ err }}</div>
        <button class="btn" type="submit" :disabled="busy">{{ busy ? "请稍候…" : (mode === "reg" ? "注 册" : "登 录") }}</button>
      </form>
      <button class="imp-link" @click="openImp">从备份恢复账号 ›</button>
<p class="login-copy">© 2026 Tisheng · 保留所有权利</p>
      <div class="sheet-mask" :class="{ open: imp.open }" @click="closeImp">
        <div class="sheet" role="dialog" aria-label="从备份恢复">
          <div class="sheet-head"><span>从备份恢复</span><button class="study-close" @click="closeImp">✕</button></div>
          <div class="form-err" v-if="imp.err">{{ imp.err }}</div>
          <template v-if="imp.step === 'pick'">
            <input ref="restoreFile" type="file" accept=".tibk,.json,application/json" hidden @change="onRestoreFile">
            <button class="btn ghost" :disabled="imp.busy" @click="$refs.restoreFile.click()">{{ imp.busy ? "校验中…" : "选择备份文件（.tibk）" }}</button>
            <p class="imp-note">新版备份需要独立备份密码；备份文件和密码请都妥善保管。云端已有同名账号时按数据一致性引导处理。</p>
          </template>
          <template v-else-if="imp.step === 'create'">
            <p class="imp-note">备份属于账号「{{ imp.info.username }}」，云端没有同名账号，将以此备份创建账号并恢复数据。</p>
            <input v-model.trim="imp.name" placeholder="用户名（2-10 位字母或数字）">
            <input v-model="imp.pw" type="password" placeholder="设置密码（至少 6 位）">
            <button class="btn" :disabled="imp.busy || !imp.name || imp.pw.length < 6" @click="doRestore('create')">恢复并登录</button>
          </template>
          <template v-else-if="imp.step === 'same'">
            <p class="imp-note">云端已存在同名账号「{{ imp.info.username }}」，且与备份为同一份数据。<br>备份时间：{{ fmtTime(imp.info.exportedAt) }}<br>云端数据：{{ fmtTime(imp.info.cloudAt) }}</p>
            <input v-model="imp.pw" type="password" placeholder="该账号的密码">
            <button class="btn ghost" :disabled="imp.busy || !imp.pw" @click="doRestore('login')">仅登录（不覆盖）</button>
            <button class="btn" :disabled="imp.busy || !imp.pw" @click="doRestore('overwrite')">用备份覆盖云端并登录</button>
          </template>
          <template v-else-if="imp.step === 'conflict'">
            <p class="imp-note">云端已存在同名账号「{{ imp.info.username }}」，但与备份数据不一致。<br>为避免身份冲突，必须为导入的数据设置一个<b>新的用户名</b>，否则无法登录。</p>
            <input v-model.trim="imp.name" placeholder="新的用户名（2-10 位字母或数字）">
            <input v-model="imp.pw" type="password" placeholder="设置密码（至少 6 位）">
            <button class="btn" :disabled="imp.busy || !imp.name || imp.pw.length < 6" @click="doRestore('create')">恢复到新用户名并登录</button>
          </template>
        </div>
      </div>
    </div>
  </div>`,
});

// ================= 已保存题集 =================
app.component("view-saved-collections", {
  computed: {
    sets() { S.filterRev; return getFilterSets(); },
    bank() { return S.bank; },
    bankName() { return S.bank ? S.bank.name : "当前题库"; },
    syncText() {
      const state = S.filterSync && S.filterSync.state;
      return { idle: "云端：未同步", syncing: "云端：同步中", ok: "云端：已同步", error: "云端：同步失败" }[state] || "云端：未同步";
    },
  },
  methods: {
    idsForFilters(filters = {}) {
      const bank = this.bank;
      if (!bank || !Array.isArray(bank.questions)) return [];
      const query = String(filters.search || "").trim().toLowerCase();
      const progress = S.progress || { q: {} };
      return bank.questions.filter((item) => {
        const st = progress.q[item.i];
        const state = st ? st.s : "n";
        const status = filters.status || "all";
        const kind = filters.kind || "all";
        if (status !== "all" && state !== status) return false;
        const isMulti = !!item.m || (bank.local && item.a && [...item.a].length > 1);
        if (kind === "multi" && !isMulti) return false;
        if (kind === "single" && isMulti) return false;
        if (!query) return true;
        return [item.q, ...(item.o || []).map((o) => o.t)].join("\n").toLowerCase().includes(query);
      }).map((item) => item.i);
    },
    practiceSet(item) {
      const ids = this.idsForFilters(item.filters || {});
      if (!ids.length) { toast("该题集在当前题库中没有匹配题目"); return; }
      startFilteredStudy(ids);
    },
    setSummary(item) {
      const f = item.filters || {};
      const state = { all: "全部", n: "未练", l: "待巩固", m: "已掌握" }[f.status] || "全部";
      const kind = { all: "全部题型", single: "单选", multi: "多选" }[f.kind] || "全部题型";
      return [state, kind, f.search ? `关键词：${f.search}` : ""].filter(Boolean).join(" · ");
    },
    deleteSet(id) {
      if (!confirm("删除这个题集？题目和学习记录不会受影响。")) return;
      const raw = getStoredFilterSets().map((x) => x.id === id ? { ...x, deleted: true, updatedAt: Date.now() } : x);
      saveFilterSets(raw);
      S.filterRev++;
      syncFilterSets();
      toast("题集已删除");
    },
  },
  template: `
  <div class="page rank-page saved-collections">
    <div class="policy-top">
      <button class="study-close" @click="go('#/me')">←</button>
      <span class="policy-title">我的题集</span>
    </div>
    <p class="rank-hint">{{ syncText }} · 绑定当前题库：{{ bankName }}</p>
    <div class="collection-list">
      <div class="card collection-card" v-for="s in sets" :key="s.id">
        <button class="collection-main" @click="practiceSet(s)"><b>{{ s.name }}</b><span>{{ setSummary(s) }} · 点击开始</span></button>
        <button class="collection-practice" @click="practiceSet(s)">开始</button>
        <button class="collection-del" @click="deleteSet(s.id)">删除</button>
      </div>
      <div class="filter-empty" v-if="!sets.length">还没有保存题集。可到「题集」页筛选并保存。</div>
    </div>
  </div>`,
});

// ================= 题库列表（二级页） =================
app.component("view-banks", {
  data: () => ({ impOpen: false, impName: "", impJson: "", impErr: "", impBusy: false, actBusy: false }),
  computed: {
    banks() { return banksView(); },
    actId() { return S.ui.actId; },
    act() { return this.banks.find((b) => b.id === S.ui.actId) || null; },
    totalPct() {
      const n = this.banks.reduce((s, b) => s + b.total, 0);
      const m = this.banks.reduce((s, b) => s + b.mastered, 0);
      return n ? Math.round((m / n) * 100) : 0;
    },
  },
  mounted() { refreshBanksView(); },
  methods: {
    openActions(id) { S.ui.actId = id; },
    closeActions() { S.ui.actId = null; },
    actStudy() {
      const id = S.ui.actId;
      this.closeActions();
      go("#/bank/" + id);
    },
    async actPromote() {
      this.actBusy = true;
      try {
        await promoteToCloud(S.ui.actId);
        toast("已切换云备份题库");
        this.closeActions();
        refreshBanksView();
      } catch (e) {
        toast(e.message || "切换失败，请重试");
      } finally {
        this.actBusy = false;
      }
    },
    actDelete() {
      if (!confirm("删除该本地题库？其学习进度与错题本将一并删除。")) return;
      removeLocalBank(S.ui.actId);
      this.closeActions();
      refreshBanksView();
    },
    async actDownload() {
      this.actBusy = true;
      try {
        const full = await api("/api/mybank?full=1");
        const id = "l" + Date.now().toString(36);
        const list = getLocalBanks();
        list.push({ ...full.bank, id, local: true });
        saveLocalBanks(list);
        localStorage.setItem(progKey(id), JSON.stringify(full.progress || { q: {}, d: {} }));
        toast("已下载到本机");
        this.closeActions();
      } catch (e) {
        toast(e.message || "下载失败，请重试");
      } finally {
        this.actBusy = false;
      }
    },
    // 仅云备份可同步：把待同步的作答增量推上云端（结果由同步横幅展示）
    async actSync() {
      const n = S.pending.length;
      if (!n) { toast("进度已是最新"); return; }
      this.actBusy = true;
      try {
        await flushSync();
        if (S.pending.length === 0) this.closeActions();
      } finally {
        this.actBusy = false;
      }
    },
    // 重置单个题库的学习进度（云端走 /api/reset，本地清 localStorage）
    async actResetBank() {
      const id = S.ui.actId;
      const b = this.banks.find((x) => x.id === id);
      if (!b) return;
      if (!confirm(`确定重置「${b.name}」的学习进度？此操作不可恢复。`)) return;
      if (!confirm("再次确认：该题库的掌握记录与打卡记录将被清空。")) return;
      const empty = { q: {}, d: {} };
      this.actBusy = true;
      try {
        if (id === "cloud") {
          await api("/api/reset", { method: "POST", body: {} });
          S.pending = [];
          savePendLocal();
          if (S.bankId === "cloud") S.progress = empty;
          S.progressCache.cloud = S.bankId === "cloud" ? S.progress : empty;
          toast("云备份进度已重置");
        } else {
          localStorage.setItem(progKey(id), JSON.stringify(empty));
          if (S.bankId === id) S.progress = empty;
          S.progressCache[id] = S.bankId === id ? S.progress : empty;
          toast("本地进度已重置");
        }
        this.closeActions();
        refreshBanksView();
      } catch (e) {
        toast(e.message || "重置失败，请重试");
      } finally {
        this.actBusy = false;
      }
    },
    async actDeleteCloud() {
    if (!confirm("删除云备份题库？云端的学习进度将一并清空，云端恢复为内置示例题库；本机题库不受影响。")) return;
      this.actBusy = true;
      try {
        await api("/api/mybank", { method: "DELETE" });
        S.cloudLoaded = false;
        // 当前正在使用云题库时重新拉取恢复后的初始题库，否则只刷新列表缓存
        await loadCloudBank(S.bankId === "cloud");
        if (S.bankId === "cloud") {
          S.pending = []; // 队列里是旧云题库的作答记录，不带到恢复后的题库
          savePendLocal();
        }
        toast("云备份已删除");
        this.closeActions();
        refreshBanksView();
      } catch (e) {
        toast(e.message || "删除失败，请重试");
      } finally {
        this.actBusy = false;
      }
    },
    async onImpFile(e) {
      const f = e.target.files[0];
      if (!f) return;
      this.impName = f.name.replace(/\.(json|txt)$/i, "").slice(0, 30) || "导入题库";
      try {
        this.impJson = await f.text();
        this.impOpen = false;
        this.doImport();
      } catch {
        this.impErr = "文件读取失败";
      }
      e.target.value = "";
    },
    doImport() {
      this.impErr = "";
      if (!this.impName) { this.impErr = "请填写题库名称"; return; }
      let questions;
      try { questions = JSON.parse(this.impJson); } catch { this.impErr = "JSON 格式错误"; return; }
      const v = validateLocalQuestions(questions);
      if (v.error) { this.impErr = v.error; return; }
      this.impBusy = true;
      try {
        importLocalBank(this.impName, questions);
        toast(`已导入本地题库（${questions.length} 题）`);
        this.impOpen = false;
        this.impName = "";
        this.impJson = "";
        refreshBanksView();
      } finally {
        this.impBusy = false;
      }
    },
  },
  template: `
  <div class="policy">
    <div class="policy-top">
      <button class="study-close" @click="go('#/')">←</button>
      <span class="policy-title">题库列表</span>
      <button class="plus-plain" @click="impOpen = true">＋</button>
    </div>
    <div class="card bank-card" v-for="b in banks" :key="b.id" @click="openActions(b.id)">
      <div class="mod-ico">{{ b.name[0] }}</div>
      <div class="mod-info">
        <div class="mod-name">{{ b.name }}
          <span class="tag review" v-if="b.cloud">云备份</span>
          <span class="tag" v-else>本地</span>
        </div>
        <div class="mod-count">{{ b.mastered }} / {{ b.total }} 已掌握</div>
        <div class="mod-bar"><i :style="{ width: (b.total ? Math.round(b.mastered / b.total * 100) : 0) + '%' }"></i></div>
      </div>
      <div class="mod-pct">{{ b.total ? Math.round(b.mastered / b.total * 100) : 0 }}%</div>
    </div>
    <div class="card admin-card" v-if="!banks.length">
      <p class="danger-note">还没有题库。点击右上角 ＋ 导入题库（至少 50 题）。</p>
    </div>
    <div class="sheet-mask" :class="{ open: impOpen }" @click="impOpen = false">
      <div class="sheet" role="dialog" aria-label="导入题库">
        <div class="sheet-head"><span>导入题库</span><button class="study-close" @click="impOpen = false">✕</button></div>
        <input ref="impFile" type="file" accept=".json,.txt,application/json" hidden @change="onImpFile">
        <button class="btn ghost" @click="$refs.impFile.click()">选择题库文件（.json）</button>
        <div class="imp-or">或粘贴 JSON</div>
        <input v-model.trim="impName" placeholder="题库名称（如：软考中级）">
        <textarea v-model="impJson" placeholder='粘贴题目 JSON 数组（含答案，x 为可选解析）：[{"i":1,"q":"题干","o":[{"k":"A","t":"选项A"}],"a":"A","c":"分类","x":"解析说明"}]'></textarea>
        <div class="form-err">{{ impErr }}</div>
        <button class="btn" :disabled="impBusy" @click="doImport">导入粘贴内容</button>
      </div>
    </div>
    <div class="sheet-mask" :class="{ open: actId }" @click="closeActions">
      <div class="sheet" role="dialog" aria-label="题库操作">
        <div class="sheet-head"><span>{{ act ? act.name : "" }}</span><button class="study-close" @click="closeActions">✕</button></div>
        <template v-if="act">
          <button class="btn" @click="go('#/bank/' + act.id)">开始刷题</button>
          <button class="btn ghost" v-if="act.cloud" :disabled="actBusy" @click="actSync">同步进度</button>
          <button class="btn ghost" v-if="!act.cloud" :disabled="actBusy" @click="actPromote">设为云备份</button>
          <button class="btn ghost" v-if="act.cloud" :disabled="actBusy" @click="actDownload">下载备份到本机</button>
          <button class="btn danger" :disabled="actBusy" @click="actResetBank">重置进度</button>
          <button class="btn danger" v-if="!act.cloud" :disabled="actBusy" @click="actDelete">删除题库</button>
        </template>
      </div>
    </div>
    </div>
  </div>`,
});

// ================= 主页（当前题库） =================
app.component("view-home", {
  computed: {
    bank() { return S.bank; },
    mastered() { return Object.values(S.progress.q).filter((v) => v.s === "m").length; },
    learning() { return Object.values(S.progress.q).filter((v) => v.s === "l").length; },
    wrong() { return Object.values(S.progress.q).filter((v) => v.s === "w").length; },
    total() { return S.bank ? S.bank.questions.length : 0; },
    pct() { return this.total ? Math.round((this.mastered / this.total) * 100) : 0; },
    today() { return mergedDays()[todayStr()] || 0; },
    modules() { return S.bank ? S.bank.modules : []; },
    modView() {
      return this.modules.map((m) => {
        const done = m.qids.filter((id) => S.progress.q[id] && S.progress.q[id].s === "m").length;
        const wrong = m.qids.filter((id) => S.progress.q[id] && S.progress.q[id].s === "w").length;
        return { name: m.name, done, total: m.qids.length, pct: m.qids.length ? Math.round((done / m.qids.length) * 100) : 0, wrong };
      });
    },
  },
  template: `
  <div class="page">
    <div class="home-head">
      <div class="hi">{{ bank.name }}<small>
        <a href="#/banks" class="switch-link">全部题库 ›</a> · 今天已答对 <b>{{ today }}</b> 题</small></div>
      <div class="ring" :style="{ '--p': pct }"><i><b v-count="pct">0</b>%</i></div>
    </div>
    <div class="banner">
      <div class="card stat-card"><b class="ok" v-count="mastered">0</b><span>已掌握题目</span></div>
      <div class="card stat-card"><b class="warn" v-count="learning">0</b><span>待巩固</span></div>
      <button class="card stat-card" :disabled="!wrong" @click="go('#/wrong')">
        <b class="bad" v-count="wrong">0</b><span>错题<i class="stat-go" v-if="wrong">›</i></span>
      </button>
    </div>
    <div class="sec-title"><span>章节闯关</span><span>共 {{ total }} 题</span></div>
    <div class="mod-list">
      <button class="card mod-card" v-for="(m, idx) in modView" :key="m.name" @click="openStudy(idx)">
        <div class="mod-ico">{{ idx + 1 }}</div>
        <div class="mod-info">
          <div class="mod-name">{{ m.name }}</div>
          <div class="mod-count">{{ m.done }} / {{ m.total }} 已掌握 · {{ m.wrong }} 错题</div>
          <div class="mod-bar"><i :style="{ width: m.pct + '%' }"></i></div>
        </div>
        <div class="mod-pct">{{ m.pct }}%</div>
      </button>
    </div>
  </div>`,
  methods: {
    openStudy(idx) { startModuleStudy(idx); },
  },
});

// ================= 答题（学习引擎） =================
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function startModuleStudy(idx) {
  const mod = S.bank.modules[idx];
  if (!mod) return;
  S.studyConf = { mode: "module", modIdx: idx };
  go("#/study/" + idx);
}
// 无尽模式题源：all 全库 / module 分类 / wrong 错题 / filter-set 题集 / learning 待巩固
function endlessQids(scope) {
  const bank = S.bank;
  if (!bank || !Array.isArray(bank.questions)) return [];
  const all = bank.questions.map((q) => q.i);
  const sc = scope || { type: "all" };
  if (sc.type === "module") {
    const mod = bank.modules[sc.modIdx];
    if (!mod) return []; // 切库后分类索引可能越界
    return mod.qids.filter((id) => bank.questions.some((q) => q.i === id));
  }
  if (sc.type === "wrong") return all.filter((id) => S.progress.q[id] && S.progress.q[id].s === "w");
  if (sc.type === "learning") return all.filter((id) => S.progress.q[id] && S.progress.q[id].s === "l");
  if (sc.type === "filter-set") {
    const set = getFilterSets().find((x) => x.id === sc.setId);
    if (!set) return [];
    const filt = set.filters || {};
    const query = String(filt.search || "").trim().toLowerCase();
    const status = filt.status || "all";
    const kind = filt.kind || "all";
    return bank.questions.filter((item) => {
      const st = S.progress.q[item.i];
      const state = st ? st.s : "n";
      if (status !== "all" && state !== status) return false;
      const isMulti = !!item.m || (bank.local && item.a && [...item.a].length > 1);
      if (kind === "multi" && !isMulti) return false;
      if (kind === "single" && isMulti) return false;
      if (!query) return true;
      return [item.q, ...(item.o || []).map((o) => o.t)].join("\n").toLowerCase().includes(query);
    }).map((item) => item.i);
  }
  return all;
}
function endlessScopeLabel(scope) {
  const sc = scope || { type: "all" };
  if (sc.type === "module") {
    const m = S.bank && S.bank.modules[sc.modIdx];
    return m ? m.name : "分类";
  }
  return { all: "整个题库", wrong: "错题本", learning: "待巩固", "filter-set": "题集" }[sc.type] || "整个题库";
}
function loadEndlessScope() {
  try {
    const v = JSON.parse(localStorage.getItem("ts_endless_scope") || "null");
    return v && typeof v === "object" && v.type ? v : null;
  } catch { return null; }
}
function saveEndlessScope(sc) {
  try { localStorage.setItem("ts_endless_scope", JSON.stringify(sc)); } catch {}
}
function startEndlessStudy(scope) {
  if (!S.bank) { toast("请先选择题库"); return; }
  if (!S.bank.questions.length) { toast("题库为空"); return; }
  let sc = scope || S.endlessScope || loadEndlessScope() || { type: "all" };
  if (!endlessQids(sc).length) {
    // 记忆的范围在当前题库已失效（常见于切换题库后：分类不存在、题集不匹配、无错题）
    if (sc.type !== "all") { toast("该范围在当前题库没有题目，已改为整个题库"); sc = { type: "all" }; }
    else { toast("该题库暂时没有可练的题目"); return; }
  }
  S.endlessScope = sc;
  saveEndlessScope(sc);
  S.studyConf = { mode: "endless", scope: sc };
  go("#/study/endless");
}
function startWrongStudy() {
  const wrongQs = Object.keys(S.progress.q).filter((id) => S.progress.q[id].s === "w").map(Number);
  if (!wrongQs.length) { toast("太棒了，暂时没有错题"); return; }
  S.studyConf = { mode: "wrong" };
  go("#/study/wrong");
}

function startFilteredStudy(qids) {
  if (!S.bank) return;
  const wanted = new Set(qids.map(Number).filter(Number.isInteger));
  const ids = S.bank.questions.map((q) => q.i).filter((id) => wanted.has(id));
  if (!ids.length) { toast("请先选择要练习的题目"); return; }
  S.studyConf = { mode: "filter", qids: ids };
  go("#/study/filter");
}

// ================= 自定义下拉选择（题集筛选） =================
// 原生 select 展开面板是操作系统 UI 无法定制；此组件用按钮+浮层列表呈现，支持点击与键盘选择
app.component("filter-select", {
  props: {
    modelValue: { type: String, default: "" },
    options: { type: Array, required: true }, // [{ value, label }]
    placeholder: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  data: () => ({ open: false }),
  computed: {
    label() {
      const hit = this.options.find((o) => o.value === this.modelValue);
      return hit ? hit.label : (this.placeholder || (this.options[0] && this.options[0].label) || "");
    },
  },
  methods: {
    choose(v) {
      this.$emit("update:modelValue", v);
      this.open = false;
    },
    onDocClick(e) {
      if (this.$refs.box && !this.$refs.box.contains(e.target)) this.open = false;
    },
    onKey(e) {
      if (!this.open) return;
      const idx = this.options.findIndex((o) => o.value === this.modelValue);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.$emit("update:modelValue", this.options[(idx + 1) % this.options.length].value);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.$emit("update:modelValue", this.options[(idx - 1 + this.options.length) % this.options.length].value);
      } else if (e.key === "Enter" || e.key === "Escape") {
        this.open = false;
      }
    },
  },
  mounted() { document.addEventListener("click", this.onDocClick); },
  unmounted() { document.removeEventListener("click", this.onDocClick); },
  template: `
  <div class="fsel" ref="box">
    <button type="button" class="fsel-btn" :class="{ open }" @click="open = !open" @keydown="onKey">
      <span>{{ label }}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="fsel-list" v-if="open">
      <button type="button" class="fsel-opt" v-for="o in options" :key="o.value" :class="{ on: o.value === modelValue }" @click="choose(o.value)">{{ o.label }}<svg v-if="o.value === modelValue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></button>
    </div>
  </div>`,
});

app.component("view-collections", {
  data: () => ({ search: "", status: "all", kind: "all", setName: "" }),
  computed: {
    bank() { return S.bank; },
    bankName() { return S.bank ? S.bank.name : "当前题库"; },
    syncText() {
      const state = S.filterSync && S.filterSync.state;
      return { idle: "云端：未同步", syncing: "云端：同步中", ok: "云端：已同步", error: "云端：同步失败" }[state] || "云端：未同步";
    },
    results() {
      const bank = this.bank;
      if (!bank || !Array.isArray(bank.questions)) return [];
      const query = this.search.trim().toLowerCase();
      const progress = S.progress || { q: {} };
      return bank.questions.filter((item) => {
        const st = progress.q[item.i];
        const state = st ? st.s : "n";
        if (this.status !== "all" && state !== this.status) return false;
        const isMulti = !!item.m || (bank.local && item.a && [...item.a].length > 1);
        if (this.kind === "multi" && !isMulti) return false;
        if (this.kind === "single" && isMulti) return false;
        if (!query) return true;
        return [item.q, ...(item.o || []).map((o) => o.t)].join("\n").toLowerCase().includes(query);
      }).map((item) => {
        const st = progress.q[item.i];
        const isMulti = !!item.m || (bank.local && item.a && [...item.a].length > 1);
        return {
          i: item.i,
          text: item.q,
          state: st ? ({ m: "已掌握", l: "待巩固", w: "错题" }[st.s] || "未练") : "未练",
          meta: isMulti ? "多选" : "单选",
        };
      });
    },
    shownResults() { return this.results.slice(0, 30); },
  },
  methods: {
    saveAndPractice() {
      if (!this.results.length) { toast("当前没有可保存的题目"); return; }
      if (getStoredFilterSets().length >= FILTER_SET_LIMIT) { toast("题集数量已达上限，请先删除不需要的题集"); return; }
      const name = this.setName.trim() || `题集 ${getFilterSets().length + 1}`;
      const idBytes = crypto.getRandomValues(new Uint8Array(12));
      const id = "f" + [...idBytes].map((x) => x.toString(16).padStart(2, "0")).join("");
      const filters = { search: this.search, status: this.status, kind: this.kind };
      const item = { id, name: name.slice(0, 30), filters, createdAt: Date.now(), updatedAt: Date.now() };
      saveFilterSets([...getStoredFilterSets(), item]);
      S.filterRev++;
      syncFilterSets();
      this.setName = "";
      startFilteredStudy(this.results.map((q) => q.i));
      toast(`已保存「${item.name}」，开始练习`);
    },
  },
  template: `
  <div class="page collections-page">
    <div class="home-head">
      <div class="hi">题集<small>绑定当前题库 · {{ bankName }} · {{ syncText }}</small></div>
    </div>
    <div class="card search-card">
      <input class="search-input" v-model.trim="search" type="search" placeholder="搜索题干或选项" autocomplete="off">
      <div class="filter-grid">
        <filter-select v-model="status" :options="[
          { value: 'all', label: '全部状态' },
          { value: 'n', label: '未练' },
          { value: 'l', label: '待巩固' },
          { value: 'm', label: '已掌握' },
        ]"></filter-select>
        <filter-select v-model="kind" :options="[
          { value: 'all', label: '全部题型' },
          { value: 'single', label: '单选' },
          { value: 'multi', label: '多选' },
        ]"></filter-select>
      </div>
    </div>
    <div class="collection-start card">
      <input v-model.trim="setName" placeholder="题集名称（可选）" maxlength="30">
      <button class="btn" :disabled="!results.length" @click="saveAndPractice">保存题集并开始</button>
    </div>
    <div class="sec-title"><span>筛选结果</span><span>{{ results.length }} 题{{ results.length > 30 ? " · 预览前 30" : "" }}</span></div>
    <div class="filter-empty" v-if="!results.length">没有匹配题目，请调整关键词或筛选条件</div>
    <div class="result-list" v-else>
      <div class="result-item" v-for="q in shownResults" :key="q.i"><b>{{ q.state }}</b><span>{{ q.text }}</span><i>{{ q.meta }}</i></div>
    </div>
  </div>`,
});

app.component("view-study", {
  data: () => ({ picked: [], gradeErr: "", explOpen: false, revIdx: null }),
  computed: {
    ses() { return S.study; },
    q() { return this.ses && this.ses.cur ? this.ses.cur.q : null; },
    isMulti() { return this.q ? !!this.q.m : false; },
    answered() { return !!(this.ses && this.ses.cur && this.ses.cur.answered); },
    correct() { return !!(this.ses && this.ses.cur && this.ses.cur.correct); },
    expl() { return this.ses && this.ses.cur ? this.ses.cur.expl : null; },
    busy() { return !!(this.ses && this.ses.busy); },
    finished() { return !!(this.ses && this.ses.finished); },
    resolved() { return this.ses ? this.ses.resolved : 0; },
    total() { return this.ses ? this.ses.total : 0; },
    queueLen() { return this.ses ? this.ses.queue.length : 0; },
    endless() { return !!this.ses && this.ses.mode === "endless"; },
    progPct() { return this.total ? Math.round((this.resolved / this.total) * 100) : 0; },
    firstTryRight() { return this.ses ? this.ses.firstTryRight : 0; },
    firstTryWrong() { return this.ses ? this.ses.firstTryWrong : 0; },
    accPct() { return this.firstTryRight + this.firstTryWrong > 0 ? Math.round((this.firstTryRight / (this.firstTryRight + this.firstTryWrong)) * 100) : 100; },
    minsText() {
      if (!this.ses) return "0 分钟";
      const mins = Math.max(1, Math.round((Date.now() - this.ses.startedAt) / 60000));
      return mins + " 分钟";
    },
    pickedK() { return [...this.picked].sort().join(""); },
    answerKeys() {
      if (!this.answered) return [];
      const orig = S.bank.local
        ? (this.q && this.q.a ? [...this.q.a].sort() : [])
        : (this.ses && this.ses.cur && this.ses.cur.answer ? [...this.ses.cur.answer].sort() : []);
      // 原始字母 → 展示字母（高亮与「正确答案」文案跟屏幕一致）
      return orig.map((ok0) => (this.q.o.find((o) => o.o0 === ok0) || {}).k).filter(Boolean).sort();
    },
    qLocal() { return this.q && S.progress.q[this.q.i] ? S.progress.q[this.q.i].s : null; },
    isCons() { return !!(this.ses && this.ses.consolidate && this.q && this.ses.consolidate.has(this.q.i)); },
    consN() { return this.ses ? this.ses.consolidatedN : 0; },
    reviewing() { return this.revIdx !== null; },
    canReview() { const h = this.ses && this.ses.history; return !this.finished && !!h && h.length > 0; },
    rev() {
      if (this.revIdx === null || !this.ses) return null;
      const h = this.ses.history[this.revIdx];
      if (!h) return null;
      const answerKeys = h.answer ? [...h.answer].map((ok0) => (h.q.o.find((o) => o.o0 === ok0) || {}).k).filter(Boolean).sort() : [];
      return { q: h.q, picked: h.picked, correct: h.correct, expl: h.expl, answerKeys, idx: this.revIdx, count: this.ses.history.length };
    },
    wrongQs() {
      return Object.keys(S.progress.q).filter((id) => S.progress.q[id].s === "w").map(Number);
    },
  },
  mounted() {
    // 每次进入答题页都按最新 S.studyConf 重建会话（单题/错题/章节各有不同队列）
    this.start();
    window.addEventListener("keydown", this.onKey);
  },
  unmounted() {
    clearTimeout(this.autoNextTimer);
    window.removeEventListener("keydown", this.onKey);
  },
  methods: {
    start() {
      const conf = S.studyConf || {};
      let queue;
      if (conf.mode === "wrong") queue = shuffled(this.wrongQs);
      else if (conf.mode === "single") queue = [conf.qid];
      else if (conf.mode === "filter") queue = shuffled(conf.qids || []);
      else if (conf.mode === "endless") {
        queue = shuffled(endlessQids(conf.scope));
        if (!queue.length) { go("#/"); return; } // 题源在当前题库已无题目（如切库后）
      }
      else {
        const mod = S.bank.modules[conf.modIdx];
        if (!mod) { go("#/"); return; }
        queue = shuffled(mod.qids);
        // 章节巩固：按比例混入昨日答过且未掌握的题（不计入每日计数/排行榜）
        let cons = [];
        if (localStorage.getItem("ts_consolidate") !== "0") {
          const cands = shuffled(yesterdayUnmasteredQids());
          const base = queue.filter((id) => !cands.includes(id)); // 去重：巩固题不重复入队
          const n = Math.min(Math.ceil(base.length / 5), 20, cands.length);
          cons = cands.slice(0, n);
          if (cons.length) queue = interleave(base, cons);
        }
        var consSet = new Set(cons);
      }
      if (!queue.length) { go("#/"); return; }
      this.revIdx = null;
      S.study = reactive({
        modIdx: conf.modIdx ?? -1,
        mode: conf.mode || "module",
        scope: conf.scope || null, // 无尽模式题源，结算页据此延续
        wrongMode: conf.mode === "wrong",
        consolidate: consSet || new Set(),
        queue,
        total: queue.length,
        resolved: 0,
        consolidatedN: 0,
        history: [], // 已答题只读快照，供会话内「查看上一题」回看
        firstTryRight: 0,
        firstTryWrong: 0,
        requeued: new Set(),
        cur: null,
        busy: false,
        finished: false,
        startedAt: Date.now(),
      });
      this.nextQ();
    },
    nextQ() {
      const ses = S.study;
      if (!ses.queue.length) { ses.finished = true; return; }
      const qi = ses.queue[0];
      const q = S.bank.questions.find((x) => x.i === qi);
      if (!q) {
        ses.queue.shift();
        if (!ses.queue.length) { ses.finished = true; return; } // 题号全部失效（如题库已换）直接收尾
        return this.nextQ();
      }
      // 选项随机打乱：展示字母随新位置重编（防背位置/背字母），判分前映射回原始选项
      const disp = { ...q, o: shuffled(q.o).map((o, idx) => ({ ...o, k: "ABCDEFGH"[idx], o0: o.k })) };
      ses.cur = reactive({ q: disp, sel: [], answered: false, correct: false, st: null, expl: null, answer: null });
      this.picked = [];
      this.gradeErr = "";
      this.explOpen = false;
    },
    pick(k) {
      if (this.answered || this.busy) return;
      const isMulti = !!this.q.m || (S.bank.local && this.q.a && [...this.q.a].length > 1);
      if (isMulti) {
        const i = this.picked.indexOf(k);
        if (i >= 0) this.picked.splice(i, 1);
        else this.picked.push(k);
      } else {
        this.picked = [k];
        this.grade();
      }
    },
    confirmMulti() {
      if (!this.picked.length) return;
      this.grade();
    },
    async grade() {
      const ses = S.study;
      const q = this.q;
      if (ses.busy || ses.cur.answered) return;
      ses.busy = true;
      // 展示字母 → 原始选项字母（判分与服务端/本地规则零耦合）
      const origSel = [...this.picked].map((sk) => (this.q.o.find((o) => o.k === sk) || {}).o0).filter(Boolean).sort().join("");
      let res;
      if (S.bank.local) res = localGrade(q, origSel);
      else {
        try {
          res = await api("/api/grade", { method: "POST", body: { i: q.i, sel: origSel } });
        } catch (e) {
          ses.busy = false;
          this.gradeErr = e.status === 429 ? "手速太快啦，歇一秒再点" : (e.message || "判分失败，请重试");
          return;
        }
      }
      const firstTry = !ses.requeued.has(q.i);
      const isCons = !!(ses.consolidate && ses.consolidate.has(q.i));
      if (firstTry && !isCons) { // 完美轮次口径不含巩固题
        if (res.correct) ses.firstTryRight++;
        else ses.firstTryWrong++;
      }
      recordAnswer(q.i, res.correct, res.st, { consolidation: isCons });
      if (res.correct) ses.resolved++;
      else if (ses.mode !== "endless") {
        // 无尽模式不回炉：答过的题由 next() 统一滚到队尾，避免同一题重复堆积
        ses.requeued.add(q.i);
        ses.queue.push(q.i); // 答错回炉，排到队尾
      }
      if (isCons) ses.consolidatedN++;
      ses.cur.answered = true;
      ses.cur.correct = res.correct;
      ses.cur.st = res.st;
      ses.cur.expl = res.x || null;
      ses.cur.answer = res.a;
      ses.busy = false;
      // 答对稍作展示后自动进入下一题；答错停留等用户看完解析
      if (res.correct) {
        clearTimeout(this.autoNextTimer);
        this.autoNextTimer = setTimeout(() => {
          if (S.study && S.study.cur && S.study.cur.answered && S.study.cur.correct) this.next();
        }, 1400);
      }
    },
    next() {
      clearTimeout(this.autoNextTimer);
      const ses = S.study;
      if (ses.cur && ses.cur.answered) {
        ses.history.push({ q: ses.cur.q, picked: [...this.picked], correct: ses.cur.correct, answer: ses.cur.answer, expl: ses.cur.expl });
      }
      const doneQid = ses.cur ? ses.cur.q.i : null;
      ses.queue.shift();
      ses.cur = null;
      this.picked = [];
      // 无尽模式：答过的题重新排到队尾，队列永不耗尽，直到用户主动退出
      if (ses.mode === "endless" && doneQid !== null) ses.queue.push(doneQid);
      if (!ses.queue.length) {
        ses.finished = true;
        if (ses.firstTryRight >= 20 && ses.firstTryWrong === 0) unlockAch(["perfect_round"]);
        scheduleAchEval();
      } else this.nextQ();
    },
    openReview() {
      if (!this.canReview) return;
      clearTimeout(this.autoNextTimer); // 回顾期间暂停自动跳题
      this.revIdx = this.ses.history.length - 1; // 默认定位到最近答过的一题
    },
    closeReview() { this.revIdx = null; },
    exit() {
      clearTimeout(this.autoNextTimer);
      // 无尽模式：退出即结算（本轮无终态，退出动作本身就是结束）
      if (this.ses.mode === "endless") { this.ses.finished = true; return; }
      if (this.ses.resolved > 0 && !confirm("退出本次学习？已答题目进度已自动保存。")) return;
      go("#/");
    },
    restart() { clearTimeout(this.autoNextTimer); S.studyRev++; },
    endlessScopeLabel(sc) { return endlessScopeLabel(sc); },
    startEndlessHere() {
      // 延续当前轮题源：分类轮 → 同分类；错题轮 → 错题本；题集/单题 → 全库
      const ses = this.ses;
      let scope = { type: "all" };
      if (ses.scope) scope = ses.scope;
      else if (ses.mode === "module" && ses.modIdx >= 0) scope = { type: "module", modIdx: ses.modIdx };
      else if (ses.mode === "wrong") scope = { type: "wrong" };
      startEndlessStudy(scope);
    },
    onKey(e) {
      if (this.finished) {
        if (e.key === "Escape") go("#/");
        return;
      }
      if (this.reviewing) {
        const last = this.ses.history.length - 1;
        if (e.key === "Enter" || e.key === "Escape") { this.closeReview(); return; }
        if (e.key === "ArrowLeft" && this.revIdx > 0) { this.revIdx--; return; }
        if (e.key === "ArrowRight" && this.revIdx < last) { this.revIdx++; return; }
        return;
      }
      if (!this.q) return;
      if (e.key === "Escape") { this.exit(); return; }
      const k = e.key.toUpperCase();
      const opt = this.q.o.find((o) => o.k.toUpperCase() === k);
      if (opt) { this.pick(opt.k); return; }
      if (e.key === "Enter") {
        if (this.answered) this.next();
        else if (this.isMulti && this.picked.length) this.confirmMulti();
      }
    },
  },
  template: `
  <div class="study" v-if="!finished">
    <div class="study-top">
      <button class="study-close" @click="exit">✕</button>
      <div class="study-prog" v-if="!endless"><i :style="{ width: progPct + '%' }"></i></div>
      <div class="study-count" :style="endless ? 'flex:1;text-align:center' : ''">
        {{ endless ? '无尽 · ' + endlessScopeLabel(ses.scope) + ' · 已答 ' + ses.history.length + ' 题' : resolved + '/' + total }}
      </div>
    </div>
    <div class="card q-card" v-if="reviewing && rev">
      <div class="q-meta">
        <span class="tag">{{ rev.q.c }}</span>
        <span class="tag multi" v-if="rev.q.m">多选</span>
        <span class="tag learnmark">回顾 {{ rev.idx + 1 }} / {{ rev.count }}</span>
      </div>
      <div class="q-text">{{ rev.q.q }}</div>
      <div class="opts locked">
        <button v-for="o in rev.q.o" :key="o.k" class="opt" disabled
          :class="{ right: rev.answerKeys.includes(o.k), wrongpick: rev.picked.includes(o.k) && !rev.answerKeys.includes(o.k) }">
          <span class="k">{{ o.k }}</span><span>{{ o.t }}</span>
        </button>
      </div>
      <div class="feedback" :class="rev.correct ? 'ok' : 'bad'">
        <b>{{ rev.correct ? '✓ 这题你答对了' : '✕ 正确答案：' + (rev.answerKeys.join('') || '') }}</b>
        <div class="expl" v-if="rev.expl"><b>解析</b>{{ rev.expl }}</div>
      </div>
      <div class="review-nav">
        <button class="btn ghost" :disabled="rev.idx <= 0" @click="revIdx--">‹ 更早一题</button>
        <button class="btn" @click="closeReview">回到答题</button>
        <button class="btn ghost" :disabled="rev.idx >= rev.count - 1" @click="revIdx++">较新一题 ›</button>
      </div>
    </div>
    <div class="card q-card" v-else-if="q">
      <div class="q-meta">
        <span class="tag">{{ q.c }}</span>
        <span class="tag multi" v-if="isMulti">多选</span>
        <span class="tag review" v-if="qLocal === 'w' && !isCons">错题重练</span>
        <span class="tag learnmark" v-if="qLocal === 'l' && !isCons">{{ ses.mode === 'due' ? '到期复习' : '待巩固' }}</span>
        <span class="tag learnmark" v-if="isCons">巩固 · 不计今日</span>
      </div>
      <div class="q-text">{{ q.q }}</div>
      <div class="opts" :class="{ locked: answered }">
        <button v-for="o in q.o" :key="o.k" class="opt"
          :class="{ sel: picked.includes(o.k), right: answered && answerKeys.includes(o.k), wrongpick: answered && picked.includes(o.k) && !answerKeys.includes(o.k) }"
          :disabled="answered || busy" @click="pick(o.k)">
          <span class="k">{{ o.k }}</span><span>{{ o.t }}</span>
        </button>
      </div>
      <div class="form-err" v-if="gradeErr">{{ gradeErr }}</div>
      <button class="btn confirm-btn" v-if="isMulti && !answered" :disabled="!picked.length" @click="confirmMulti">确认答案</button>
      <div class="feedback" :class="answered ? (correct ? 'ok' : 'bad') : ''" v-if="answered">
        <b>{{ correct ? '✓ 回答正确！' : '✕ 正确答案：' + (answerKeys.join('') || '') }}</b>
        <span v-if="!correct">稍后它会再次出现，直到你掌握它</span>
        <button class="expl-toggle" v-if="correct && expl" @click="explOpen = !explOpen">{{ explOpen ? '收起解析' : '查看解析' }}</button>
        <div class="expl" v-if="expl && (!correct || explOpen)"><b>解析</b>{{ expl }}</div>
      </div>
      <button class="btn next-btn" v-if="answered" @click="next">{{ queueLen > 1 ? "继续" : "查看结果" }}</button>
    </div>
    <div class="kbd-hint"><button class="expl-toggle" v-if="canReview && !reviewing" @click="openReview">↩ 查看上一题</button> A–D 选择 · Enter 确认/继续 · Esc {{ endless ? '结束并结算' : '退出' }}</div>
  </div>
  <div class="done-wrap" v-else>
    <div class="done-emoji"><i v-icon="'party-popper'"></i></div>
    <div class="done-title">{{ endless ? '无尽模式结算' : '本轮完成！' }}</div>
    <div class="done-stats">
      <div class="stat-card"><b>{{ endless ? ses.history.length : resolved }}</b><span>{{ endless ? '已答' : '已掌握' }}</span></div>
      <div class="stat-card"><b>{{ accPct }}%</b><span>首次正确率</span></div>
      <div class="stat-card" v-if="consN"><b>{{ consN }}</b><span>巩固题 · 不计今日</span></div>
      <div class="stat-card"><b>{{ minsText }}</b><span>用时</span></div>
    </div>
    <div class="done-actions">
      <button class="btn done-primary" @click="restart"><i v-icon="'rotate-ccw'"></i>再刷一遍</button>
      <div class="done-secondary">
        <button class="btn ghost" v-if="!endless" @click="startEndlessHere"><i v-icon="'infinity'"></i>无尽模式</button>
        <button class="btn ghost" @click="go('#/')"><i v-icon="'house'"></i>返回</button>
      </div>
    </div>
  </div>`,
});

// ================= 错题本 =================
app.component("view-wrong", {
  computed: {
    wrongList() {
      return Object.keys(S.progress.q)
        .filter((id) => S.progress.q[id].s === "w")
        .map(Number)
        .map((id) => S.bank.questions.find((q) => q.i === id))
        .filter(Boolean);
    },
  },
  mounted() {
    if (!S.bank || !this.wrongList.length) go("#/");
  },
  methods: {
    startWrong() { startWrongStudy(); },
    startSingle(qid) { startSingleStudy(qid); },
  },
  template: `
  <div class="page">
    <div class="policy-top">
      <button class="study-close" @click="go('#/')">←</button>
      <span class="policy-title">错题本</span>
    </div>
    <p class="h-sub">最近答错的题都会收集在这里，答对后移出</p>
    <button class="btn wrong-start" @click="startWrong">开始攻克（{{ wrongList.length }} 题）</button>
    <div class="wrong-list">
      <div class="card wrong-item" v-for="q in wrongList" :key="q.i" @click="startSingle(q.i)">
        <div class="mod-name">{{ q.q }}</div>
        <span class="tag">{{ q.c }}</span>
      </div>
    </div>
  </div>`,
});


// ================= 排行榜 =================
// 头像缓存（uid → dataURL|null，null 表示无头像用首字母），跨周期切换复用
const rankAvaCache = {};
app.component("view-rank", {
  data: () => ({ period: "day", list: null, err: "", avatars: {} }),
  computed: {
    myUid() { return S.me ? S.me.uid : null; },
    rankEq() { return S.rankEq; },
    hint() { return this.period === "day" ? "今日答题数（按 UTC+8 计日）" : this.period === "week" ? "近 7 天答题总数" : "近 30 天答题总数"; },
  },
  mounted() {
    this.load();
    this.timer = setInterval(() => this.load(true), 30_000); // 每 30 秒自动刷新
  },
  unmounted() { clearInterval(this.timer); },
  methods: {
    async load(silent) {
      if (!silent) this.err = "";
      try {
        const r = await api("/api/leaderboard?period=" + this.period);
        this.list = r.list;
        this.loadAvatars(r.list);
        this.loadEquips(r.list);
      } catch (e) {
        if (!silent) this.err = e.message || "加载失败，请重试";
      }
    },
    async loadEquips(list) {
      for (const row of list) {
        if (this.rankEq[row.uid] !== undefined) continue;
        if (rankEqCache[row.uid] !== undefined) { this.rankEq[row.uid] = rankEqCache[row.uid]; continue; }
        if (row.uid === (S.me && S.me.uid)) { rankEqCache[row.uid] = this.rankEq[row.uid] = [...S.equip]; continue; }
        try {
          const r = await api("/api/equip?u=" + row.uid);
          rankEqCache[row.uid] = this.rankEq[row.uid] = Array.isArray(r.eq) ? r.eq : [];
        } catch {
          rankEqCache[row.uid] = this.rankEq[row.uid] = [];
        }
      }
    },
    eqOf(r) { return this.rankEq[r.uid] !== undefined ? this.rankEq[r.uid] : (r.eq || []); },
    async loadAvatars(list) {
      for (const row of list) {
        // 自己的头像每次实时取，上传后立刻在榜单生效；他人头像走会话缓存
        if (row.uid === (S.me && S.me.uid)) {
          try {
            const a = await api("/api/avatar");
            rankAvaCache[row.uid] = this.avatars[row.uid] = `data:${a.t};base64,${a.d}`;
          } catch {
            rankAvaCache[row.uid] = this.avatars[row.uid] = null;
          }
          continue;
        }
        if (this.avatars[row.uid] !== undefined) continue;
        if (rankAvaCache[row.uid] !== undefined) { this.avatars[row.uid] = rankAvaCache[row.uid]; continue; }
        try {
          const a = await api("/api/avatar?u=" + row.uid);
          rankAvaCache[row.uid] = this.avatars[row.uid] = `data:${a.t};base64,${a.d}`;
        } catch {
          rankAvaCache[row.uid] = this.avatars[row.uid] = null; // 无头像，显示首字母
        }
      }
    },
    setPeriod(p) {
      if (this.period === p) return;
      this.period = p;
      this.list = null;
      this.load();
    },
  },
  template: `
  <div class="page rank-page">
    <div class="policy-top">
      <button class="study-close" @click="go('#/me')">←</button>
      <span class="policy-title">刷题排行榜</span>
    </div>
    <div class="tabs">
      <button :class="{ on: period === 'day' }" @click="setPeriod('day')">日榜</button>
      <button :class="{ on: period === 'week' }" @click="setPeriod('week')">周榜</button>
      <button :class="{ on: period === 'month' }" @click="setPeriod('month')">月榜</button>
    </div>
    <p class="rank-hint">{{ hint }} · 每 30 秒自动刷新 · 云备份与本地题库都计入</p>
    <div class="form-err" v-if="err">{{ err }}</div>
    <div class="card rank-row" v-for="(r, i) in list" :key="r.uid" :class="{ mine: r.uid === myUid }">
      <span class="rank-ava"><img v-if="avatars[r.uid]" :src="avatars[r.uid]" alt=""><span v-else>{{ (r.name || '?')[0].toUpperCase() }}</span></span>
      <span class="rank-name">
        <span class="rn-top">{{ r.name }}<b class="rank-no">#{{ i + 1 }}</b><b class="you" v-if="r.uid === myUid">我</b></span>
        <span class="rn-badges" v-if="eqOf(r).length"><equip-badges :eq="eqOf(r)" size="xs"></equip-badges></span>
      </span>
      <span class="rank-n">{{ r.n }} 题</span>
    </div>
    <div class="card admin-card" v-if="list && !list.length">
      <p class="danger-note">还没有数据，先去刷几题吧</p>
    </div>
  </div>`,
});

// ================= 成就徽章墙 =================
app.component("view-ach", {
  computed: {
    ach() { return S.ach; },
    achTier() { return S.achTier; },
    equip() { return S.equip; },
    nUnlocked() { return ACHIEVEMENTS.filter((a) => S.ach[a.id]).length; },
    total() { return ACHIEVEMENTS.length; },
    cats() {
      const titles = ["坚持", "掌握", "强度", "高光", "全收集"];
      return titles.map((name, ci) => ({
        name,
        items: ACHIEVEMENTS.filter((a) => a.cat === ci).sort((x, y) => (x.tiers ? 0 : 1) - (y.tiers ? 0 : 1) || (x.tier || 0) - (y.tier || 0)),
      }));
    },
  },
  methods: {
    async toggleEquip(id) {
      if (this.equip.includes(id)) {
        await saveEquip(S.equip.filter((x) => x !== id));
        toast("已取下徽章");
      } else if (S.equip.length >= 3) {
        toast("最多佩戴 3 枚，请先取下一枚");
      } else {
        await saveEquip([...S.equip, id]);
        toast("已佩戴「" + ((ACHIEVEMENTS.find((a) => a.id === id) || {}).name || "") + "」");
      }
    },
    badgeSvg(a) {
      // 已解锁按当前档位着色，未解锁以一档墨色置灰展示
      return badgeSvg(a, this.ach[a.id] ? (this.achTier[a.id] || 1) : 0);
    },
    tierClass(a) {
      const t = this.achTier[a.id] || 0;
      return t === 2 ? "t2" : t === 3 ? "t3" : "";
    },
    achDesc(a) {
      if (!a.tiers) return a.desc;
      const t = this.achTier[a.id] || 0;
      if (!t) return a.descs[0] + " 起";
      return a.descs[t - 1] + (t < 3 ? " · 下一档 " + a.descs[t] : " · 已满档");
    },
    fmtTs(ts) {
      const d = new Date(ts);
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日解锁`;
    },
  },
  template: `
  <div class="page rank-page">
    <div class="policy-top">
      <button class="study-close" @click="go('#/me')">←</button>
      <span class="policy-title">我的成就</span>
    </div>
    <p class="rank-hint">已解锁 {{ nUnlocked }} / {{ total }} · 达成条件即自动点亮，最多佩戴 3 枚</p>
    <div v-for="c in cats" :key="c.name">
      <div class="sec-title"><span>{{ c.name }}</span></div>
      <div class="ach-grid">
        <div class="card ach-item" v-for="a in c.items" :key="a.id" :class="[tierClass(a), { on: !!ach[a.id] }]">
          <span class="badge" v-html="badgeSvg(a)"></span>
          <b>{{ a.name }}</b>
          <span class="desc">{{ achDesc(a) }}</span>
          <span class="ach-dots" v-if="a.tiers"><i v-for="d in 3" :key="d" :class="{ f: (achTier[a.id] || 0) >= d }"></i></span>
          <span class="date" v-if="ach[a.id]">{{ fmtTs(ach[a.id]) }}</span>
          <button class="ach-equip" v-if="ach[a.id]" :class="{ on: equip.includes(a.id) }" @click="toggleEquip(a.id)">{{ equip.includes(a.id) ? "已佩戴" : "佩戴" }}</button>
        </div>
      </div>
    </div>
  </div>`,
});

// ================= 佩戴徽章展示 =================
// 统一细线奖章章形（与 Lucide 线性图标语言一致），外环按档位着色（墨/银/金，走主题变量适配暗色），
// 每枚成就以专属图标区分；图标若撞车在成就定义里换用其他 Lucide 图标
function badgeSvg(a, tier) {
  const metal = tier >= 3 ? "var(--gold)" : tier === 2 ? "var(--silver)" : tier > 0 ? "var(--ink)" : "var(--faint)";
  const L = window.lucide;
  const pascal = a.icon.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
  const node = L && L.icons[pascal];
  const inner = node ? node.map(([tag, at]) => {
    const attrs = Object.entries(at).map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<${tag} ${attrs}/>`;
  }).join(" ") : "";
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21.5" fill="none" stroke="${metal}" stroke-width="2"/><circle cx="24" cy="24" r="16.5" fill="none" stroke="${metal}" stroke-width="0.8" opacity=".5"/><g transform="translate(12 12)" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
}
const rankEqCache = {}; // uid -> 装备数组（会话级缓存，佩戴变化低频）
app.component("equip-badges", {
  props: {
    eq: { type: Array, default: () => [] },
    selfTier: { type: Object, default: null }, // 传入时按自己的实际档位着色（进阶成就）
    size: { type: String, default: "" }, // xs：昵称下小尺寸行内展示
  },
  computed: {
    items() {
      return this.eq.map((id) => ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean);
    },
  },
  methods: {
    cls(a) {
      const t = (this.selfTier && this.selfTier[a.id]) || a.tier || 1;
      return t >= 3 ? "t3" : t === 2 ? "t2" : "";
    },
    badge(a) {
      const t = (this.selfTier && this.selfTier[a.id]) || a.tier || 1;
      return badgeSvg(a, t);
    },
  },
  template: `
  <span class="equip-badges" :class="size">
    <span class="equip-b" v-for="a in items" :key="a.id" :class="cls(a)" :title="a.name" v-html="badge(a)"></span>
  </span>`,
});

// ================= 学习统计 =================
app.component("view-stats", {
  computed: {
    streak() { return calcStreak(mergedDays()); },
    week() {
      const merged = mergedDays();
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        days.push({ key, label: "日一二三四五六"[d.getDay()], n: merged[key] || 0 });
      }
      return days;
    },
    maxWeek() { return Math.max(...this.week.map((x) => x.n), 1); },
    calendar() {
      const merged = mergedDays();
      const DAY = 86400000;
      const today0 = new Date(); today0.setHours(0, 0, 0, 0);
      const WEEKS = 13;
      const thisMonday = new Date(today0.getTime() - ((today0.getDay() + 6) % 7) * DAY);
      const start = new Date(thisMonday.getTime() - (WEEKS - 1) * 7 * DAY);
      const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const cells = [];
      const months = [];
      let prevMonth = -1;
      for (let w = 0; w < WEEKS; w++) {
        const monday = new Date(start.getTime() + w * 7 * DAY);
        if (monday.getMonth() !== prevMonth) { months.push({ col: w + 1, label: `${monday.getMonth() + 1}月` }); prevMonth = monday.getMonth(); }
        for (let d = 0; d < 7; d++) {
          const day = new Date(start.getTime() + (w * 7 + d) * DAY);
          const n = merged[keyOf(day)] || 0;
          const future = day > today0;
          const lvl = n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4;
          cells.push({ key: keyOf(day), n, future, lvl });
        }
      }
      return { months, cells };
    },
  },
  template: `
  <div class="page rank-page">
    <div class="policy-top">
      <button class="study-close" @click="go('#/me')">←</button>
      <span class="policy-title">学习统计</span>
    </div>
    <div class="card me-card">
      <div class="sec-title" style="margin:0"><span>近 7 天答题</span></div>
      <div class="week">
        <div v-for="d in week" :key="d.key" :class="['day', { hot: d.n >= maxWeek && d.n > 0 }]">
          <i :style="{ height: Math.max(4, (d.n / maxWeek) * 46) + 'px' }"></i>
          <span>{{ d.label }}</span>
        </div>
      </div>
    </div>
    <div class="card me-card">
      <div class="sec-title" style="margin:0"><span>刷题日历</span><span>{{ streak > 0 ? '已连续 ' + streak + ' 天' : '今天开始刷一题吧' }}</span></div>
      <div class="cal">
        <div></div>
        <div class="cal-months">
          <span v-for="m in calendar.months" :key="m.col" :style="{ gridColumn: m.col }">{{ m.label }}</span>
        </div>
        <div></div>
        <div class="cal-grid">
          <i v-for="c in calendar.cells" :key="c.key" :class="'lvl' + c.lvl" :title="c.key + ' · ' + (c.n > 0 ? '答对 ' + c.n + ' 题' : '无记录')"></i>
        </div>
      </div>
      <div class="cal-legend">少 <i class="lvl0"></i><i class="lvl1"></i><i class="lvl2"></i><i class="lvl3"></i><i class="lvl4"></i> 多</div>
    </div>
  </div>`,
});

// ================= 我的 =================
app.component("view-me", {
  computed: {
    me() { return S.me; },
    equip() { return S.equip; },
    achTier() { return S.achTier; },
    achCount() { return ACHIEVEMENTS.filter((a) => S.ach[a.id]).length; },
    achTotal() { return ACHIEVEMENTS.length; },
    pct() { return this.total ? Math.round((this.mastered / this.total) * 100) : 0; },
    mastered() { return Object.values(S.progress.q).filter((v) => v.s === "m").length; },
    learning() { return Object.values(S.progress.q).filter((v) => v.s === "l").length; },
    wrong() { return Object.values(S.progress.q).filter((v) => v.s === "w").length; },
    total() { return S.bank ? S.bank.questions.length : 0; },
    todayN() { return mergedDays()[todayStr()] || 0; },
    merged() { return mergedDays(); },
    savedCount() { S.filterRev; return getFilterSets().length; },
    endlessLastLabel() {
      const sc = S.endlessScope || { type: "all" };
      if (sc.type === "module") {
        const m = S.bank && S.bank.modules[sc.modIdx];
        return m ? m.name : "整个题库";
      }
      return { all: "全库循环", wrong: "错题本", learning: "待巩固", "filter-set": "题集" }[sc.type] || "全库循环";
    },
    endlessOptions() {
      const bank = S.bank;
      if (!bank) return [];
      const opts = [{ type: "all", label: "整个题库", count: bank.questions.length }];
      (bank.modules || []).forEach((m, idx) => {
        if (m.qids.length) opts.push({ type: "module", modIdx: idx, label: m.name, count: m.qids.length });
      });
      const w = Object.keys(S.progress.q).filter((id) => S.progress.q[id].s === "w").length;
      if (w) opts.push({ type: "wrong", label: "错题本", count: w });
      const l = Object.keys(S.progress.q).filter((id) => S.progress.q[id].s === "l").length;
      if (l) opts.push({ type: "learning", label: "待巩固", count: l });
      getFilterSets().forEach((set) => {
        const n = endlessQids({ type: "filter-set", setId: set.id }).length;
        if (n) opts.push({ type: "filter-set", setId: set.id, label: "题集 · " + (set.name || "未命名"), count: n });
      });
      return opts;
    },
  },
  template: `
  <div class="page">
    <div class="me-head">
      <h1 class="h-page">我的</h1>
      <button class="gear-btn" @click="settingsOpen = true" aria-label="设置">
        <i v-icon="'settings'"></i>
      </button>
    </div>
    <div class="card me-card">
      <div class="me-row">
        <div class="avatar" @click="avatarOpen = true" title="点击修改头像">
          <img v-if="avatarUrl" :src="avatarUrl" class="avatar-img" alt="">
          <span v-else>{{ (me.username || '?')[0].toUpperCase() }}</span>
        </div>
        <div>
          <div class="me-name">{{ me.username }} <equip-badges :eq="equip" :self-tier="achTier"></equip-badges></div>
          <div class="me-sub">已完成 {{ pct }}% 题库 · 累计打卡 {{ Object.keys(merged).length }} 天</div>
        </div>
      </div>
      <div class="me-stats">
        <div class="stat-card"><b class="ok">{{ mastered }}</b><span>已掌握</span></div>
        <div class="stat-card"><b class="warn">{{ learning }}</b><span>待巩固</span></div>
        <div class="stat-card"><b class="bad">{{ wrong }}</b><span>错题</span></div>
        <div class="stat-card"><b>{{ todayN }}</b><span>今日</span></div>
      </div>
    </div>
    <div class="entry-row">
      <button class="card rank-entry" @click="go('#/ach')">
        <div class="mod-ico"><i v-icon="'medal'"></i></div>
        <div class="mod-info">
          <div class="mod-name">我的成就</div>
          <div class="mod-count">{{ achCount }} / {{ achTotal }}</div>
        </div>
      </button>
      <button class="card rank-entry" @click="endlessOpen = true">
        <div class="mod-ico"><i v-icon="'swords'"></i></div>
        <div class="mod-info">
          <div class="mod-name">无尽模式</div>
          <div class="mod-count">{{ endlessLastLabel }} · 随时结算</div>
        </div>
      </button>
      <button class="card rank-entry" @click="go('#/rank')">
        <div class="mod-ico"><i v-icon="'trophy'"></i></div>
        <div class="mod-info">
          <div class="mod-name">刷题排行榜</div>
        </div>
      </button>
      <button class="card rank-entry" @click="go('#/stats')">
        <div class="mod-ico"><i v-icon="'chart-column'"></i></div>
        <div class="mod-info">
          <div class="mod-name">学习统计</div>
        </div>
      </button>
      <button class="card rank-entry" @click="go('#/saved-collections')">
        <div class="mod-ico"><i v-icon="'list-filter'"></i></div>
        <div class="mod-info">
          <div class="mod-name">我的题集</div>
          <div class="mod-count">{{ savedCount }} 个</div>
        </div>
      </button>
    </div>
      <p class="author-line">由 Tisheng 用心打造</p>
    <div class="sheet-mask" :class="{ open: avatarOpen }" @click="avatarOpen = false">
      <div class="sheet" role="dialog" aria-label="修改头像">
        <div class="sheet-head"><span>修改头像</span><button class="study-close" @click="avatarOpen = false">✕</button></div>
        <input ref="avatarFile" type="file" accept="image/*" hidden @change="onAvatarFile">
        <button class="btn ghost" :disabled="avatarBusy" @click="$refs.avatarFile.click()">{{ avatarBusy ? "审核中…" : "上传新头像" }}</button>
        <button class="btn ghost" :disabled="!avatarUrl || avatarBusy" @click="resetAvatar">恢复默认头像</button>
      </div>
    </div>
    <div class="sheet-mask" :class="{ open: endlessOpen }" @click="endlessOpen = false">
      <div class="sheet" role="dialog" aria-label="无尽模式">
        <div class="sheet-head"><span>无尽模式</span><button class="study-close" @click="endlessOpen = false">✕</button></div>
        <p class="imp-note">选择要循环练习的题目范围，答完一题自动滚到队尾，随时退出即结算。</p>
        <div class="endless-list">
          <button class="endless-item" v-for="o in endlessOptions" :key="o.type + (o.modIdx ?? '') + (o.setId || '')" @click="startEndless(o)">
            <span>{{ o.label }}</span><b>{{ o.count }} 题</b>
          </button>
        </div>
      </div>
    </div>
    <div class="sheet-mask" :class="{ open: settingsOpen }" @click="settingsOpen = false">
      <div class="sheet" role="dialog" aria-label="设置">
        <div class="sheet-head"><span>设置</span><button class="study-close" @click="settingsOpen = false">✕</button></div>
        <div class="sheet-label">外观模式</div>
        <!-- .stop 防止点击冒泡到遮罩把面板关掉 -->
        <div class="tabs theme-tabs" @click.stop>
          <button :class="{ on: theme === 'auto' }" @click="setTheme('auto')">跟随系统</button>
          <button :class="{ on: theme === 'light' }" @click="setTheme('light')">亮色</button>
          <button :class="{ on: theme === 'dark' }" @click="setTheme('dark')">暗色</button>
        </div>
        <div class="sheet-label">章节巩固</div>
        <div class="tabs theme-tabs" @click.stop>
          <button :class="{ on: consolidate }" @click="setConsolidate(true)">开启</button>
          <button :class="{ on: !consolidate }" @click="setConsolidate(false)">关闭</button>
        </div>
        <p class="imp-note">开启后章节练习会按比例混入昨天刷过且未掌握的题帮助巩固；这部分作答不计入今日答题数、打卡与排行榜。</p>
        <button class="btn ghost" @click="go('#/account')">账号与安全</button>
        <button class="btn ghost" @click="go('#/privacy')">隐私政策</button>
        <button class="btn ghost" @click="doLogout">退出登录</button>
      </div>
    </div>
  </div>`,
  data: () => ({
    avatarUrl: null, avatarOpen: false, settingsOpen: false, avatarBusy: false,
    theme: localStorage.getItem("ts_theme") || "auto",
    consolidate: localStorage.getItem("ts_consolidate") !== "0",
    endlessOpen: false, // 无尽模式题源选择面板
  }),
  mounted() {
    fetch("/api/avatar", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || !j.d) return;
        const url = `data:${j.t};base64,${j.d}`;
        localStorage.setItem("ts_avatar", url);
        this.avatarUrl = url;
      })
      .catch(() => {});
  },
  methods: {
    startEndless(opt) {
      const sc = opt.type === "module"
        ? { type: "module", modIdx: opt.modIdx }
        : opt.type === "filter-set"
          ? { type: "filter-set", setId: opt.setId }
          : { type: opt.type };
      S.endlessScope = sc; // 记住本次选择，下次默认沿用
      this.endlessOpen = false;
      startEndlessStudy(sc);
    },
    setConsolidate(on) {
      this.consolidate = on;
      localStorage.setItem("ts_consolidate", on ? "1" : "0");
      toast(on ? "章节巩固已开启" : "章节巩固已关闭");
    },
    setTheme(m) {
      window.setThemeMode(m);
      this.theme = localStorage.getItem("ts_theme") || "auto";
      toast(m === "auto" ? "外观已跟随系统" : (m === "dark" ? "已切换为暗色模式" : "已切换为亮色模式"));
    },
    doLogout() {
      const uid = S.me && S.me.uid;
      this.settingsOpen = false;
      api("/api/logout", { method: "POST" }).catch(() => {});
      S.me = null;
      S.ach = {};
      S.bank = null;
      S.progress = { q: {}, d: {} };
      S.progressCache = {};
      S.pending = [];
      clearAccountStorage(uid);
      location.hash = "#/";
      S.view = "login";
    },
    async onAvatarFile(e) {
      const file = e.target.files[0];
      if (!file || this.avatarBusy) return;
      this.avatarBusy = true;
      try {
        const { type, data } = await compressAvatar(file);
        // AI 审核可能耗时较长（实测有 20s+），放宽超时避免误报失败
        await api("/api/avatar", { method: "POST", body: { t: type, d: data }, timeout: 45000 });
        this.avatarUrl = `data:${type};base64,${data}`;
        localStorage.setItem("ts_avatar", this.avatarUrl);
        toast("头像已更新");
      } catch (e2) {
        toast(e2.status === 0 ? "审核时间较长，请稍后刷新查看是否生效" : (e2.message || "头像处理失败"));
      } finally {
        this.avatarBusy = false;
        e.target.value = "";
      }
    },
    async resetAvatar() {
      if (this.avatarBusy || !this.avatarUrl) return;
      this.avatarBusy = true;
      try {
        await api("/api/avatar", { method: "DELETE" });
        this.avatarUrl = null;
        localStorage.removeItem("ts_avatar");
        toast("已恢复默认头像");
      } catch {
        toast("操作失败，请重试");
      } finally {
        this.avatarBusy = false;
      }
    },
  },
});

// ================= 账号与安全 =================
app.component("view-account", {
  data: () => ({ acctType: "pw", acctOpen: false, oldPw: "", newPw: "", newPw2: "", newUn: "", pw: "", tsToken: null, tsId: undefined, busy: false, err: "", exportBusy: false, impBusy: false }),
  mounted() {
    this.initTs();
    document.addEventListener("click", this.closeAcctOnOutside);
  },
  unmounted() {
    document.removeEventListener("click", this.closeAcctOnOutside);
  },
  methods: {
    pickAcct(t) {
      this.acctType = t;
      this.acctOpen = false;
      this.err = "";
    },
    closeAcctOnOutside(e) {
      if (this.acctOpen && !e.target.closest(".acct-select")) this.acctOpen = false;
    },
    async initTs() {
      const sk = await ensureTurnstile();
      if (!sk || !this.$refs.tsBox) return;
      this.$nextTick(() => {
        if (this.$refs.tsBox) this.tsId = renderTsWidget(this.$refs.tsBox, (t) => { this.tsToken = t; });
      });
    },
    resetTs() {
      if (this.tsId !== undefined && window.turnstile) { try { window.turnstile.reset(this.tsId); } catch {} }
      this.tsToken = null;
    },
    async exportData() {
      this.exportBusy = true;
      try {
        if (!(await syncFilterSets())) throw new Error("题集云端同步失败，请稍后再导出");
        const locals = getLocalBanks();
        const filterSets = getStoredFilterSets();
        const r = await api("/api/export", { method: "POST", timeout: 120000, body: { local: { banks: locals, progress: locals.map((b) => ({ id: b.id, p: loadProg(b.id) })), filterSets } } });
        const password = prompt("为这份备份设置独立密码（至少 8 位）；密码不会上传，丢失后备份无法恢复");
        if (password === null) return;
        if (password.length < 8 || password.length > 128) throw new Error("备份密码需为 8-128 位");
        const confirmed = prompt("请再次输入备份密码");
        if (confirmed !== password) throw new Error("两次输入的备份密码不一致");
        const sealed = await sealBackupVault(r.vault, password);
        const blob = new Blob([JSON.stringify(sealed)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
      a.download = `Tisheng备份_${todayStr()}.tibk`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`备份已导出（客户端加密 · 云端数据：${fmtTime(r.cloudAt)}）`);
      } catch (e) {
        toast(e.message || "导出失败，请重试");
      } finally {
        this.exportBusy = false;
      }
    },
    async onBackupFile(e) {
      const f = e.target.files[0];
      if (!f) return;
      this.impBusy = true;
      try {
        const vault = await unpackBackupFile(JSON.parse(await f.text()));
        if (!vault) return;
        const r = await api("/api/import", { method: "POST", timeout: 120000, body: { vault } });
        const bak = `备份时间：${fmtTime(r.exportedAt)}`;
        const cloud = `云端数据：${fmtTime(r.cloudAt)}`;
        let msg;
        if (r.backupName === S.me.username) msg = `这是当前账号的备份。\n${bak}\n${cloud}\n\n确定用备份数据覆盖云端，并将备份内的本机题库写入本机吗？`;
        else if (r.sameData) msg = `备份属于账号「${r.backupName}」，与当前账号「${S.me.username}」的云端数据一致。\n${bak}\n${cloud}\n\n确定覆盖云端，并将备份内的本机题库写入本机吗？`;
        else msg = `备份属于账号「${r.backupName}」，与当前账号数据不同。\n${bak}\n${cloud}\n\n导入将用备份覆盖当前账号「${S.me.username}」的云端数据，本机题库写入本机。确定继续吗？`;
        if (!confirm(msg)) return;
        const ap = await api("/api/import", { method: "POST", timeout: 120000, body: { vault, mode: "apply" } });
        const list = getLocalBanks();
        for (const b of ap.local.banks || []) {
          const i = list.findIndex((x) => x.id === b.id);
          if (i >= 0) list[i] = b; else list.push(b);
        }
        saveLocalBanks(list);
        for (const p of ap.local.progress || []) localStorage.setItem(progKey(p.id), JSON.stringify(p.p));
        if (Array.isArray(ap.local.filterSets)) {
          saveFilterSets(mergeFilterSets(getStoredFilterSets(), ap.local.filterSets));
          S.filterRev++;
          syncFilterSets();
        }
        S.cloudLoaded = false;
        delete S.progressCache.cloud;
        if (S.bankId === "cloud") await loadCloudBank();
        refreshBanksView();
        toast("备份已导入");
      } catch (err) {
        toast(err.message || "导入失败，请重试");
      } finally {
        this.impBusy = false;
        e.target.value = "";
      }
    },
    async deleteAccount() {
      const uid = S.me && S.me.uid;
      if (!confirm("注销后账号与全部学习数据将被永久删除且不可恢复，确定继续？")) return;
      if (!confirm("再次确认：真的要注销账号吗？")) return;
      try {
        await api("/api/delete-account", { method: "POST" });
      } catch {}
      S.me = null;
      S.ach = {};
      S.bank = null;
      S.progress = { q: {}, d: {} };
      S.progressCache = {};
      S.pending = [];
      clearAccountStorage(uid);
      location.hash = "#/";
      S.view = "login";
    },
    async submit() {
      this.err = "";
      if (S.tsSiteKey && !this.tsToken) { this.err = "请先完成人机验证"; return; }
      this.busy = true;
      try {
        if (this.acctType === "pw") {
          if (!this.oldPw) { this.err = "请输入原密码"; return; }
          if (this.newPw.length < 6 || this.newPw.length > 72) { this.err = "新密码长度需为 6-72 位"; return; }
          if (this.newPw !== this.newPw2) { this.err = "两次输入的新密码不一致"; return; }
          await api("/api/change-password", { method: "POST", body: { oldPassword: this.oldPw, newPassword: this.newPw, tsToken: this.tsToken } });
          toast("密码已修改，其他设备需重新登录");
          this.oldPw = this.newPw = this.newPw2 = "";
        } else {
          if (!/^[a-zA-Z0-9]{2,10}$/.test(this.newUn)) { this.err = "新用户名需为 2-10 位字母或数字"; return; }
          if (this.newUn.toLowerCase() === S.me.username.toLowerCase()) { this.err = "新用户名与当前用户名相同"; return; }
          if (!this.pw) { this.err = "请输入当前密码"; return; }
          const r = await api("/api/change-username", { method: "POST", body: { newUsername: this.newUn, password: this.pw, tsToken: this.tsToken } });
          S.me.username = r.username;
          toast(`用户名已改为 ${r.username}`);
          this.newUn = this.pw = "";
        }
        this.resetTs();
      } catch (e) {
        this.err = e.message;
        this.resetTs();
      } finally {
        this.busy = false;
      }
    },
  },
  template: `
  <div class="policy">
    <div class="policy-top">
      <button class="study-close" @click="go('#/me')">←</button>
      <span class="policy-title">账号与安全</span>
    </div>
    <div class="card account-card set-form">
      <label class="acct-label">修改项目</label>
      <div class="acct-select" :class="{ open: acctOpen }">
        <button type="button" class="acct-select-btn" @click="acctOpen = !acctOpen">
          <span>{{ acctType === 'pw' ? '修改密码' : '修改用户名' }}</span>
          <i v-icon="'chevron-down'"></i>
        </button>
        <div class="acct-menu" :hidden="!acctOpen">
          <button type="button" class="acct-option" :class="{ on: acctType === 'pw' }" @click="pickAcct('pw')">修改密码</button>
          <button type="button" class="acct-option" :class="{ on: acctType === 'un' }" @click="pickAcct('un')">修改用户名</button>
        </div>
      </div>
      <div id="pwFields" v-if="acctType === 'pw'">
        <input type="password" v-model="oldPw" placeholder="原密码" autocomplete="current-password">
        <input type="password" v-model="newPw" placeholder="新密码（6-72 位）" autocomplete="new-password">
        <input type="password" v-model="newPw2" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div id="unFields" v-else>
        <input v-model.trim="newUn" placeholder="新用户名（2-10 位字母或数字）">
      </div>
      <label class="acct-label">安全验证</label>
      <div class="ts-wrap"><div ref="tsBox"></div></div>
      <div class="form-err">{{ err }}</div>
      <button class="btn" :disabled="busy" @click="submit">确认修改</button>
    </div>
    <div class="card account-card">
      <div class="acct-title">我的数据</div>
      <p class="danger-note">导出为客户端加密备份（.tibk，含指纹校验和防篡改）；备份密码不上传，丢失后无法恢复备份。</p>
      <button class="btn ghost" :disabled="exportBusy" @click="exportData">{{ exportBusy ? "导出中…" : "导出用户数据" }}</button>
      <input ref="backupFile" type="file" accept=".tibk,.json,application/json" hidden @change="onBackupFile">
      <button class="btn ghost" :disabled="impBusy" @click="$refs.backupFile.click()">{{ impBusy ? "导入中…" : "导入备份" }}</button>
    </div>
      <div class="card account-card">
        <div class="acct-title">危险操作</div>
        <p class="danger-note">注销后账号与全部学习数据将被永久删除且不可恢复，请谨慎操作。</p>
        <button class="btn danger" @click="deleteAccount">注销账号</button>
      </div>
    </div>`,
  });

// ================= 隐私政策 =================
app.component("view-privacy", {
  template: `
  <div class="policy">
    <div class="policy-top">
      <button class="study-close" @click="go('#/me')">←</button>
      <span class="policy-title">隐私政策</span>
    </div>
    <h1>隐私政策</h1>
    <p class="meta">最后更新：2026 年 10 月 11 日 · 版本 v5</p>
<p>「Tisheng」（下称"本应用"）是一款多题库刷题工具。我们非常重视你的隐私，本政策说明我们收集哪些信息、如何使用与保护它们。</p>
    <h2>一、我们收集的信息</h2>
    <ul>
      <li><b>账号信息</b>：用户名，以及密码的加盐哈希值（PBKDF2-SHA256，10 万次迭代）。明文密码不会被存储。</li>
      <li><b>学习数据</b>：每道题的作答结果与掌握状态、答题时间戳、每日答题统计、成就解锁记录。</li>
      <li><b>排行榜数据</b>：每日答题总数（含本地题库，仅数量，不含题目内容与对错明细）用于日/周/月榜，与你的用户名一同展示。不参与排行榜可在设置中反馈关闭。</li>
      <li><b>题库数据</b>：你导入的题库内容与解析，作为你的云备份存储。</li>
      <li><b>安全数据</b>：登录与注册需通过 Cloudflare Turnstile 人机验证。</li>
    </ul>
    <h2>二、信息的使用</h2>
    <p>上述信息仅用于：提供账号登录与身份验证；跨设备同步你的学习进度与题库；防止自动化滥用。我们不会将你的信息用于广告、用户画像，也不会与第三方共享。</p>
    <h2>三、存储与安全</h2>
    <ul>
      <li>数据存储于 Cloudflare Workers KV，传输全程使用 TLS 加密。</li>
      <li>云备份题库判分在服务端进行；本地题库判分在本机进行，题目不出设备。</li>
      <li>登录态使用 HttpOnly 签名 Cookie，页面脚本无法读取。</li>
    </ul>
    <h2>四、Cookie 说明</h2>
    <ul>
      <li><b>ts_sid</b>：登录会话 Cookie。勾选「7天免密登录」时保留 7 天；不勾选则随浏览器关闭失效。</li>
      <li>Cloudflare 在安全验证过程中可能设置必要的临时 Cookie。</li>
    </ul>
    <h2>五、数据保留与闲置账号清理</h2>
    <ul>
      <li>系统每日自动清理连续 <b>60 天</b>无任何登录或活动记录的账号，其云端题库、学习进度、成就与头像将被一并删除且<b>不可恢复</b>。</li>
      <li>临近清理不会另行通知。如需长期保留数据，请至少每 60 天登录一次，或提前在「账号与安全 → 导出备份」下载数据。</li>
    </ul>
    <h2>六、账号安全与责任声明</h2>
    <ul>
      <li>请妥善保管账号与密码，不要在不受信任的设备上保持登录状态。</li>
      <li>通过你的账号密码执行的修改密码、修改用户名、导入备份覆盖数据、注销账号等操作，均视为账号持有人本人的行为；因密码保管不当或主动泄露导致的账号被修改、数据被覆盖或注销等后果，由用户自行承担。</li>
      <li>备份文件（.tibk）包含账号的全部数据，且可通过「从备份恢复」重建账号，请勿提供给他人。</li>
    </ul>
    <h2>七、你的权利</h2>
    <ul>
      <li>在「我的」页面可随时重置全部学习进度，或退出登录。</li>
      <li>可在「账号与安全 → 注销账号」自助注销，账号与全部数据将被立即且永久删除。</li>
    </ul>
    <h2>八、政策变更</h2>
    <p>本政策如有重大变更，将在本页面更新并标注日期。</p>
  </div>`,
});


// ================= 路由与启动 =================
function go(h) {
  // hash 相同时 hashchange 不会触发（如登出后停在 #/ 再登录），直接重算路由
  if (location.hash === h) parseRoute();
  else location.hash = h;
}

function parseRoute() {
  const hash = location.hash || "#/";
  if (!S.me) { S.view = "login"; return; }
  if (hash === "#/" || hash === "#") { S.view = "home"; return; }
  if (hash === "#/banks") { S.view = "banks"; return; }
  if (hash === "#/collections") { S.view = "collections"; return; }
  if (hash === "#/saved-collections") { S.view = "saved-collections"; return; }
  const bm = hash.match(/^#\/bank\/([a-z0-9-]+)$/);
  if (bm) {
    const id = bm[1];
    // 切题库：丢弃上一题库的残留会话（其队列是旧题库的题目 ID，跨库会答非所问）
    S.study = null;
    S.studyConf = null;
    if (id === "cloud") {
      if (!S.bank || S.bank.id !== "cloud") loadCloudBank().then(() => { if (S.view !== "home") { S.view = "home"; } });
      S.view = "home";
      S.bankId = "cloud";
      return;
    }
    const lb = getLocalBank(id);
    if (lb) {
      S.bank = { ...lb, id, local: true };
      S.qkeys = lb.questions.map((q) => q.i);
      S.progress = loadProg(id);
      S.progressCache[id] = S.progress;
      S.view = "home";
      S.bankId = id;
      return;
    }
    S.view = "banks";
    return;
  }
  if (hash.startsWith("#/study/")) {
    if (!S.bank) { S.view = "banks"; return; }
    const rest = hash.slice(8);
    if (rest === "wrong") {
      S.studyConf = { mode: "wrong" };
      S.view = "study";
      return;
    }
    if (rest === "endless") {
      S.studyConf = { mode: "endless", scope: S.endlessScope || { type: "all" } };
      S.view = "study";
      return;
    }
    if (rest === "filter") {
      if (S.studyConf && S.studyConf.mode === "filter" && Array.isArray(S.studyConf.qids)) {
        S.view = "study";
        return;
      }
      S.view = "home";
      return;
    }
    const sm = rest.match(/^single\/(\d+)$/);
    if (sm) {
      S.studyConf = { mode: "single", qid: parseInt(sm[1], 10) };
      S.view = "study";
      return;
    }
    const idx = parseInt(rest, 10);
    if (Number.isInteger(idx) && S.bank.modules[idx]) {
      S.studyConf = { mode: "module", modIdx: idx };
      S.view = "study";
      return;
    }
    S.view = "home";
    return;
  }
  if (hash === "#/endless") {
    if (!S.bank) { S.view = "banks"; return; }
    S.studyConf = { mode: "endless" };
    S.view = "study";
    return;
  }
  if (hash === "#/wrong") { S.view = "wrong"; return; }
  if (hash === "#/rank") { S.view = "rank"; return; }
  if (hash === "#/ach") { S.view = "ach"; return; }
  if (hash === "#/stats") { S.view = "stats"; return; }
  if (hash === "#/me") { S.view = "me"; return; }
  if (hash === "#/account") { S.view = "account"; return; }
  if (hash === "#/privacy") { S.view = "privacy"; return; }
  S.view = "home";
}


window.addEventListener("hashchange", () => { if (S.booted) parseRoute(); });

async function boot() {
  loadLocal();
  S.endlessScope = loadEndlessScope(); // 恢复上次的无尽模式题源
  try {
    try {
      const cfg = await api("/api/config");
      S.tsSiteKey = cfg.tsSiteKey || null;
      S.tsCfgFetched = true;
    } catch {}
    S.me = await api("/api/me");
    const last = localStorage.getItem("ts_last") || "cloud";
    if (last === "cloud") await loadCloudBank();
    else if (getLocalBank(last)) {
      S.bank = { ...getLocalBank(last), id: last, local: true };
      S.qkeys = S.bank.questions.map((q) => q.i);
      S.progress = loadProg(last);
      S.progressCache[last] = S.progress;
    } else await loadCloudBank();
    S.booted = true;
    parseRoute();
    syncFilterSets();
    backfillActivity(); // 每 12 小时校准一次排行榜历史（幂等，不会翻倍）
    loadAch(); // 拉取云端成就记录并做一次补判
  } catch (e) {
    if (e.status === 401) { S.me = null; S.view = "login"; }
    else S.netError = true;
    S.booted = true;
  }
}

setInterval(() => { flushSync(); flushActivity(); flushAch(); flushEquipPend(); }, 8000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePendLocal();
  else flushSync();
});
window.addEventListener("online", flushSync);

boot();
app.mount("#app");

// 底部导航栏（#app 之外，Vue 不管理）的 Lucide 图标手动渲染
if (window.lucide && window.lucide.icons) {
  document.querySelectorAll("#tabbar i[data-lucide]").forEach((el) => setIcon(el, el.getAttribute("data-lucide")));
}

// ================= 导航栏（移动端底栏 / PC 端顶栏，在 #app 之外） =================
const tabbar = document.getElementById("tabbar");
for (const b of tabbar.querySelectorAll("button[data-tab]")) {
  b.addEventListener("click", () => go(b.dataset.tab === "home" ? "#/" : "#/" + b.dataset.tab));
}
watch(
  () => [S.view, S.me],
  ([view, me]) => {
    tabbar.hidden = !(me && (view === "home" || view === "collections" || view === "me"));
    for (const b of tabbar.querySelectorAll("button[data-tab]")) b.classList.toggle("on", b.dataset.tab === view);
  },
);
