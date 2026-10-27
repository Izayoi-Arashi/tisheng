// Tisheng · 自托管通用刷题系统 · Cloudflare Worker API
// 云备份题库存于 KV（ub:{uid}），答案永不下发，作答由本 Worker 判分；进度按用户隔离（p:{uid}）。
import { BANK_VERSION, QUESTIONS, MODULES } from "./bank.js";
import { CORRECTIONS } from "./bank-corrections.js";
import { applyCorrectionsSafe } from "./corrections.js";

const COOKIE_NAME = "ts_sid";
// 勾选「7天免密登录」：Cookie 与令牌 7 天有效；未勾选：令牌 24 小时、Cookie 随浏览器会话关闭即失效
const REMEMBER_TTL = 7 * 24 * 3600;
const SESSION_ONLY_TTL = 24 * 3600;
const PBKDF2_ITERATIONS = 100_000;
// 用户名敏感词表（naughty-words，MIT）：归一化后做包含匹配
import bannedZh from "./words/zh.json";
import bannedEn from "./words/en.json";
const BANNED_WORDS = new Set(
  [...bannedZh, ...bannedEn]
    .map((w) => w.toLowerCase().replace(/[\s._-]+/g, ""))
    .filter((w) => w.length >= 2)
);
function usernameError(name) {
  if (!/^[a-zA-Z0-9]{2,10}$/.test(name)) return "用户名需为 2-10 位字母或数字";
  const lower = name.toLowerCase().replace(/[\s._-]+/g, "");
  for (const w of BANNED_WORDS) if (lower.includes(w)) return "用户名包含不当词汇，请更换";
  return null;
}

// 掌握确认间隔：答对后需间隔此时长再次答对，题目才判定为「已斩」（m）
const DEFAULT_GAP_MS = 4 * 3600 * 1000;
const gapMs = (env) => {
  const v = parseInt(env && env.GAP_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_GAP_MS;
};
// 依据上一状态 + 距上次答对的时长，计算答对后的新状态（grade 与 progress 共用同一规则）
function stateAfterCorrect(prev, now, gap) {
  if (prev && (prev.s === "m" || (prev.s === "l" && now - prev.t >= gap))) return "m";
  return "l";
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...headers,
    },
  });
const err = (message, status = 400) => json({ error: message }, status);

const enc = new TextEncoder();

// 浏览器发出的状态变更请求必须来自同站；纯 API 客户端没有这些头时仍可通过
function sameOriginRequest(request, url) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? 4 - (str.length % 4) : 0;
  return Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad)), (c) => c.charCodeAt(0));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return bufToHex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBuf(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- Cloudflare Turnstile 人机验证 ----------
async function verifyTurnstile(env, token, ip) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token || typeof token !== "string" || token.length > 4096) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// ---------- 账号资料修改的失败冷却（每用户每项 2 次失败机会，用完锁 3 天） ----------
const FAIL_LIMIT = 2;
const FAIL_TTL = 3 * 86400;
async function failCount(kv, uid, kind) {
  return (await kv.get(`f:${uid}:${kind}`, "json"))?.n || 0;
}
async function bumpFail(kv, uid, kind) {
  const key = `f:${uid}:${kind}`;
  const n = ((await kv.get(key, "json"))?.n || 0) + 1;
  await kv.put(key, JSON.stringify({ n }), { expirationTtl: FAIL_TTL });
  return FAIL_LIMIT - n;
}
async function clearFail(kv, uid, kind) {
  await kv.delete(`f:${uid}:${kind}`);
}

// ---------- 头像内容审核（Workers AI 视觉模型，宽松阈值防误伤） ----------
async function moderateImage(env, bytes) {
  if (!env.AI) return { ok: false, reason: "头像审核服务未配置，暂时无法上传" };
  try {
    const res = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: Array.from(bytes),
      prompt:
        "Does this image contain pornographic, nude, sexually explicit, gory or extremely violent content? Answer with only Yes or No.",
      max_tokens: 8,
    });
    const text = String((res && res.description) || "").toLowerCase();
    if (text.includes("yes")) return { ok: false, reason: "图片包含不当内容，请更换头像" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "头像审核暂时不可用，请稍后再试" }; // 不因审核异常放行
  }
}

// ---------- 会话令牌（HMAC 签名，无状态） ----------
async function signToken(secret, payload) {
  const key = await hmacKey(secret);
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${sig}`;
}
async function verifyToken(secret, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const expect = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.u || !payload.n || payload.e < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
function sessionCookie(token, maxAge) {
  const ttlAttr = maxAge === 0 ? "; Max-Age=0" : maxAge > 0 ? `; Max-Age=${maxAge}` : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${ttlAttr}`;
}

// ---------- 限流（单隔离实例内存级，尽力而为） ----------
const buckets = new Map();
let lastSweep = 0;
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (now - lastSweep > 300_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  if (b.n >= limit) return false;
  b.n++;
  return true;
}

