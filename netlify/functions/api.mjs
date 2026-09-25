import { getStore } from "@netlify/blobs";

const MAX_NAME = 24;
const MAX_ROOM = 40;
const MAX_ROOM_PASSWORD = 128;
const MIN_NEW_ROOM_PASSWORD = 12;
const MAX_MESSAGE = 500;
const MAX_MEMBERS = 50;
const ROOM_RESET_MS = 24 * 60 * 60 * 1000;
const ROOM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_TTL_MS = 5 * 60 * 1000;
const PRESENCE_MS = 15_000;
const MESSAGE_LIMIT = 100;
const CAS_RETRIES = 5;

const STORES = {
  rooms: "easy-second-chat-final-rooms-v1",
  members: "easy-second-chat-final-members-v1",
  messages: "easy-second-chat-final-messages-v1",
  directory: "easy-second-chat-final-directory-v1",
  health: "easy-second-chat-final-health-v1",
};

const PROFANITY = ["시발", "씨발", "ㅅㅂ", "병신", "ㅂㅅ", "개새끼", "좆", "존나", "fuck", "shit", "bitch", "asshole"];
const PROTECTED_NAMES = new Set(["admin", "administrator", "관리자", "운영자", "운영", "owner", "root", "system", "moderator", "mod"]);

function stores() {
  return {
    rooms: getStore({ name: STORES.rooms, consistency: "strong" }),
    members: getStore({ name: STORES.members, consistency: "strong" }),
    messages: getStore({ name: STORES.messages, consistency: "strong" }),
    directory: getStore({ name: STORES.directory, consistency: "strong" }),
    health: getStore({ name: STORES.health, consistency: "strong" }),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function clean(v, max) { return String(v ?? "").trim().slice(0, max); }
function canonicalRoom(v) { return clean(v, MAX_ROOM).normalize("NFKC").toLowerCase(); }
function badWord(s) { const x = String(s).toLowerCase(); return PROFANITY.some(w => x.includes(w.toLowerCase())); }
function protectedName(n) { return PROTECTED_NAMES.has(String(n).trim().toLowerCase()); }
function now() { return Date.now(); }
function timeNow() { return new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }

function b64(bytes) {
  let b = "";
  for (const x of bytes) b += String.fromCharCode(x);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(s) {
  const n = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const p = n + "=".repeat((4 - n.length % 4) % 4);
  return Uint8Array.from(atob(p), c => c.charCodeAt(0));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function digestSha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))));
}
async function shaKey(text) { return b64(await digestSha256(text)); }

async function hmac(text, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}
async function makeToken(payload, secret, ttl) {
  const nonce = new Uint8Array(18);
  crypto.getRandomValues(nonce);
  const exp = now() + ttl;
  const n = b64(nonce);
  const body = `${payload}.${exp}.${n}`;
  return `${exp}.${n}.${await hmac(body, secret)}`;
}
async function verifyToken(token, payload, secret) {
  if (!token || !secret) return false;
  const a = String(token).split(".");
  if (a.length !== 3) return false;
  const [exp, nonce, sig] = a;
  const expires = Number(exp);
  if (!Number.isFinite(expires) || now() >= expires) return false;
  return equal(sig, await hmac(`${payload}.${exp}.${nonce}`, secret));
}

async function derive(password, salt, iterations = 20_000) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256)));
}
async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return { alg: "PBKDF2-SHA256", iterations: 20_000, salt: b64(salt), hash: await derive(password, salt) };
}
async function verifyPassword(password, record) {
  try {
    if (!record || typeof record !== "object" || record.alg !== "PBKDF2-SHA256") return false;
    const salt = unb64(record.salt);
    const iterations = Number(record.iterations);
    if (salt.length < 16 || !Number.isInteger(iterations) || iterations < 1_000 || iterations > 2_000_000) return false;
    return equal(String(record.hash || ""), await derive(password, salt, iterations));
  } catch { return false; }
}
async function legacySha256(password) { return b64(await digestSha256(password)); }
async function verifyStoredPassword(password, stored) {
  if (stored && typeof stored === "object" && stored.alg === "PBKDF2-SHA256") return { ok: await verifyPassword(password, stored), upgrade: false };
  if (typeof stored === "string") return { ok: equal(stored, await legacySha256(password)), upgrade: true };
  if (stored && typeof stored === "object" && typeof stored.passwordHash === "string") return { ok: equal(stored.passwordHash, await legacySha256(password)), upgrade: true };
  return { ok: false, upgrade: false };
}

