import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 24;
const MAX_ROOM = 40;
const MAX_ROOM_PASSWORD = 128;
const MIN_NEW_ROOM_PASSWORD = 12;
const ROOM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const ROOM_RESET_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_ROOM_ID = "__easy_second_chat_room_directory__";
const MAX_MESSAGE = 500;
const MAX_MEMBERS = 50;
const RATE_WINDOW_MS = 5000;
const MAX_MESSAGES_PER_WINDOW = 15;

// 관리자 토큰 유효시간. 비밀번호 자체는 WebSocket URL로 보내지 않습니다.
const ADMIN_TOKEN_TTL_MS = 5 * 60 * 1000;

// 비밀번호 저장용 PBKDF2 설정. SHA-256 단독 해시는 빠른 추측 공격에 취약하므로
// 새 방은 느린 PBKDF2-HMAC-SHA256으로 저장하고, 기존 방은 성공 로그인 시 자동 업그레이드합니다.
const PASSWORD_KDF_ITERATIONS = 600000;
const PASSWORD_SALT_BYTES = 16;

// 로그인 무차별 대입 방지. IP별로 Worker 앞단에서 제한하고, 방 DO에서도 추가 제한합니다.
const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 5;
const ROOM_AUTH_FAIL_WINDOW_MS = 5 * 60 * 1000;
const ROOM_AUTH_FAIL_MAX = 12;

const PROFANITY = [
  "시발", "씨발", "ㅅㅂ", "병신", "ㅂㅅ", "개새끼",
  "좆", "존나", "fuck", "shit", "bitch", "asshole"
];

// 관리자/운영자 계열 보호 닉네임.
const PROTECTED_NAMES = new Set([
  "admin", "administrator", "관리자", "운영자", "운영", "owner",
  "root", "system", "moderator", "mod"
]);

function isProtectedName(name) {
  return PROTECTED_NAMES.has(String(name).trim().toLowerCase());
}

function passwordMatches(provided, env) {
  return Boolean(env.ADMIN_PASSWORD) &&
    safeEqual(String(provided ?? ""), String(env.ADMIN_PASSWORD));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...securityHeaders()
    }
  });
}

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...extra
  };
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function containsProfanity(text) {
  const lower = text.toLowerCase();
  return PROFANITY.some(word => lower.includes(word.toLowerCase()));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function hmacSign(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text)
  );

  return bytesToBase64Url(new Uint8Array(signature));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function createAdminToken(env) {
  if (!env.ADMIN_PASSWORD) return null;

  const exp = Date.now() + ADMIN_TOKEN_TTL_MS;
  const nonceBytes = new Uint8Array(18);
  crypto.getRandomValues(nonceBytes);

  const payload = `${exp}.${bytesToBase64Url(nonceBytes)}`;
  const signature = await hmacSign(payload, env.ADMIN_PASSWORD);

  return `${payload}.${signature}`;
}

async function verifyAdminToken(token, env) {
  if (!env.ADMIN_PASSWORD || !token) return false;

  const parts = String(token).split(".");
  if (parts.length !== 3) return false;

  const [expText, nonce, signature] = parts;
  const exp = Number(expText);

  if (!Number.isFinite(exp) || !nonce || !signature) return false;
  if (Date.now() >= exp) return false;

  const payload = `${expText}.${nonce}`;
  const expected = await hmacSign(payload, env.ADMIN_PASSWORD);

  return safeEqual(signature, expected);
}

async function deriveRoomPassword(password, saltBytes, iterations = PASSWORD_KDF_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256"
    },
    key,
    256
  );

  return bytesToBase64Url(new Uint8Array(bits));
}

async function hashRoomPassword(password) {
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await deriveRoomPassword(password, salt);
  return {
    v: 2,
    alg: "PBKDF2-SHA256",
    iterations: PASSWORD_KDF_ITERATIONS,
    salt: bytesToBase64Url(salt),
    hash
  };
}

async function verifyRoomPassword(password, record) {
  if (!record || typeof record !== "object") return false;
  if (record.alg !== "PBKDF2-SHA256") return false;

  try {
    const salt = base64UrlToBytes(record.salt);
    const iterations = Number(record.iterations);
    if (salt.length < 16 || !Number.isInteger(iterations) || iterations < 100000 || iterations > 2000000) {
      return false;
    }
    const derived = await deriveRoomPassword(password, salt, iterations);
    return safeEqual(String(record.hash || ""), derived);
  } catch {
    return false;
  }
}

async function legacyHashRoomPassword(password) {
  const data = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(password))
  );
  return bytesToBase64Url(new Uint8Array(data));
}