async function readJson(request) {
  try {
    const ct = request.headers.get("Content-Type") || "";
    if (!ct.includes("application/json")) return null;
    const text = await request.text();
    if (text.length > 1_000_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- 云备份题库（每用户单一云端槽位） ----------
// ub:{uid} = 云端题库（用户私有备份，含答案）；p:{uid} = 该题库的学习进度
// 首次访问自动把内置题库种子为该用户的云备份
const CLOUD_ID = "cloud";
const SEED_ID = "aca";
const SEED_NAME = "示例题库";
const ubCache = new Map(); // uid -> {t, bank}

// 历史种子题库的文本曾被截断，读取时按修复表补全：只补「现有文本是原文严格前缀」的条目，
// 答案/题号/分类不动（学习进度与判分不变）；用户自行导入的题库匹配不上前缀，一条也不会被改。
async function repairSeedText(kv, uid, bank) {
  const n = applyCorrectionsSafe(bank.questions, CORRECTIONS);
  if (n.q + n.o + n.x === 0) return bank;
  await kv.put(`ub:${uid}`, JSON.stringify(bank));
  console.log(`题库文本修复 ${uid}: 题干 ${n.q} / 选项 ${n.o} / 解析 ${n.x}`);
  return bank;
}
async function getCloudBank(kv, uid) {
  const c = ubCache.get(uid);
  if (c && Date.now() - c.t < 300_000) return c.bank;
  let bank = await kv.get(`ub:${uid}`, "json");
  if (!bank) {
    bank = { id: CLOUD_ID, name: SEED_NAME, v: BANK_VERSION, modules: MODULES, questions: QUESTIONS };
    await kv.put(`ub:${uid}`, JSON.stringify(bank));
  } else {
    bank = await repairSeedText(kv, uid, bank);
  }
  ubCache.set(uid, { t: Date.now(), bank });
  return bank;
}
async function putCloudBank(kv, uid, { name, modules, questions }, progress) {
  const prev = await kv.get(`ub:${uid}`, "json");
  const bank = { id: CLOUD_ID, name, modules, questions, v: ((prev && prev.v) || 0) + 1 };
  await kv.put(`ub:${uid}`, JSON.stringify(bank));
  ubCache.set(uid, { t: Date.now(), bank });
  if (progress) await kv.put(`p:${uid}`, JSON.stringify(progress));
  return bank;
}
// 题库导入校验：题目结构/唯一性/答案合法性；模块按分类字段归并
function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 50) return { error: "题库需至少 50 题" };
  const seen = new Set();
  const byCat = new Map();
  for (const q of questions) {
    if (!Number.isInteger(q.i) || q.i <= 0) return { error: `题目 id 非法: ${q.i}` };
    if (seen.has(q.i)) return { error: `题目 id 重复: ${q.i}` };
    seen.add(q.i);
    if (!q.q || !Array.isArray(q.o) || q.o.length < 2 || q.o.length > 8) return { error: `题目 ${q.i} 选项缺失或非法` };
    const keys = q.o.map((o) => o.k).join("");
    if (!q.a || [...q.a].some((ch) => !keys.includes(ch))) return { error: `题目 ${q.i} 答案不在选项中` };
    const cat = q.c || "未分类";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(q.i);
  }
  const modules = [...byCat.entries()].map(([name, qids]) => ({ name, qids }));
  return { modules };
}
// 题集只保存筛选规则，不保存题目；客户端删除用墓碑同步，避免多设备复活
function sanitizeFilterSets(input) {
  if (!Array.isArray(input) || input.length > 1000) return null;
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "");
    if (!/^f[a-z0-9]{1,36}$/.test(id)) continue;
    const f = raw.filters && typeof raw.filters === "object" ? raw.filters : {};
    const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? Math.floor(raw.createdAt) : Date.now();
    const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? Math.floor(raw.updatedAt) : createdAt;
    out.push({
      id,
      name: (String(raw.name || "题集").trim() || "题集").slice(0, 30),
      deleted: raw.deleted === true,
      filters: {
        search: String(f.search || "").slice(0, 80),
        status: ["all", "n", "l", "m"].includes(f.status) ? f.status : "all",
        kind: ["all", "single", "multi"].includes(f.kind) ? f.kind : "all",
      },
      createdAt,
      updatedAt,
    });
  }
  const now = Date.now();
  const live = out.filter((item) => !item.deleted || now - item.updatedAt < 90 * 86400_000);
  if (live.length > 200) return null;
  return live;
  return out;
}
async function getProgress(kv, uid) {
  const p = await kv.get(`p:${uid}`, "json");
  return p && p.q ? p : { q: {}, d: {} };
}