function roomId(room) { return `room:${room}`; }
async function roomKey(room) { return `room:${await shaKey(canonicalRoom(room))}`; }
async function memberKey(room, name) { return `${await roomKey(room)}/member/${await shaKey(String(name).trim())}`; }
async function messagePrefix(room) { return `${await roomKey(room)}/msg/`; }
async function messageKey(room, id) { return `${await messagePrefix(room)}${id}`; }
async function directoryKey(room) { return await shaKey(canonicalRoom(room)); }

function secret() { return String(process.env.ROOM_AUTH_SECRET || ""); }
function adminPassword() { return String(process.env.ADMIN_PASSWORD || ""); }

async function getRoom(store, room) {
  return await store.get(await roomKey(room), { type: "json", consistency: "strong" });
}
async function getRoomWithMeta(store, room) {
  const key = await roomKey(room);
  const [data, meta] = await Promise.all([
    store.get(key, { type: "json", consistency: "strong" }),
    store.getMetadata(key, { consistency: "strong" }),
  ]);
  return { key, data, etag: meta?.etag || null };
}
function validRoom(room, r) {
  return !!(
    r &&
    r.roomName &&
    canonicalRoom(r.roomName) === canonicalRoom(room) &&
    Number.isFinite(Number(r.createdAt)) &&
    Number(r.createdAt) + ROOM_RESET_MS > now() &&
    r.generation &&
    (r.password != null || r.passwordHash != null)
  );
}

async function directoryRegister(store, r) {
  await store.setJSON(await directoryKey(r.roomName), {
    name: r.roomName,
    createdAt: r.createdAt,
    expiresAt: r.createdAt + ROOM_RESET_MS,
  });
}
async function directoryDelete(store, room) { await store.delete(await directoryKey(room)); }

async function authenticateRoom(roomStore, room, roomToken) {
  const found = await getRoomWithMeta(roomStore, room);
  const r = found.data;
  if (!validRoom(room, r)) return null;
  if (!await verifyToken(roomToken, `${canonicalRoom(room)}.${r.generation}`, secret())) return null;
  return r;
}
async function authenticateAdmin(adminToken) {
  const s = secret();
  return !!(adminPassword() && s && await verifyToken(adminToken, "admin", s));
}

async function getRecentMessages(messageStore, room) {
  const prefix = await messagePrefix(room);
  const { blobs } = await messageStore.list({ prefix });
  const recent = blobs.slice(-MESSAGE_LIMIT);
  const out = [];
  for (const item of recent) {
    const data = await messageStore.get(item.key, { type: "json", consistency: "strong" });
    if (data) out.push(data);
  }
  out.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  return out.slice(-MESSAGE_LIMIT);
}

async function getMembers(memberStore, room) {
  const prefix = `${await roomKey(room)}/member/`;
  const { blobs } = await memberStore.list({ prefix });
  const cutoff = now() - PRESENCE_MS;
  const members = [];
  for (const item of blobs) {
    const data = await memberStore.get(item.key, { type: "json", consistency: "strong" });
    if (!data) continue;
    if (Number(data.lastSeen) < cutoff) {
      await memberStore.delete(item.key);
      continue;
    }
    members.push(data);
  }
  members.sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
  return members;
}

async function claimMember(memberStore, room, name) {
  const key = await memberKey(room, name);
  const current = await memberStore.get(key, { type: "json", consistency: "strong" });
  const stamp = now();
  if (current) {
    await memberStore.setJSON(key, { ...current, name, lastSeen: stamp });
    return true;
  }
  const { modified } = await memberStore.setJSON(key, { name, lastSeen: stamp }, { onlyIfNew: true });
  if (!modified) return true;

  const members = await getMembers(memberStore, room);
  if (members.length <= MAX_MEMBERS) return true;

  await memberStore.delete(key);
  return false;
}

async function leaveMember(memberStore, room, name) {
  await memberStore.delete(await memberKey(room, name));
}