function getRoomAuthSecret(env) {
  // ROOM_AUTH_SECRET를 우선 사용합니다.
  // Cloudflare에 이 Secret이 아직 연결되지 않은 경우에는
  // 기존 관리자 인증에 이미 사용 중인 ADMIN_PASSWORD를 서명용 비밀키로 사용합니다.
  return String(env.ROOM_AUTH_SECRET || env.ADMIN_PASSWORD || "");
}

async function createRoomToken(room, generation, env) {
  const secret = getRoomAuthSecret(env);
  if (!secret) return null;

  const exp = Date.now() + ROOM_TOKEN_TTL_MS;
  const nonceBytes = new Uint8Array(18);
  crypto.getRandomValues(nonceBytes);

  const payload = `${room}.${generation}.${exp}.${bytesToBase64Url(nonceBytes)}`;
  const signature = await hmacSign(payload, secret);

  return `${exp}.${bytesToBase64Url(nonceBytes)}.${signature}`;
}

async function verifyRoomToken(token, room, generation, env) {
  const secret = getRoomAuthSecret(env);
  if (!secret || !token || !generation) return false;

  const parts = String(token).split(".");
  if (parts.length !== 3) return false;

  const [expText, nonce, signature] = parts;
  const exp = Number(expText);

  if (!Number.isFinite(exp) || !nonce || !signature) return false;
  if (Date.now() >= exp) return false;

  const payload = `${room}.${generation}.${expText}.${nonce}`;
  const expected = await hmacSign(payload, secret);

  return safeEqual(signature, expected);
}

async function checkLoginRateLimit(env, request, kind) {
  const ip = clientIp(request);
  const id = env.CHAT_ROOM.idFromName(`__rate__:${kind}:${ip}`);
  const limiter = env.CHAT_ROOM.get(id);
  const r = await limiter.fetch(new Request("https://internal/rate-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      windowMs: LOGIN_RATE_WINDOW_MS,
      max: LOGIN_RATE_MAX_ATTEMPTS
    })
  }));
  const data = await r.json();
  return { ...data, ip };
}

async function clearLoginRateLimit(env, kind, ip) {
  const id = env.CHAT_ROOM.idFromName(`__rate__:${kind}:${ip}`);
  const limiter = env.CHAT_ROOM.get(id);
  await limiter.fetch(new Request("https://internal/rate-clear", { method: "POST" }));
}

function page() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EASY SECOND CHAT V2</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0f1218;color:#eef2f7;font-family:Arial,sans-serif}.wrap{max-width:1050px;margin:24px auto;padding:14px}.card{background:#181d26;border:1px solid #303847;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px #0006}header{padding:20px;border-bottom:1px solid #303847}h1{margin:0 0 5px}.sub{color:#9da8b8}.login{padding:24px;display:grid;gap:10px;max-width:700px}.roomSearch{margin-top:8px;padding-top:16px;border-top:1px solid #303847}.roomSearchRow{display:flex;gap:8px}.roomSearchRow input{flex:1}.roomList{margin-top:8px;display:grid;gap:6px;max-height:220px;overflow:auto}.roomItem{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 11px;background:#202735;border-radius:9px;color:#dbe3ee}.roomItem button{padding:7px 10px;background:#35445f}.empty{color:#8793a6}input,button{font:inherit;border-radius:10px;padding:12px;border:1px solid #3a4658}input{background:#0d1015;color:#fff}button{background:#4d7cff;color:#fff;border:0;cursor:pointer}.danger{background:#8d3c4a}#status{min-height:22px;color:#ffca79}#chat{display:none;grid-template-columns:220px 1fr;min-height:590px}aside{padding:18px;background:#131821;border-right:1px solid #303847}#members{line-height:1.9;color:#cbd3df}.online{color:#7ee0a1}.roomtag{margin:10px 0;padding:8px;border-radius:8px;background:#202735;color:#aeb9c9}main{display:flex;flex-direction:column;min-width:0}#messages{flex:1;overflow:auto;padding:18px;max-height:500px}.msg{padding:10px 12px;margin:8px 0;background:#222a38;border-radius:12px;overflow-wrap:anywhere}.msg b{color:#91b1ff}.msg small{color:#8793a6;margin-left:8px}.system{opacity:.7}.form{display:flex;gap:8px;padding:14px;border-top:1px solid #303847}.form input{flex:1;min-width:0}@media(max-width:680px){#chat{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #303847}}
</style>
</head>
<body><div class="wrap"><div class="card">
<header><h1>EASY SECOND CHAT V2 💬</h1><div class="sub">같은 방 이름과 비밀번호를 입력한 사람만 같은 방에 참여합니다.</div></header>
<section id="login" class="login">
<input id="name" maxlength="24" placeholder="닉네임" oninput="checkProtectedName()">
<div id="adminBox" style="display:none">
  <input id="adminPassword" type="password" maxlength="128" placeholder="보호 닉네임 비밀번호">
  <div class="sub">이 닉네임은 관리자 전용입니다. 허가받은 사용자만 비밀번호를 입력하세요.</div>