// ---------- 备份金库（AES-GCM 加密 + HMAC 指纹，防篡改双重保险，密钥不出服务端） ----------
async function backupKeys(secret) {
  const tec = new TextEncoder();
  const macRaw = await crypto.subtle.digest("SHA-256", tec.encode(secret + ":backup-mac"));
  const aesRaw = await crypto.subtle.digest("SHA-256", tec.encode(secret + ":backup-aes"));
  const macKey = await crypto.subtle.importKey("raw", macRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const aesKey = await crypto.subtle.importKey("raw", aesRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { macKey, aesKey };
}
function rawToB64(buf) {
  let s = "";
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}
function b64ToRaw(s) {
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad)), (c) => c.charCodeAt(0));
}
function hexToRaw(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return a;
}
async function openVault(secret, vault) {
  if (!vault || vault.fmt !== "tisheng-vault" || typeof vault.fp !== "string" || typeof vault.data !== "string") return { err: "备份文件格式不正确" };
  const { macKey, aesKey } = await backupKeys(secret);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", macKey, hexToRaw(vault.fp), new TextEncoder().encode(vault.data));
  } catch {}
  if (!ok) return { err: "指纹校验失败：备份已损坏或被篡改" };
  let payload;
  try {
    const [ivB64, ctB64] = vault.data.split(".");
    const iv = b64ToRaw(ivB64);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, b64ToRaw(ctB64));
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return { err: "备份解密失败，文件可能不完整" };
  }
  if (!payload || payload.type !== "tisheng-backup" || !payload.cloud || !payload.cloud.bank || !payload.cloud.progress) return { err: "备份内容不完整" };
  return { payload };
}
async function cloudFp(secret, bank, progress) {
  const { macKey } = await backupKeys(secret);
  const canon = new TextEncoder().encode(JSON.stringify({ n: bank.name, v: bank.v, qn: bank.questions.length, p: progress }));
  return bufToHex(await crypto.subtle.sign("HMAC", macKey, canon));
}
async function lastActive(progress) {
  let t = 0;
  for (const v of Object.values((progress && progress.q) || {})) if ((v.t || 0) > t) t = v.t;
  return t;
}
async function seedFromBackup(kv, uid, payload) {
  await kv.put(`ub:${uid}`, JSON.stringify(payload.cloud.bank));
  await kv.put(`p:${uid}`, JSON.stringify(payload.cloud.progress));
}

// ---------- 主体 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return err("Not Found", 404);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOriginRequest(request, url)) {
      return err("跨站请求已拒绝", 403);
    }

    const kv = env.ACA_QUIZ_KV;
    if (!kv) return err("KV 未绑定", 500);
    const secret = env.SESSION_SECRET;
    if (!secret) return err("SESSION_SECRET 未配置", 500);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    try {
      return await handle(request, { env, kv, secret, url, path, ip, ctx });
    } catch (e) {
      console.error("handler error:", e);
      return err("服务器内部错误", 500);
    }
  },

  // 每日定时清理闲置账号（Cloudflare Cron Triggers）
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cleanupIdleAccounts(env));
  },
};