async function createRoom(roomStore, directoryStore, room, password) {
  const key = await roomKey(room);
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const found = await getRoomWithMeta(roomStore, room);
    if (validRoom(room, found.data)) return { ok: false, status: 409, error: "이미 존재하는 방입니다. 방 들어가기를 이용하세요." };

    const createdAt = now();
    const r = { roomName: room, password: await hashPassword(password), createdAt, generation: crypto.randomUUID(), memberCount: 0 };

    let result;
    if (found.data && found.etag) {
      if (Number(found.data.createdAt) + ROOM_RESET_MS > now()) return { ok: false, status: 409, error: "이미 존재하는 방입니다. 방 들어가기를 이용하세요." };
      result = await roomStore.setJSON(key, r, { onlyIfMatch: found.etag });
    } else {
      result = await roomStore.setJSON(key, r, { onlyIfNew: true });
    }

    if (result.modified) {
      await directoryRegister(directoryStore, r);
      return { ok: true, room, createdAt, expiresAt: createdAt + ROOM_RESET_MS };
    }
  }
  return { ok: false, status: 409, error: "방 생성 중 다른 요청과 충돌했습니다. 잠시 후 다시 시도하세요." };
}

async function updateRoomCAS(roomStore, room, updater) {
  const key = await roomKey(room);
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const found = await getRoomWithMeta(roomStore, room);
    if (!found.data || !found.etag) return { ok: false, reason: "missing" };
    const next = await updater(structuredClone(found.data));
    const result = await roomStore.setJSON(key, next, { onlyIfMatch: found.etag });
    if (result.modified) return { ok: true, data: next };
  }
  return { ok: false, reason: "conflict" };
}

async function migrateLegacyIfPossible(roomStore, directoryStore, room) {
  // Final version intentionally does not read older stores. This avoids coupling
  // the live chat to legacy Blobs namespaces that may be inaccessible after SDK migrations.
  return null;
}