</div>
<input id="room" maxlength="40" placeholder="방 이름 / 방 코드">
<input id="roomPassword" type="password" maxlength="128" placeholder="방 비밀번호">
<button onclick="join()">방 입장</button>
<div class="sub">방 이름과 비밀번호가 모두 맞아야 입장할 수 있습니다. 새 방은 비밀번호를 12자 이상으로 설정하세요.</div>
<button type="button" onclick="health()">서버 상태 확인</button>
<div id="status"></div>
<div class="roomSearch">
  <b>🔎 방 목록 검색</b>
  <div class="sub">방 이름만 검색됩니다. 비밀번호는 공개되지 않습니다.</div>
  <div class="roomSearchRow">
    <input id="roomSearchInput" maxlength="40" placeholder="찾을 방 이름" onkeydown="if(event.key==='Enter')searchRooms()">
    <button type="button" onclick="searchRooms()">검색</button>
  </div>
  <div id="roomList" class="roomList"></div>
</div>
</section>
<section id="chat"><aside><h3>참여자</h3><div id="roomtag" class="roomtag"></div><div id="members"></div><br><button class="danger" onclick="leave()">나가기</button></aside>
<main><div id="messages"></div><div class="form"><input id="text" maxlength="500" placeholder="메시지를 입력하세요" onkeydown="if(event.key==='Enter')send()"><button onclick="send()">전송</button></div></main></section>
</div></div>
<script>
let ws=null, me="", room="", roomToken="", token="", adminToken="", reconnectTimer=null, manuallyLeft=false, connecting=false;
const $=id=>document.getElementById(id);

function status(t){$("status").textContent=t}

async function health(){
  try{
    const r=await fetch("/api/health",{cache:"no-store"});
    const d=await r.json();
    status(r.ok ? "서버 정상: "+JSON.stringify(d) : "서버 오류: HTTP "+r.status);
  }catch(e){
    status("서버 상태 확인 실패: "+e.message);
  }
}

function esc(s){
  return String(s).replace(/[&<>"']/g,c=>c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c===String.fromCharCode(34)?"&quot;":"&#39;");
}

function addMsg(m){
  const box=$("messages");
  const el=document.createElement("div");
  el.className="msg"+(m.system?" system":"");
  el.innerHTML=m.system
    ? "<small>"+esc(m.time)+"</small> "+esc(m.text)
    : "<b>"+esc(m.name)+"</b><small>"+esc(m.time)+"</small><br>"+esc(m.text);
  box.appendChild(el);
  box.scrollTop=box.scrollHeight;
}

function renderMembers(list){
  $("members").innerHTML=(list||[]).map(x=>"<div>• "+esc(x)+"</div>").join("");
}

function scheduleReconnect(){
  if(manuallyLeft)return;
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(()=>{
    reconnectTimer=null;
    connect();
  },1500);
}

function clearConnectionState(){
  clearTimeout(reconnectTimer);
  reconnectTimer=null;
  connecting=false;
}

function connect(){
  if(!me||!room||manuallyLeft)return;
  if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING))return;
  if(connecting)return;

  connecting=true;

  const wsUrl=new URL("/ws",window.location.href);
  wsUrl.protocol=window.location.protocol==="https:"?"wss:":"ws:";
  wsUrl.searchParams.set("room",room);
  wsUrl.searchParams.set("name",me);
  wsUrl.searchParams.set("roomToken",roomToken);

  // 방 비밀번호 자체는 WebSocket URL에 넣지 않습니다.
  // 관리자라면 서버가 발급한 짧은 수명의 토큰만 전송합니다.
  if(adminToken){
    wsUrl.searchParams.set("adminToken",adminToken);
  }

  status("채팅 서버에 연결 중...");

  const currentWs=new WebSocket(wsUrl.toString());
  ws=currentWs;

  currentWs.onopen=()=>{
    if(ws!==currentWs)return;
    connecting=false;
    clearTimeout(reconnectTimer);
    status("연결 성공");
    $("login").style.display="none";
    $("chat").style.display="grid";
    $("roomtag").textContent="방: "+room;
  };

  currentWs.onmessage=e=>{
    if(ws!==currentWs)return;

    let d;
    try{d=JSON.parse(e.data)}catch{return}

    if(d.type==="init"){
      token=d.token;
      renderMembers(d.members||[]);
      $("messages").innerHTML="";
      (d.messages||[]).forEach(addMsg);
    }else if(d.type==="members"){
      renderMembers(d.members||[]);
    }else if(d.type==="message"||d.type==="system"){
      addMsg(d);
    }else if(d.type==="error"){
      addMsg({system:true,time:d.time||"",text:d.message||"오류가 발생했습니다."});
    }
  };

  currentWs.onclose=e=>{
    if(ws!==currentWs)return;

    ws=null;
    connecting=false;

    if(manuallyLeft)return;

    // 관리자 연결은 인증 토큰이 있으므로 실패 시 무한 재연결하지 않습니다.
    // 특히 Cloudflare가 WebSocket handshake 단계에서 403/409 등을 반환하면
    // 브라우저에서는 1006 등의 일반적인 실패로 보일 수 있기 때문입니다.
    if(adminToken){
      clearConnectionState();
      adminToken="";
      token="";
      status("관리자 WebSocket 연결이 종료되었습니다. 다시 관리자 로그인해 주세요.");
      $("login").style.display="block";
      $("chat").style.display="none";
      $("adminBox").style.display=isProtectedNameClient(me)?"block":"none";
      return;
    }

    status("WebSocket 연결 종료: 코드 "+e.code+(e.reason?" / "+e.reason:"")+" (1.5초 후 재연결)");
    scheduleReconnect();
  };

  currentWs.onerror=()=>{
    if(ws!==currentWs)return;
    status("WebSocket 연결 오류. 자동 재연결을 시도합니다...");
  };
}