// 连续 60 天无任何登录/活动记录的账号被删除；功能上线前就在库里的老记录
// 没有活跃时间戳，按创建时间判定并多给 30 天宽限（90 天）
async function cleanupIdleAccounts(env) {
  const kv = env.ACA_QUIZ_KV;
  if (!kv) return;
  const now = Date.now();
  const DAY = 86400_000;
  let cursor;
  let removed = 0;
  try {
    do {
      const page = await kv.list({ prefix: "u:", cursor });
      for (const key of page.keys) {
        try {
          const rec = await kv.get(key.name, "json");
          if (!rec) continue;
          const ref = rec.last || rec.c || 0;
          if (!ref || now - ref <= (rec.last ? 60 : 90) * DAY) continue;
          const uid = rec.uid;
          await kv.delete(key.name);
          if (uid) {
            await kv.delete(`p:${uid}`);
            await kv.delete(`ub:${uid}`);
            await kv.delete(`av:${uid}`);
            await kv.delete(`ach:${uid}`);
            await kv.delete(`eq:${uid}`);
            await kv.delete(`fs:${uid}`);
          }
          removed++;
        } catch {}
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    console.log(`[idle-cleanup] removed ${removed} account(s)`);
  } catch (e) {
    console.error("[idle-cleanup] failed:", e);
  }
}

async function handle(request, { env, kv, secret, url, path, ip, ctx }) {
  const method = request.method;

  if (path === "/api/ping" && method === "GET") return json({ ok: 1, t: Date.now() });

  if (path === "/api/config" && method === "GET") {
    return json({ ok: 1, tsSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  if (path === "/api/register" && method === "POST") {
    if (!rateLimit(`reg:${ip}`, 5, 15 * 60_000)) return err("尝试过于频繁，请稍后再试", 429);
    const invite = env.INVITE_CODE;
    if (!invite) return err("注册已关闭", 403);
    const body = await readJson(request);
    if (!body) return err("请求格式错误");
    if (!(await verifyTurnstile(env, body.tsToken, ip))) return err("人机验证未通过，请重试", 403);
    const { username, password, invite: given } = body;
    if (typeof username !== "string") return err("用户名需为 2-10 位字母或数字");
    const uErr = usernameError(username);
    if (uErr) return err(uErr);
    if (typeof password !== "string" || password.length < 6 || password.length > 72) return err("密码长度需为 6-72 位");
    if (typeof given !== "string" || !timingSafeEqual(given.trim(), invite)) return err("邀请码错误", 403);
    const ukey = `u:${username.toLowerCase()}`;
    if (await kv.get(ukey)) return err("用户名已被占用", 409);
    const uid = crypto.randomUUID().replace(/-/g, "");
    const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, salt);
    await kv.put(ukey, JSON.stringify({ uid, salt, hash, c: Date.now(), last: Date.now() }));
    const ttl = body.remember === true ? REMEMBER_TTL : SESSION_ONLY_TTL;
    const token = await signToken(secret, { u: uid, n: username, e: Math.floor(Date.now() / 1000) + ttl });
    return json({ ok: 1, username }, 200, { "Set-Cookie": sessionCookie(token, body.remember === true ? ttl : null) });
  }

  if (path === "/api/login" && method === "POST") {
    if (!rateLimit(`login:${ip}`, 10, 15 * 60_000)) return err("尝试过于频繁，请稍后再试", 429);
    const body = await readJson(request);
    if (!body) return err("请求格式错误");
    if (!(await verifyTurnstile(env, body.tsToken, ip))) return err("人机验证未通过，请重试", 403);
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string") return err("用户名或密码错误", 401);
    const rec = await kv.get(`u:${username.toLowerCase()}`, "json");
    if (!rec) return err("用户名或密码错误", 401);
    const hash = await hashPassword(password, rec.salt);
    if (!timingSafeEqual(hash, rec.hash)) return err("用户名或密码错误", 401);
    rec.last = Date.now(); // 活跃时间戳，供闲置账号清理判定
    await kv.put(`u:${username.toLowerCase()}`, JSON.stringify(rec));
    const ttl = body.remember === true ? REMEMBER_TTL : SESSION_ONLY_TTL;
    const token = await signToken(secret, { u: rec.uid, n: username, e: Math.floor(Date.now() / 1000) + ttl, v: rec.sv || 0 });
    return json({ ok: 1, username }, 200, { "Set-Cookie": sessionCookie(token, body.remember === true ? ttl : null) });
  }

  // ---- 备份导入：登录页恢复账号（未登录） / 账号页覆盖数据（已登录） ----
  if (path === "/api/import" && method === "POST") {
    const cm = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    const sess = cm ? await verifyToken(secret, cm[1]) : null;
    let meUid = null, meName = null;
    if (sess) {
      const ar = await kv.get(`u:${sess.n.toLowerCase()}`, "json");
      if (ar && (ar.sv || 0) === (sess.v || 0)) { meUid = sess.u; meName = sess.n; }
    }
    if (!meUid && !rateLimit(`imp:${ip}`, 10, 15 * 60_000)) return err("操作过于频繁，请稍后再试", 429);
    const body = await readJson(request);
    if (!body || !body.vault) return err("请求格式错误");
    const opened = await openVault(secret, body.vault);
    if (opened.err) return err(opened.err);
    const payload = opened.payload;
    const mode = body.mode || "check";

    // 已登录：校验备份并返回摘要，确认后整体覆盖当前账号云端与本机数据
    if (meUid) {
      if (mode === "check") {
        const curBank = await getCloudBank(kv, meUid);
        const curProg = await getProgress(kv, meUid);
        const sameData = (await cloudFp(secret, curBank, curProg)) === (await cloudFp(secret, payload.cloud.bank, payload.cloud.progress));
        return json({ ok: 1, action: "apply", backupName: payload.username, meName, exportedAt: payload.exportedAt, cloudAt: await lastActive(curProg), sameData });
      }
      if (mode === "apply") {
        if (!rateLimit(`impa:${meUid}`, 5, 3600_000)) return err("导入过于频繁，请稍候", 429);
        await seedFromBackup(kv, meUid, payload);
        ubCache.delete(meUid);
        return json({ ok: 1, local: payload.local || { banks: [], progress: [] }, username: meName });
      }
      return err("已登录状态不支持该导入方式");
    }

    // 未登录：以备份恢复账号
    const bu = String(payload.username || "").toLowerCase();
    const rec = await kv.get(`u:${bu}`, "json");
    if (mode === "check") {
      if (!rec) return json({ ok: 1, action: "create", username: payload.username, exportedAt: payload.exportedAt });
      const curBank = await getCloudBank(kv, rec.uid);
      const curProg = await getProgress(kv, rec.uid);
      const sameData = (await cloudFp(secret, curBank, curProg)) === (await cloudFp(secret, payload.cloud.bank, payload.cloud.progress));
      return json({ ok: 1, action: sameData ? "same" : "conflict", username: payload.username, exportedAt: payload.exportedAt, cloudAt: await lastActive(curProg) });
    }
    if (!rateLimit(`impw:${ip}`, 10, 15 * 60_000)) return err("操作过于频繁，请稍后再试", 429);

    if (mode === "login" || mode === "overwrite") {
      // 同一份数据：验密后登录；overwrite 额外用备份覆盖云端
      if (!rec) return err("账号不存在", 401);
      if (typeof body.password !== "string" || body.password.length < 6) return err("请输入密码（至少 6 位）");
      const hash = await hashPassword(body.password, rec.salt);
      if (!timingSafeEqual(hash, rec.hash)) return err("密码错误", 401);
      if (mode === "overwrite") await seedFromBackup(kv, rec.uid, payload);
      const ttl = REMEMBER_TTL;
      const token = await signToken(secret, { u: rec.uid, n: payload.username, e: Math.floor(Date.now() / 1000) + ttl, v: rec.sv || 0 });
      return json({ ok: 1, username: payload.username, local: payload.local || { banks: [], progress: [] } }, 200, { "Set-Cookie": sessionCookie(token, ttl) });
    }

    if (mode === "create") {
      // 无同名账号：直接以备份用户名建号；云端已有同名且数据不同 → 强制改名后建号
      const finalName = String(body.rename || payload.username || "").trim();
      const uErr = usernameError(finalName);
      if (uErr) return err(uErr);
      if (await kv.get(`u:${finalName.toLowerCase()}`)) return err("该用户名已被占用，请重新设置", 409);
      if (typeof body.password !== "string" || body.password.length < 6 || body.password.length > 72) return err("请设置密码（6-72 位）");
      const uid = crypto.randomUUID().replace(/-/g, "");
      const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await hashPassword(body.password, salt);
      await kv.put(`u:${finalName.toLowerCase()}`, JSON.stringify({ uid, salt, hash, c: Date.now(), last: Date.now() }));
      await seedFromBackup(kv, uid, payload);
      const token = await signToken(secret, { u: uid, n: finalName, e: Math.floor(Date.now() / 1000) + REMEMBER_TTL });
      return json({ ok: 1, username: finalName, local: payload.local || { banks: [], progress: [] } }, 200, { "Set-Cookie": sessionCookie(token, REMEMBER_TTL) });
    }

    return err("未知导入方式");
  }

  // ---- 以下接口均需登录 ----
  const authCookie = request.headers.get("Cookie") || "";
  const m = authCookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const session = m ? await verifyToken(secret, m[1]) : null;
  if (!session) return err("请先登录", 401);
  const { u: uid, n: username } = session;
  const accRec = await kv.get(`u:${username.toLowerCase()}`, "json");
  if (!accRec || (accRec.sv || 0) !== (session.v || 0)) return err("登录已失效，请重新登录", 401);
  // 活跃时间戳（每用户每天最多落一次盘），供闲置账号清理判定
  if (!accRec.last || Date.now() - accRec.last > 86400_000) {
    accRec.last = Date.now();
    const recStr = JSON.stringify(accRec);
    if (ctx && ctx.waitUntil) ctx.waitUntil(kv.put(`u:${username.toLowerCase()}`, recStr));
    else kv.put(`u:${username.toLowerCase()}`, recStr).catch(() => {});
  }

  if (path === "/api/me" && method === "GET") {
    return json({ ok: 1, username, uid });
  }

  // ---- 备份导出（已登录）：云端 + 本机数据打包为加密金库文件 ----
  if (path === "/api/export" && method === "POST") {
    if (!rateLimit(`exp:${uid}`, 5, 3600_000)) return err("导出过于频繁，请稍候", 429);
    const body = await readJson(request);
    const bank = await getCloudBank(kv, uid);
    const progress = await getProgress(kv, uid);
    const payload = {
      type: "tisheng-backup",
      v: 2,
      username,
      exportedAt: new Date().toISOString(),
      cloud: { bank, progress },
      local: body && body.local ? body.local : { banks: [], progress: [] },
    };
    const { macKey, aesKey } = await backupKeys(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(JSON.stringify(payload)));
    const data = rawToB64(iv) + "." + rawToB64(ct);
    const fp = bufToHex(await crypto.subtle.sign("HMAC", macKey, new TextEncoder().encode(data)));
    return json({ ok: 1, vault: { fmt: "tisheng-vault", v: 1, fp, data }, cloudAt: await lastActive(progress) });
  }

  if (path === "/api/avatar" && method === "GET") {
    // ?u=<uid> 供排行榜展示他人头像（uid 为 32 位随机 hex，不可枚举）
    let target = uid;
    const qu = url.searchParams.get("u");
    if (qu && /^[a-f0-9]{32}$/.test(qu)) target = qu;
    const av = await kv.get(`av:${target}`, "json");
    if (!av || !av.d) return err("无头像", 404);
    return json({ ok: 1, t: av.t, d: av.d });
  }

  if (path === "/api/avatar" && method === "DELETE") {
    // 恢复默认头像：清除自定义头像
    if (!rateLimit(`av:${uid}`, 10, 3600_000)) return err("操作过于频繁，请稍后再试", 429);
    await kv.delete(`av:${uid}`);
    return json({ ok: 1 });
  }

  if (path === "/api/avatar" && method === "POST") {
    if (!rateLimit(`av:${uid}`, 10, 3600_000)) return err("操作过于频繁，请稍后再试", 429);
    const body = await readJson(request);
    if (!body || typeof body.d !== "string" || body.t !== "image/webp") return err("仅支持 WebP 图片");
    let bytes;
    try { bytes = Uint8Array.from(atob(body.d), (c) => c.charCodeAt(0)); } catch { return err("图片数据无效"); }
    if (!bytes.length || bytes.length > 60_000) return err("图片压缩后仍过大，请换一张");
    const isWebp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!isWebp) return err("图片数据无效");
    const mod = await moderateImage(env, bytes);
    if (!mod.ok) return err(mod.reason, 400);
    await kv.put(`av:${uid}`, JSON.stringify({ t: body.t, d: body.d }));
    return json({ ok: 1 });
  }

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: 1 }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  // ---- 云备份题库 ----
  if (path === "/api/mybank" && method === "GET") {
    const bank = await getCloudBank(kv, uid);
    const progress = await getProgress(kv, uid);
    if (url.searchParams.get("full") === "1") {
      // 备份导出：含答案的完整题库（用户自己的数据）
      return json({ ok: 1, bank, progress });
    }
    return json({
      ok: 1,
      bank: { id: bank.id, name: bank.name, v: bank.v, modules: bank.modules },
      questions: bank.questions.map((q) => ({ i: q.i, q: q.q, o: q.o, c: q.c || "未分类", m: q.a.length > 1 ? 1 : 0 })),
      progress,
    });
  }

  if (path === "/api/mybank" && method === "PUT") {
    const body = await readJson(request);
    if (!body || !body.bank) return err("请求格式错误");
    const name = String(body.bank.name ?? "").trim().slice(0, 30);
    if (!name) return err("请填写题库名称");
    const v = validateQuestions(body.bank.questions);
    if (v.error) return err(v.error);
    const bank = await putCloudBank(kv, uid, { name, modules: v.modules, questions: body.bank.questions }, body.progress);
    return json({ ok: 1, v: bank.v });
  }

  if (path === "/api/mybank" && method === "DELETE") {
    // 删除云备份：清空题库与进度；下次访问会自动恢复内置示例题库（空进度）
    await kv.delete(`ub:${uid}`);
    await kv.put(`p:${uid}`, JSON.stringify({ q: {}, d: {} }));
    ubCache.delete(uid);
    return json({ ok: 1 });
  }

  if (path === "/api/grade" && method === "POST") {
    if (!rateLimit(`grade:${uid}`, 300, 60_000)) return err("作答频率超限，请稍候", 429);
    const body = await readJson(request);
    if (!body) return err("请求格式错误");
    const bank = await getCloudBank(kv, uid);
    const q = bank.questions.find((x) => x.i === parseInt(body.i, 10));
    if (!q) return err("题目不存在", 404);
    const sel = typeof body.sel === "string" ? [...body.sel.toUpperCase()].sort().join("") : "";
    const answer = [...q.a].sort().join("");
    const correct = sel === answer && sel.length > 0;
    const prev = (await getProgress(kv, uid)).q[q.i];
    const st = correct ? stateAfterCorrect(prev, Date.now(), gapMs(env)) : "w";
    return json({ ok: 1, correct, a: q.a, x: q.x || null, st });
  }

  if (path === "/api/progress" && method === "GET") {
    const p = await getProgress(kv, uid);
    return json({ ok: 1, p });
  }

  if (path === "/api/progress" && method === "POST") {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.d) || body.d.length === 0) return err("请求格式错误");
    if (body.d.length > 500) return err("单次同步过多", 413);
    if (!rateLimit(`prog:${uid}`, 60, 60_000)) return err("同步过于频繁", 429);
    const p = await getProgress(kv, uid);
    const now = Date.now();
    const gap = gapMs(env);
    for (const d of body.d) {
      const qi = parseInt(d.i, 10);
      if (!Number.isInteger(qi) || (d.r !== 0 && d.r !== 1)) continue;
      if (d.r) {
        const prevW = !!(p.q[qi] && p.q[qi].s === "w");
        const confirmed = p.q[qi] && (p.q[qi].s === "m" || (p.q[qi].s === "l" && now - p.q[qi].t >= gap));
        p.q[qi] = { s: confirmed ? "m" : "l", t: now };
        const day = typeof d.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? d.day : null;
        if (day) p.d[day] = (p.d[day] || 0) + 1;
        if (prevW) p.wf = (p.wf || 0) + 1; // 攻克一道此前答错的题（扫地僧成就口径）
      } else {
        p.q[qi] = { s: "w", t: now };
      }
    }
    const dayKeys = Object.keys(p.d).sort();
    while (dayKeys.length > 90) delete p.d[dayKeys.shift()];
    await kv.put(`p:${uid}`, JSON.stringify(p));
    return json({ ok: 1 });
  }

  // ---- 动态题集规则（不含题目内容，仅保存筛选视图） ----
  if (path === "/api/collections" && method === "GET") {
    const sets = (await kv.get(`fs:${uid}`, "json")) || [];
    return json({ ok: 1, sets });
  }
  if (path === "/api/collections" && method === "PUT") {
    if (!rateLimit(`fs:${uid}`, 30, 60_000)) return err("同步过于频繁，请稍后再试", 429);
    const body = await readJson(request);
    const sets = body && sanitizeFilterSets(body.sets);
    if (!sets) return err("题集数据格式错误", 400);
    await kv.put(`fs:${uid}`, JSON.stringify(sets));
    return json({ ok: 1, count: sets.length });
  }

  // ---- 排行榜：每日答题量（含本地题库，仅数量不含题目内容） ----
  // lb:{day} = { [uid]: { n: 当日答题数, name: 昵称快照 } }，40 天 TTL 自动过期
  // init:true 为登录时的全量校准——按较大值落库（幂等，多设备重复上报不会翻倍）
  if (path === "/api/activity" && method === "POST") {
    if (!rateLimit(`act:${uid}`, 30, 60_000)) return err("上报过于频繁，请稍候", 429);
    const body = await readJson(request);
    if (!body || !body.d || typeof body.d !== "object" || Array.isArray(body.d)) return err("请求格式错误");
    const init = body.init === true;
    // 佩戴徽章随活动上报戳进日榜记录，排行榜行直接展示（无需额外读取）
    const eq = Array.isArray(body.eq)
      ? [...new Set(body.eq)].filter((id) => typeof id === "string" && /^[a-z0-9_]{2,32}$/.test(id)).slice(0, 3)
      : null;
    const entries = Object.entries(body.d).slice(0, 25);
    let applied = 0;
    for (const [day, n] of entries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(n) || n <= 0 || n > 9999) continue;
      const key = `lb:${day}`;
      const cur = (await kv.get(key, "json")) || {};
      const rec = cur[uid] || { n: 0, name: username };
      rec.n = init ? Math.max(rec.n, n) : rec.n + n;
      rec.name = username; // 改名后随下次上报刷新
      if (eq) rec.eq = eq;
      cur[uid] = rec;
      await kv.put(key, JSON.stringify(cur), { expirationTtl: 40 * 86400 });
      applied++;
    }
    return json({ ok: 1, applied });
  }

  // ---- 成就（客户端判定，解锁记录云同步；ach:{uid} = { 成就id: 解锁时间戳 }） ----
    if (path === "/api/ach" && method === "GET") {
      const ach = (await kv.get(`ach:${uid}`, "json")) || {};
      const eq = (await kv.get(`eq:${uid}`, "json")) || [];
      return json({ ok: 1, ach, eq });
    }

  if (path === "/api/ach" && method === "PUT") {
    if (!rateLimit(`achw:${uid}`, 20, 60_000)) return err("操作过于频繁，请稍候", 429);
    const body = await readJson(request);
    if (!body || !body.add || typeof body.add !== "object" || Array.isArray(body.add)) return err("请求格式错误");
    const cur = (await kv.get(`ach:${uid}`, "json")) || {};
    for (const [id, ts] of Object.entries(body.add).slice(0, 50)) {
      if (!/^[a-z0-9_]{2,32}$/.test(id) || cur[id]) continue; // 幂等：已解锁的保留原记录
      cur[id] = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : Date.now();
    }
    await kv.put(`ach:${uid}`, JSON.stringify(cur));
    return json({ ok: 1, ach: cur, eq: (await kv.get(`eq:${uid}`, "json")) || [] });
  }

  // ---- 徽章佩戴（最多 3 枚，须为已解锁成就） ----
  if (path === "/api/equip" && method === "GET") {
    let target = uid;
    const qu = url.searchParams.get("u");
    if (qu && /^[a-f0-9]{32}$/.test(qu)) target = qu; // 排行榜展示他人佩戴
    const eq = (await kv.get(`eq:${target}`, "json")) || [];
    return json({ ok: 1, eq });
  }

  if (path === "/api/equip" && method === "PUT") {
    if (!rateLimit(`eq:${uid}`, 20, 60_000)) return err("操作过于频繁，请稍候", 429);
    const body = await readJson(request);
    if (!body || !Array.isArray(body.eq) || body.eq.length > 3) return err("最多佩戴 3 枚徽章");
    const ach = (await kv.get(`ach:${uid}`, "json")) || {};
    const eq = [...new Set(body.eq)].filter((id) => /^[a-z0-9_]{2,32}$/.test(id) && ach[id]).slice(0, 3);
    await kv.put(`eq:${uid}`, JSON.stringify(eq));
    return json({ ok: 1, eq });
  }

  if (path === "/api/leaderboard" && method === "GET") {
    if (!rateLimit(`lb:${uid}`, 30, 60_000)) return err("请求过于频繁，请稍候", 429);
    const period = url.searchParams.get("period") || "day";
    const span = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 0;
    if (!span) return err("参数错误", 400);
    // 以 UTC+8 计算日期串，与客户端打卡日期一致
    const cnToday = new Date(Date.now() + 8 * 3600_000);
    const totals = new Map();
    for (let i = 0; i < span; i++) {
      const day = new Date(cnToday.getTime() - i * 86400_000).toISOString().slice(0, 10);
      const m = (await kv.get(`lb:${day}`, "json")) || {};
      for (const [id, rec] of Object.entries(m)) {
        const t = totals.get(id) || { n: 0, name: rec.name, eq: rec.eq || [] };
        t.n += rec.n;
        if (rec.name) t.name = rec.name;
        if (rec.eq && rec.eq.length) t.eq = rec.eq;
        totals.set(id, t);
      }
    }
    const list = [...totals.entries()]
      .map(([id, t]) => ({ uid: id, name: t.name, n: t.n, eq: t.eq || [] }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 20);
    return json({ ok: 1, list, me: uid });
  }

  if (path === "/api/reset" && method === "POST") {
    await kv.put(`p:${uid}`, JSON.stringify({ q: {}, d: {} }));
    return json({ ok: 1 });
  }

  // ---- 账号资料修改（均需验证 + 失败冷却） ----
  if (path === "/api/change-password" && method === "POST") {
    const body = await readJson(request);
    if (!body) return err("请求格式错误");
    if ((await failCount(kv, uid, "pw")) >= FAIL_LIMIT) return err("失败次数过多，修改密码已锁定 3 天", 403);
    if (!(await verifyTurnstile(env, body.tsToken, ip))) return err("人机验证未通过，请重试", 403);
    const oldHash = await hashPassword(String(body.oldPassword ?? ""), accRec.salt);
    if (!timingSafeEqual(oldHash, accRec.hash)) {
      const left = await bumpFail(kv, uid, "pw");
      return err(left > 0 ? `原密码错误，还可尝试 ${left} 次` : "失败次数过多，修改密码已锁定 3 天", 403);
    }
    const np = String(body.newPassword ?? "");
    if (np.length < 6 || np.length > 72) return err("新密码长度需为 6-72 位");
    accRec.salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    accRec.hash = await hashPassword(np, accRec.salt);
    accRec.sv = (accRec.sv || 0) + 1;
    await kv.put(`u:${username.toLowerCase()}`, JSON.stringify(accRec));
    clearFail(kv, uid, "pw");
    const token = await signToken(secret, { u: uid, n: username, e: Math.floor(Date.now() / 1000) + REMEMBER_TTL, v: accRec.sv });
    return json({ ok: 1 }, 200, { "Set-Cookie": sessionCookie(token, REMEMBER_TTL) });
  }

  if (path === "/api/change-username" && method === "POST") {
    const body = await readJson(request);
    if (!body) return err("请求格式错误");
    if ((await failCount(kv, uid, "un")) >= FAIL_LIMIT) return err("失败次数过多，修改用户名已锁定 3 天", 403);
    if (!(await verifyTurnstile(env, body.tsToken, ip))) return err("人机验证未通过，请重试", 403);
    const nu = String(body.newUsername ?? "").trim();
    if (nu.toLowerCase() === username.toLowerCase()) return err("新用户名与当前用户名相同");
    const uErr = usernameError(nu);
    if (uErr) return err(uErr);
    if (await kv.get(`u:${nu.toLowerCase()}`)) return err("新用户名已被占用", 409);
    const oldHash = await hashPassword(String(body.password ?? ""), accRec.salt);
    if (!timingSafeEqual(oldHash, accRec.hash)) {
      const left = await bumpFail(kv, uid, "un");
      return err(left > 0 ? `密码错误，还可尝试 ${left} 次` : "失败次数过多，修改用户名已锁定 3 天", 403);
    }
    accRec.sv = (accRec.sv || 0) + 1;
    await kv.put(`u:${nu.toLowerCase()}`, JSON.stringify(accRec));
    await kv.delete(`u:${username.toLowerCase()}`);
    clearFail(kv, uid, "un");
    const token = await signToken(secret, { u: uid, n: nu, e: Math.floor(Date.now() / 1000) + REMEMBER_TTL, v: accRec.sv });
    return json({ ok: 1, username: nu }, 200, { "Set-Cookie": sessionCookie(token, REMEMBER_TTL) });
  }

  if (path === "/api/delete-account" && method === "POST") {
    if (!rateLimit(`delacc:${uid}`, 3, 3600_000)) return err("操作过于频繁，请稍后再试", 429);
    // 删除全部题库的学习进度 + 账号记录
    const list = await kv.list({ prefix: `p:${uid}` });
    for (const k of list.keys) await kv.delete(k.name);
    await kv.delete(`ub:${uid}`);
    await kv.delete(`av:${uid}`);
    await kv.delete(`ach:${uid}`);
    await kv.delete(`eq:${uid}`);
    await kv.delete(`fs:${uid}`);
    await kv.delete(`u:${username.toLowerCase()}`);
    return json({ ok: 1 }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  return err("Not Found", 404);
}