export default async (req, context) => {
  const s = stores();
  const u = new URL(req.url);
  const path = u.pathname.replace(/^\/api/, "") || "/";

  try {
    if (path === "/health" && req.method === "GET") {
      const key = `probe-${crypto.randomUUID()}`;
      await s.health.set(key, "ok", { onlyIfNew: true });
      const value = await s.health.get(key, { consistency: "strong" });
      await s.health.delete(key);
      return json({ ok: value === "ok", service: "easy-second-chat-netlify", version: 8, blobs: value === "ok" });
    }

    if (path === "/room-exists" && req.method === "GET") {
      const room = clean(u.searchParams.get("room"), MAX_ROOM);
      const r = await getRoom(s.rooms, room);
      return json({ ok: true, exists: validRoom(room, r) });
    }

    if (path === "/rooms" && req.method === "GET") {
      const q = canonicalRoom(u.searchParams.get("q") || "");
      const { blobs } = await s.directory.list();
      const rooms = [];
      for (const item of blobs.slice(-200)) {
        const d = await s.directory.get(item.key, { type: "json", consistency: "strong" });
        if (!d || Number(d.expiresAt) <= now()) {
          if (d) await s.directory.delete(item.key);
          continue;
        }
        if (!q || canonicalRoom(d.name).includes(q)) rooms.push({ name: d.name, expiresAt: d.expiresAt });
      }
      rooms.sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
      return json({ ok: true, rooms: rooms.slice(0, 50) });
    }

    if (path === "/room-create" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const room = clean(b.room, MAX_ROOM);
      const password = String(b.password || "");
      if (!room || !password) return json({ ok: false, error: "방 이름과 비밀번호가 필요합니다." }, 400);
      if (password.length < MIN_NEW_ROOM_PASSWORD || password.length > MAX_ROOM_PASSWORD) return json({ ok: false, error: `비밀번호는 ${MIN_NEW_ROOM_PASSWORD}~${MAX_ROOM_PASSWORD}자여야 합니다.` }, 400);
      if (!secret()) return json({ ok: false, error: "Netlify 환경변수 ROOM_AUTH_SECRET를 설정하세요." }, 503);
      const result = await createRoom(s.rooms, s.directory, room, password);
      return json(result.ok ? result : { ok: false, error: result.error }, result.ok ? 200 : result.status);
    }

    if (path === "/room-login" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const room = clean(b.room, MAX_ROOM);
      const password = String(b.password || "");
      if (!room || !password) return json({ ok: false, error: "방 이름과 비밀번호가 필요합니다." }, 400);
      const found = await getRoomWithMeta(s.rooms, room);
      const r = found.data;
      if (!r) return json({ ok: false, error: "존재하지 않는 방입니다." }, 404);
      if (!validRoom(room, r)) return json({ ok: false, error: "이 방은 만료되었습니다. 새 방을 만들어 주세요." }, 410);
      const check = await verifyStoredPassword(password, r.password ?? r.passwordHash);
      if (!check.ok) return json({ ok: false, error: "방 비밀번호가 올바르지 않습니다." }, 401);
      if (check.upgrade) {
        const upgraded = await updateRoomCAS(s.rooms, room, async next => { next.password = await hashPassword(password); delete next.passwordHash; return next; });
        if (!upgraded.ok) return json({ ok: false, error: "로그인 정보를 갱신하는 중 충돌이 발생했습니다. 다시 시도하세요." }, 409);
      }
      const latest = await getRoom(s.rooms, room);
      const rt = await makeToken(`${canonicalRoom(room)}.${latest.generation}`, secret(), ROOM_TOKEN_TTL_MS);
      return json({ ok: true, token: rt, expiresInMs: ROOM_TOKEN_TTL_MS });
    }

    if (path === "/admin-login" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (!adminPassword() || !secret()) return json({ ok: false, error: "관리자 환경변수가 설정되지 않았습니다." }, 503);
      if (!equal(String(b.password || ""), adminPassword())) return json({ ok: false, error: "관리자 비밀번호가 올바르지 않습니다." }, 401);
      return json({ ok: true, token: await makeToken("admin", secret(), ADMIN_TOKEN_TTL_MS), expiresInMs: ADMIN_TOKEN_TTL_MS });
    }

    if (path === "/state" && req.method === "GET") {
      const room = clean(u.searchParams.get("room"), MAX_ROOM);
      const name = clean(u.searchParams.get("name"), MAX_NAME);
      const rt = u.searchParams.get("roomToken") || "";
      const r = await authenticateRoom(s.rooms, room, rt);
      if (!r) return json({ ok: false, error: "방 인증이 만료되었습니다." }, 403);
      if (!name || badWord(name)) return json({ ok: false, error: "사용할 수 없는 닉네임입니다." }, 400);
      if (protectedName(name) && !await authenticateAdmin(u.searchParams.get("adminToken") || "")) return json({ ok: false, error: "관리자 인증이 필요합니다." }, 403);
      const memberOk = await claimMember(s.members, room, name);
      if (!memberOk) return json({ ok: false, error: "방 인원이 가득 찼습니다." }, 429);
      const [members, messages] = await Promise.all([getMembers(s.members, room), getRecentMessages(s.messages, room)]);
      return json({ ok: true, members: members.map(x => x.name), messages });
    }

    if (path === "/send" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const room = clean(b.room, MAX_ROOM);
      const name = clean(b.name, MAX_NAME);
      const text = clean(b.text, MAX_MESSAGE);
      const r = await authenticateRoom(s.rooms, room, b.roomToken || "");
      if (!r) return json({ ok: false, error: "방 인증이 만료되었습니다." }, 403);
      if (!name || !text) return json({ ok: false, error: "내용이 필요합니다." }, 400);
      if (badWord(name) || badWord(text)) return json({ ok: false, error: "부적절한 내용이 포함되어 있습니다." }, 400);
      if (protectedName(name) && !await authenticateAdmin(b.adminToken || "")) return json({ ok: false, error: "관리자 인증이 필요합니다." }, 403);
      const member = await s.members.get(await memberKey(room, name), { type: "json", consistency: "strong" });
      if (!member || now() - Number(member.lastSeen) >= PRESENCE_MS) return json({ ok: false, error: "채팅방에 다시 입장해 주세요." }, 403);
      const createdAt = now();
      const id = `${createdAt}-${crypto.randomUUID()}`;
      const message = { type: "message", id, name, text, time: timeNow(), createdAt };
      await s.messages.setJSON(await messageKey(room, id), message, { onlyIfNew: true });
      return json({ ok: true, message });
    }

    if (path === "/leave" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const room = clean(b.room, MAX_ROOM);
      const name = clean(b.name, MAX_NAME);
      const r = await authenticateRoom(s.rooms, room, b.roomToken || "");
      if (!r) return json({ ok: true });
      await leaveMember(s.members, room, name);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not Found" }, 404);
  } catch (e) {
    console.error("API_SERVER_ERROR", { path, name: e?.name, message: e?.message, stack: e?.stack });
    return json({ ok: false, error: "서버 내부 오류가 발생했습니다." }, 500);
  }
};