function isProtectedNameClient(name){
  const protectedNames=["admin","administrator","관리자","운영자","운영","owner","root","system","moderator","mod"];
  return protectedNames.includes(String(name).trim().toLowerCase());
}

function checkProtectedName(){
  const protectedName=isProtectedNameClient($("name").value);
  $("adminBox").style.display=protectedName?"block":"none";
}

async function searchRooms(){
  const q=$("roomSearchInput").value.trim();
  const box=$("roomList");
  box.innerHTML='<div class="empty">방 목록을 검색하는 중...</div>';

  try{
    const r=await fetch("/api/rooms?q="+encodeURIComponent(q),{cache:"no-store"});
    const d=await r.json();

    if(!r.ok) throw new Error(d.error || "방 목록을 불러오지 못했습니다.");

    if(!d.rooms?.length){
      box.innerHTML='<div class="empty">검색 결과가 없습니다.</div>';
      return;
    }

    box.innerHTML=d.rooms.map(x=>{
      const exp=x.expiresAt ? new Date(x.expiresAt).toLocaleString("ko-KR") : "";
      return '<div class="roomItem"><span>🔒 '+esc(x.name)+' <small>초기화: '+esc(exp)+'</small></span><button type="button" onclick="selectRoom('+JSON.stringify(x.name)+')">선택</button></div>';
    }).join("");
  }catch(e){
    box.innerHTML='<div class="empty">방 목록 검색 실패: '+esc(e.message)+'</div>';
  }
}

function selectRoom(name){
  $("room").value=name;
  $("roomPassword").focus();
}

async function loginAdmin(password){
  const r=await fetch("/api/admin-login",{
    method:"POST",
    headers:{"content-type":"application/json"},
    cache:"no-store",
    body:JSON.stringify({password})
  });

  let d={};
  try{d=await r.json()}catch{}

  if(!r.ok){
    throw new Error(d.error || "관리자 인증에 실패했습니다.");
  }

  if(!d.token){
    throw new Error("관리자 인증 토큰을 받지 못했습니다.");
  }

  return d.token;
}

async function loginRoom(roomName,password){
  const r=await fetch("/api/room-login",{
    method:"POST",
    headers:{"content-type":"application/json"},
    cache:"no-store",
    body:JSON.stringify({room:roomName,password})
  });

  let d={};
  try{d=await r.json()}catch{}

  if(!r.ok){
    throw new Error(d.error || "방 비밀번호가 올바르지 않습니다.");
  }

  if(!d.token){
    throw new Error("방 인증 토큰을 받지 못했습니다.");
  }

  return d.token;
}

async function join(){
  me=$("name").value.trim();
  room=$("room").value.trim();
  const roomPassword=$("roomPassword").value;

  if(!me||!room||!roomPassword){
    status("닉네임, 방 이름, 방 비밀번호를 입력하세요.");
    return;
  }

  clearConnectionState();
  manuallyLeft=false;
  adminToken="";
  roomToken="";
  token="";

  status("방 비밀번호 확인 중...");

  try{
    roomToken=await loginRoom(room,roomPassword);
  }catch(e){
    status("방 입장 실패: "+e.message);
    return;
  }

  if(isProtectedNameClient(me)){
    const password=$("adminPassword").value;

    if(!password){
      status("이 닉네임은 관리자 비밀번호가 필요합니다.");
      $("adminPassword").focus();
      return;
    }

    status("관리자 인증 중...");

    try{
      adminToken=await loginAdmin(password);
    }catch(e){
      status("관리자 인증 실패: "+e.message);
      return;
    }
  }

  connect();
}

