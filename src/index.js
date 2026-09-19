import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 24;
const MAX_ROOM = 40;
const MAX_MESSAGE = 500;
const MAX_MEMBERS = 50;
const RATE_WINDOW_MS = 5000;
const MAX_MESSAGES_PER_WINDOW = 15;

const PROFANITY = [
  "시발", "씨발", "ㅅㅂ", "병신", "ㅂㅅ", "개새끼",
  "좆", "존나", "fuck", "shit", "bitch", "asshole"
];

// 관리자/운영자 계열 보호 닉네임.
// 이 목록에 있는 닉네임은 ADMIN_PASSWORD를 알아야 사용할 수 있습니다.
const PROTECTED_NAMES = new Set([
  "admin", "administrator", "관리자", "운영자", "운영", "owner",
  "root", "system", "moderator", "mod"
]);

function isProtectedName(name) {
  return PROTECTED_NAMES.has(String(name).trim().toLowerCase());
}

function passwordMatches(provided, env) {
  return Boolean(env.ADMIN_PASSWORD) &&
    String(provided ?? "") === String(env.ADMIN_PASSWORD);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function containsProfanity(text) {
  const lower = text.toLowerCase();
  return PROFANITY.some(word => lower.includes(word.toLowerCase()));
}

function page() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EASY SECOND CHAT V2</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0f1218;color:#eef2f7;font-family:Arial,sans-serif}.wrap{max-width:1050px;margin:24px auto;padding:14px}.card{background:#181d26;border:1px solid #303847;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px #0006}header{padding:20px;border-bottom:1px solid #303847}h1{margin:0 0 5px}.sub{color:#9da8b8}.login{padding:24px;display:grid;gap:10px;max-width:460px}input,button{font:inherit;border-radius:10px;padding:12px;border:1px solid #3a4658}input{background:#0d1015;color:#fff}button{background:#4d7cff;color:#fff;border:0;cursor:pointer}.danger{background:#8d3c4a}#status{min-height:22px;color:#ffca79}#chat{display:none;grid-template-columns:220px 1fr;min-height:590px}aside{padding:18px;background:#131821;border-right:1px solid #303847}#members{line-height:1.9;color:#cbd3df}.online{color:#7ee0a1}.roomtag{margin:10px 0;padding:8px;border-radius:8px;background:#202735;color:#aeb9c9}main{display:flex;flex-direction:column;min-width:0}#messages{flex:1;overflow:auto;padding:18px;max-height:500px}.msg{padding:10px 12px;margin:8px 0;background:#222a38;border-radius:12px;overflow-wrap:anywhere}.msg b{color:#91b1ff}.msg small{color:#8793a6;margin-left:8px}.system{opacity:.7}.form{display:flex;gap:8px;padding:14px;border-top:1px solid #303847}.form input{flex:1;min-width:0}@media(max-width:680px){#chat{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #303847}}
</style>
</head>
<body><div class="wrap"><div class="card">
<header><h1>EASY SECOND CHAT V2 💬</h1><div class="sub">같은 방 번호를 입력한 사람은 같은 방에 참여합니다.</div></header>
<section id="login" class="login">
<input id="name" maxlength="24" placeholder="닉네임" oninput="checkProtectedName()">
<div id="adminBox" style="display:none">
  <input id="adminPassword" type="password" maxlength="128" placeholder="보호 닉네임 비밀번호">
  <div class="sub">이 닉네임은 관리자 전용입니다. 허가받은 사용자만 비밀번호를 입력하세요.</div>
</div>
<input id="room" maxlength="40" placeholder="방 번호 / 방 코드">
<button onclick="join()">방 입장</button>
<div class="sub">서버 주소를 입력할 필요 없이, 지금 보고 있는 이 사이트에 자동으로 연결됩니다.</div>
<button type="button" onclick="health()">서버 상태 확인</button>
<div id="status"></div>
</section>
<section id="chat"><aside><h3>참여자</h3><div id="roomtag" class="roomtag"></div><div id="members"></div><br><button class="danger" onclick="leave()">나가기</button></aside>
<main><div id="messages"></div><div class="form"><input id="text" maxlength="500" placeholder="메시지를 입력하세요" onkeydown="if(event.key==='Enter')send()"><button onclick="send()">전송</button></div></main></section>
</div></div>
<script>
let ws=null, me="", room="", token="", adminPassword="", reconnectTimer=null, manuallyLeft=false, connecting=false;
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
function esc(s){return String(s).replace(/[&<>"']/g,c=>c==="&"?"&amp;":c==="<"?"&lt;":c===">"?"&gt;":c===String.fromCharCode(34)?"&quot;":"&#39;");}
function addMsg(m){const box=$("messages");const el=document.createElement("div");el.className="msg"+(m.system?" system":"");el.innerHTML=m.system?"<small>"+esc(m.time)+"</small> "+esc(m.text):"<b>"+esc(m.name)+"</b><small>"+esc(m.time)+"</small><br>"+esc(m.text);box.appendChild(el);box.scrollTop=box.scrollHeight}
function renderMembers(list){$("members").innerHTML=(list||[]).map(x=>"<div>• "+esc(x)+"</div>").join("")}
function scheduleReconnect(){
 if(manuallyLeft)return;
 clearTimeout(reconnectTimer);
 reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect(adminPassword)},1500);
}
function connect(providedAdminPassword=""){
 if(!me||!room||manuallyLeft)return;
 if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING))return;
 if(connecting)return;
 connecting=true;

 const wsUrl=new URL("/ws",window.location.href);
 wsUrl.protocol=window.location.protocol==="https:"?"wss:":"ws:";
 wsUrl.searchParams.set("room",room);
 wsUrl.searchParams.set("name",me);

  if (providedAdminPassword) {
    wsUrl.searchParams.set("adminPassword", providedAdminPassword);
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

async function join(){
 me=$("name").value.trim();
 room=$("room").value.trim();
 if(!me||!room){status("닉네임과 방 번호를 입력하세요.");return}

 adminPassword="";
 if(isProtectedNameClient(me)){
   adminPassword=$("adminPassword").value;
   if(!adminPassword){
     status("이 닉네임은 관리자 비밀번호가 필요합니다.");
     $("adminPassword").focus();
     return;
   }
 }

 manuallyLeft=false;
 clearTimeout(reconnectTimer);
 connect(adminPassword);
}
function send(){const input=$("text"),text=input.value.trim();if(!text||!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(JSON.stringify({type:"message",token,text}));input.value=""}
function leave(){
 manuallyLeft=true;
 connecting=false;
 clearTimeout(reconnectTimer);
 reconnectTimer=null;
 const currentWs=ws;
 ws=null;
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
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "easy-second-chat", version: 2 });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket Upgrade required", { status: 426 });
      }

      const room = cleanText(url.searchParams.get("room"), MAX_ROOM);
      const name = cleanText(url.searchParams.get("name"), MAX_NAME);
      const adminPassword = url.searchParams.get("adminPassword") || "";

      if (!room || !name) {
        return json({ ok:false, error:"room/name required" }, 400);
      }
      if (containsProfanity(name)) {
        return json({ ok:false, error:"사용할 수 없는 닉네임입니다." }, 400);
      }
      if (isProtectedName(name) && !passwordMatches(adminPassword, env)) {
        return json({ ok:false, error:"이 닉네임은 보호되어 있습니다. 관리자 비밀번호가 필요합니다." }, 403);
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

    if (url.pathname !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket Upgrade required", { status: 426 });
    }

    const name = cleanText(url.searchParams.get("name"), MAX_NAME);
    const adminPassword = url.searchParams.get("adminPassword") || "";
    if (!name) return json({ ok:false, error:"name required" }, 400);
    if (isProtectedName(name) && !passwordMatches(adminPassword, this.env)) {
      return json({ ok:false, error:"이 닉네임은 보호되어 있습니다. 관리자 비밀번호가 필요합니다." }, 403);
    }
    if (this.ctx.getWebSockets().length >= MAX_MEMBERS) {
      return json({ ok:false, error:"방 인원이 가득 찼습니다." }, 429);
    }

    const duplicate = this.ctx.getWebSockets().some(ws => ws.deserializeAttachment()?.name === name);
    if (duplicate) return json({ ok:false, error:"같은 닉네임이 이미 사용 중입니다." }, 409);

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

    return new Response(null, { status: 101, webSocket: client });
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

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({type:"error",message:"잘못된 요청입니다."}));
      return;
    }

    if (data.token !== s.token) {
      ws.send(JSON.stringify({type:"error",message:"인증 실패"}));
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

function timeNow() {
  return new Date().toLocaleTimeString("ko-KR", {
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit",
    hour12:false
  });
}