function send(){
  const input=$("text"),text=input.value.trim();
  if(!text||!ws||ws.readyState!==WebSocket.OPEN)return;
  ws.send(JSON.stringify({type:"message",token,text}));
  input.value="";
}

function leave(){
  manuallyLeft=true;
  connecting=false;
  clearTimeout(reconnectTimer);
  reconnectTimer=null;

  const currentWs=ws;
  ws=null;
  roomToken="";

  if(currentWs)try{currentWs.close(1000,"user left")}catch{}
  location.reload();
}
</script></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(page(), {
        headers: securityHeaders({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "strict-transport-security": "max-age=31536000; includeSubDomains"
        })
      });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "easy-second-chat", version: 5 });
    }

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      const q=cleanText(url.searchParams.get("q"), MAX_ROOM);
      const id=env.CHAT_ROOM.idFromName(DIRECTORY_ROOM_ID);
      const directory=env.CHAT_ROOM.get(id);
      return directory.fetch(new Request(new URL("/directory-search?q="+encodeURIComponent(q), request.url)));
    }

    // 방 비밀번호는 HTTPS POST로만 전달합니다. 비밀번호 자체는 URL/WebSocket에 넣지 않습니다.
    if (url.pathname === "/api/room-login" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok:false, error:"잘못된 요청입니다." }, 400);
      }

      const room = cleanText(body?.room, MAX_ROOM);
      const password = String(body?.password ?? "");

      if (!room || !password) {
        return json({ ok:false, error:"방 이름과 비밀번호가 필요합니다." }, 400);
      }

      if (room === DIRECTORY_ROOM_ID) {
        return json({ ok:false, error:"사용할 수 없는 방 이름입니다." }, 400);
      }

      if (!getRoomAuthSecret(env)) {
        return json({
          ok:false,
          error:"방 인증용 Secret이 없습니다. ROOM_AUTH_SECRET 또는 ADMIN_PASSWORD를 설정하세요."
        }, 503);
      }

      const rate = await checkLoginRateLimit(env, request, "room-login");
      if (!rate.allowed) {
        return json({
          ok:false,
          error:`로그인 시도가 너무 많습니다. ${rate.retryAfterSec}초 후 다시 시도하세요.`
        }, 429);
      }

      const id = env.CHAT_ROOM.idFromName(room);
      const roomStub = env.CHAT_ROOM.get(id);
      const authRequest = new Request(new URL("/room-auth", request.url), {
        method:"POST",
        headers:{
          "content-type":"application/json",
          "x-client-ip":clientIp(request)
        },
        body:JSON.stringify({password,room})
      });

      const response = await roomStub.fetch(authRequest);
      if (response.ok) {
        await clearLoginRateLimit(env, "room-login", clientIp(request));
      }
      return response;
    }

    // 관리자 비밀번호는 HTTPS POST로만 전달합니다.
    if (url.pathname === "/api/admin-login" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok:false, error:"잘못된 요청입니다." }, 400);
      }

      const password = String(body?.password ?? "");

      if (!env.ADMIN_PASSWORD) {
        return json({ ok:false, error:"서버에 ADMIN_PASSWORD가 설정되지 않았습니다." }, 503);
      }

      const adminRate = await checkLoginRateLimit(env, request, "admin-login");
      if (!adminRate.allowed) {
        return json({
          ok:false,
          error:`관리자 로그인 시도가 너무 많습니다. ${adminRate.retryAfterSec}초 후 다시 시도하세요.`
        }, 429);
      }

      if (!passwordMatches(password, env)) {
        // 브라우저의 WebSocket 재연결 루프가 시작되지 않도록
        // WebSocket에 들어가기 전에 인증을 끝냅니다.
        return json({ ok:false, error:"관리자 비밀번호가 올바르지 않습니다." }, 401);
      }

      const token = await createAdminToken(env);

      if (!token) {
        return json({ ok:false, error:"관리자 인증 토큰을 만들 수 없습니다." }, 503);
      }

      await clearLoginRateLimit(env, "admin-login", clientIp(request));

      return json({
        ok:true,
        token,
        expiresInMs: ADMIN_TOKEN_TTL_MS
      });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket Upgrade required", { status: 426 });
      }

      const room = cleanText(url.searchParams.get("room"), MAX_ROOM);
      const name = cleanText(url.searchParams.get("name"), MAX_NAME);
      const adminToken = url.searchParams.get("adminToken") || "";
      const roomToken = url.searchParams.get("roomToken") || "";

      if (!room || !name || !roomToken) {
        return json({ ok:false, error:"room/name/roomToken required" }, 400);
      }

      if (room === DIRECTORY_ROOM_ID) {
        return new Response("사용할 수 없는 방 이름입니다.", { status: 400 });
      }

      if (containsProfanity(name)) {
        return json({ ok:false, error:"사용할 수 없는 닉네임입니다." }, 400);
      }

      if (isProtectedName(name)) {
        const valid = await verifyAdminToken(adminToken, env);

        if (!valid) {
          return new Response("관리자 인증이 필요합니다.", {
            status: 403,
            headers: { "cache-control": "no-store" }
          });
        }
      }

      const id = env.CHAT_ROOM.idFromName(room);
      return env.CHAT_ROOM.get(id).fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/rate-check" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch {}
      const windowMs = Math.max(1000, Math.min(Number(body.windowMs) || LOGIN_RATE_WINDOW_MS, 60 * 60 * 1000));
      const max = Math.max(1, Math.min(Number(body.max) || LOGIN_RATE_MAX_ATTEMPTS, 100));
      const now = Date.now();
      let attempts = await this.ctx.storage.get("attempts");
      attempts = Array.isArray(attempts) ? attempts.filter(t => now - t < windowMs) : [];
      if (attempts.length >= max) {
        const oldest = attempts[0] || now;
        const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
        await this.ctx.storage.put("attempts", attempts);
        return json({ ok:true, allowed:false, retryAfterSec });
      }
      attempts.push(now);
      await this.ctx.storage.put("attempts", attempts);
      return json({ ok:true, allowed:true, retryAfterSec:0 });
    }

    if (url.pathname === "/rate-clear" && request.method === "POST") {
      await this.ctx.storage.delete("attempts");
      return json({ ok:true });
    }

    if (this.ctx.id.toString() === envIdForDirectory(this.env)) {
      if (url.pathname === "/directory-register" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch {
          return json({ok:false,error:"잘못된 요청입니다."},400);
        }

        const name=cleanText(body?.name,MAX_ROOM);
        const createdAt=Number(body?.createdAt);
        const expiresAt=Number(body?.expiresAt);

        if (!name || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
          return json({ok:false,error:"잘못된 방 정보입니다."},400);
        }

        await this.ctx.storage.put("room:"+name,{name,createdAt,expiresAt});
        return json({ok:true});
      }

      if (url.pathname === "/directory-remove" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch {
          return json({ok:false,error:"잘못된 요청입니다."},400);
        }

        const name=cleanText(body?.name,MAX_ROOM);
        if (name) await this.ctx.storage.delete("room:"+name);
        return json({ok:true});
      }

      if (url.pathname === "/directory-search" && request.method === "GET") {
        const q=cleanText(url.searchParams.get("q"),MAX_ROOM).toLowerCase();
        const now=Date.now();
        const result=[];
        const entries=await this.ctx.storage.list({prefix:"room:"});

        for (const [key,info] of entries) {
          if (!info || Number(info.expiresAt) <= now) {
            await this.ctx.storage.delete(key);
            continue;
          }

          if (!q || String(info.name).toLowerCase().includes(q)) {
            result.push(info);
          }
        }

        result.sort((a,b)=>a.name.localeCompare(b.name,"ko"));

        return json({ok:true,rooms:result.slice(0,100)});
      }
    }

    if (url.pathname === "/room-auth" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ ok:false, error:"잘못된 요청입니다." }, 400);
      }

      const password = String(body?.password ?? "");
      const roomName = cleanText(body?.room, MAX_ROOM);
      if (!password || !roomName) {
        return json({ ok:false, error:"방 비밀번호가 필요합니다." }, 400);
      }

      if (password.length > MAX_ROOM_PASSWORD) {
        return json({ ok:false, error:`방 비밀번호는 ${MAX_ROOM_PASSWORD}자 이하로 입력하세요.` }, 400);
      }

      const savedHash = await this.ctx.storage.get("roomPasswordHash");
      const clientIpValue = request.headers.get("x-client-ip") || "unknown";
      const failKey = `authfail:${clientIpValue}`;
      const now = Date.now();
      let failures = await this.ctx.storage.get(failKey);
      failures = Array.isArray(failures) ? failures.filter(t => now - t < ROOM_AUTH_FAIL_WINDOW_MS) : [];

      if (failures.length >= ROOM_AUTH_FAIL_MAX) {
        const oldest = failures[0] || now;
        const retryAfterSec = Math.max(1, Math.ceil((ROOM_AUTH_FAIL_WINDOW_MS - (now - oldest)) / 1000));
        return json({ ok:false, error:`이 방에 대한 비밀번호 시도가 너무 많습니다. ${retryAfterSec}초 후 다시 시도하세요.` }, 429);
      }

      if (!savedHash) {
        if (password.length < MIN_NEW_ROOM_PASSWORD) {
          return json({
            ok:false,
            error:`새 방 비밀번호는 최소 ${MIN_NEW_ROOM_PASSWORD}자 이상으로 설정하세요.`
          }, 400);
        }

        const passwordRecord = await hashRoomPassword(password);
        const createdAt=Date.now();
        const generation=crypto.randomUUID();

        await this.ctx.storage.put("roomPasswordHash", passwordRecord);
        await this.ctx.storage.put("roomName", roomName);
        await this.ctx.storage.put("roomCreatedAt", createdAt);
        await this.ctx.storage.put("roomGeneration", generation);
        await this.ctx.storage.setAlarm(createdAt + ROOM_RESET_MS);
        await this.updateDirectory(true, createdAt, createdAt + ROOM_RESET_MS);
        await this.ctx.storage.delete(failKey);
      } else {
        let valid = false;

        if (typeof savedHash === "object" && savedHash.alg === "PBKDF2-SHA256") {
          valid = await verifyRoomPassword(password, savedHash);
        } else if (typeof savedHash === "string") {
          // V4 이하의 SHA-256 저장 형식과 호환. 성공한 순간 PBKDF2로 업그레이드합니다.
          const legacyHash = await legacyHashRoomPassword(password);
          valid = safeEqual(savedHash, legacyHash);
          if (valid) {
            await this.ctx.storage.put("roomPasswordHash", await hashRoomPassword(password));
          }
        }

        if (!valid) {
          failures.push(now);
          await this.ctx.storage.put(failKey, failures.slice(-ROOM_AUTH_FAIL_MAX));
          return json({ ok:false, error:"방 비밀번호가 올바르지 않습니다." }, 401);
        }

        await this.ctx.storage.delete(failKey);
      }

      let createdAt=await this.ctx.storage.get("roomCreatedAt");
      let generation=await this.ctx.storage.get("roomGeneration");
      if (!await this.ctx.storage.get("roomName")) {
        await this.ctx.storage.put("roomName", roomName);
      }

      // 이전 버전에서 만들어진 방을 처음 접속할 때 24시간 초기화를 예약합니다.
      if (!createdAt || !generation) {
        createdAt=Date.now();
        generation=crypto.randomUUID();
        await this.ctx.storage.put("roomCreatedAt", createdAt);
        await this.ctx.storage.put("roomGeneration", generation);
        await this.ctx.storage.setAlarm(createdAt + ROOM_RESET_MS);
        await this.updateDirectory(true, createdAt, createdAt + ROOM_RESET_MS);
      }

      const roomToken = await createRoomToken(this.ctx.id.toString(), generation, this.env);
      if (!roomToken) {
        return json({ ok:false, error:"방 인증 토큰을 만들 수 없습니다." }, 503);
      }

      return json({
        ok:true,
        token:roomToken,
        expiresInMs:ROOM_TOKEN_TTL_MS
      });
    }

    if (url.pathname !== "/ws" ||
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket Upgrade required", { status: 426 });
    }

    const name = cleanText(url.searchParams.get("name"), MAX_NAME);
    const roomToken = url.searchParams.get("roomToken") || "";
    const adminToken = url.searchParams.get("adminToken") || "";

    if (!name || !roomToken) {
      return json({ ok:false, error:"name/roomToken required" }, 400);
    }

    if (roomToken.length > 512 || adminToken.length > 512) {
      return new Response("인증 정보가 너무 깁니다.", { status: 400, headers: securityHeaders({"cache-control":"no-store"}) });
    }

    const roomGeneration = await this.ctx.storage.get("roomGeneration");
    const validRoomToken = await verifyRoomToken(roomToken, this.ctx.id.toString(), roomGeneration, this.env);
    if (!validRoomToken) {
      return new Response("방 비밀번호 인증이 필요하거나 만료되었습니다.", {
        status: 403,
        headers: { "cache-control": "no-store" }
      });
    }

    if (isProtectedName(name)) {
      const valid = await verifyAdminToken(adminToken, this.env);

      if (!valid) {
        // Worker까지 통과했더라도 DO에서 한 번 더 확인합니다.
        // HTTP 403을 반환하는 대신 WebSocket을 명확한 인증 실패 코드로 닫습니다.
        return new Response("관리자 인증이 필요합니다.", {
          status: 403,
          headers: { "cache-control": "no-store" }
        });
      }
    }

    if (this.ctx.getWebSockets().length >= MAX_MEMBERS) {
      return json({ ok:false, error:"방 인원이 가득 찼습니다." }, 429);
    }

    const duplicate = this.ctx.getWebSockets()
      .some(ws => ws.deserializeAttachment()?.name === name);

    if (duplicate) {
      return json({ ok:false, error:"같은 닉네임이 이미 사용 중입니다." }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const token = crypto.randomUUID();

    const session = {
      id: crypto.randomUUID(),
      name,
      token,
      joinedAt: Date.now(),
      rate: []
    };

    this.ctx.acceptWebSocket(server, ["chat"]);
    server.serializeAttachment(session);

    const members = this.members();

    server.send(JSON.stringify({
      type:"init",
      token,
      members,
      messages: await this.history()
    }));

    this.broadcast({ type:"members", members });
    this.system(`${name}님이 입장했습니다.`);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async updateDirectory(register, createdAt, expiresAt) {
    if (this.ctx.id.toString() === envIdForDirectory(this.env)) return;

    const roomName=await this.ctx.storage.get("roomName");
    if (!roomName) return;

    const directoryId=this.env.CHAT_ROOM.idFromName(DIRECTORY_ROOM_ID);
    const directory=this.env.CHAT_ROOM.get(directoryId);
    const path=register ? "/directory-register" : "/directory-remove";

    const body=register
      ? {name:roomName,createdAt,expiresAt}
      : {name:roomName};

    await directory.fetch(new Request("https://internal"+path,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(body)
    }));
  }

  async alarm() {
    if (this.ctx.id.toString() === envIdForDirectory(this.env)) return;

    const roomName=await this.ctx.storage.get("roomName");

    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4000,"24시간 방 초기화"); } catch {}
    }

    if (roomName) {
      const directoryId=this.env.CHAT_ROOM.idFromName(DIRECTORY_ROOM_ID);
      const directory=this.env.CHAT_ROOM.get(directoryId);
      await directory.fetch(new Request("https://internal/directory-remove",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({name:roomName})
      }));
    }

    // 대화 내용, 비밀번호, 방 생성 정보 등 방 전체를 초기화합니다.
    await this.ctx.storage.deleteAll();
  }

  members() {
    return this.ctx.getWebSockets()
      .map(ws => ws.deserializeAttachment()?.name)
      .filter(Boolean);
  }

  async history() {
    const data = await this.ctx.storage.get("messages");
    return Array.isArray(data) ? data.slice(-100) : [];
  }

  async webSocketMessage(ws, raw) {
    const s = ws.deserializeAttachment();
    if (!s) return;

    if (typeof raw !== "string" || raw.length > 4096) {
      try { ws.close(1009, "message too large"); } catch {}
      return;
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({
        type:"error",
        message:"잘못된 요청입니다."
      }));
      return;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      ws.send(JSON.stringify({ type:"error", message:"잘못된 요청입니다." }));
      return;
    }

    if (typeof data.token !== "string" || data.token.length > 256 || data.token !== s.token) {
      ws.send(JSON.stringify({
        type:"error",
        message:"인증 실패"
      }));
      return;
    }

    if (data.type !== "message") return;

    const now = Date.now();
    s.rate = s.rate.filter(t => now - t < RATE_WINDOW_MS);

    if (s.rate.length >= MAX_MESSAGES_PER_WINDOW) {
      ws.send(JSON.stringify({
        type:"error",
        time:timeNow(),
        message:"메시지를 너무 빠르게 보내고 있습니다."
      }));

      ws.serializeAttachment(s);
      return;
    }

    s.rate.push(now);

    const text = cleanText(data.text, MAX_MESSAGE);
    if (!text) return;

    if (containsProfanity(text)) {
      ws.send(JSON.stringify({
        type:"error",
        time:timeNow(),
        message:"욕설이 포함된 메시지는 전송할 수 없습니다."
      }));

      ws.serializeAttachment(s);
      return;
    }

    const message = {
      type:"message",
      name:s.name,
      text,
      time:timeNow()
    };

    await this.append(message);
    this.broadcast(message);
    ws.serializeAttachment(s);
  }

  async append(message) {
    const old = await this.ctx.storage.get("messages");
    const list = Array.isArray(old) ? old : [];
    list.push(message);
    await this.ctx.storage.put("messages", list.slice(-100));
  }

  system(text) {
    const message = {
      type:"system",
      system:true,
      text,
      time:timeNow()
    };

    this.append(message).then(() => this.broadcast(message));
  }

  broadcast(data) {
    const raw = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      } catch {}
    }
  }

  webSocketClose(ws) {
    const s = ws.deserializeAttachment();
    if (!s) return;

    this.broadcast({
      type:"system",
      system:true,
      text:`${s.name}님이 나갔습니다.`,
      time:timeNow()
    });

    this.broadcast({
      type:"members",
      members:this.members()
    });
  }

  webSocketError(ws) {
    try { ws.close(1011, "socket error"); } catch {}
  }
}

function envIdForDirectory(env) {
  return env.CHAT_ROOM.idFromName(DIRECTORY_ROOM_ID).toString();
}

function timeNow() {
  return new Date().toLocaleTimeString("ko-KR", {
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit",
    hour12:false
  });
}
