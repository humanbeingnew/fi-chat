import { getStore } from "@netlify/blobs";

const MAX_NAME=24, MAX_ROOM=40, MAX_ROOM_PASSWORD=128, MIN_NEW_ROOM_PASSWORD=12;
const ROOM_RESET_MS=24*60*60*1000, TOKEN_TTL_MS=24*60*60*1000, ADMIN_TOKEN_TTL_MS=5*60*1000;
const MAX_MESSAGE=500, MAX_MEMBERS=50, PRESENCE_MS=15000;
const PROFANITY=["시발","씨발","ㅅㅂ","병신","ㅂㅅ","개새끼","좆","존나","fuck","shit","bitch","asshole"];
const PROTECTED_NAMES=new Set(["admin","administrator","관리자","운영자","운영","owner","root","system","moderator","mod"]);
const rooms=getStore("easy-second-chat-rooms");
const directory=getStore("easy-second-chat-directory");

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","x-frame-options":"DENY","referrer-policy":"no-referrer"}})}
function clean(v,max){return String(v??"").trim().slice(0,max)}
function badWord(s){const x=String(s).toLowerCase();return PROFANITY.some(w=>x.includes(w.toLowerCase()))}
function protectedName(n){return PROTECTED_NAMES.has(String(n).trim().toLowerCase())}
function b64(bytes){let b="";for(const x of bytes)b+=String.fromCharCode(x);return btoa(b).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
function unb64(s){const n=String(s).replace(/-/g,"+").replace(/_/g,"/");const p=n+"=".repeat((4-n.length%4)%4);return Uint8Array.from(atob(p),c=>c.charCodeAt(0))}
function equal(a,b){if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0}
async function hmac(text,secret){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(text))))}
async function token(payload,secret,ttl){const exp=Date.now()+ttl,n=new Uint8Array(18);crypto.getRandomValues(n);const nonce=b64(n),p=`${payload}.${exp}.${nonce}`,sig=await hmac(p,secret);return `${exp}.${nonce}.${sig}`}
async function verifyToken(t,payload,secret){if(!t||!secret)return false;const a=String(t).split(".");if(a.length!==3)return false;const [exp,nonce,sig]=a;if(Date.now()>=Number(exp))return false;return equal(sig,await hmac(`${payload}.${exp}.${nonce}`,secret))}
async function derive(password,salt,iterations=20000){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),{name:"PBKDF2"},false,["deriveBits"]);return b64(new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},k,256)))}
async function hashPassword(password){const salt=new Uint8Array(16);crypto.getRandomValues(salt);return {alg:"PBKDF2-SHA256",iterations:20000,salt:b64(salt),hash:await derive(password,salt)}}
async function verifyPassword(password,r){try{if(!r||r.alg!=="PBKDF2-SHA256")return false;const salt=unb64(r.salt);return equal(r.hash,await derive(password,salt,Number(r.iterations)))}catch{return false}}
function secret(){return String(process.env.ROOM_AUTH_SECRET||process.env.ADMIN_PASSWORD||"")}
function adminPassword(){return String(process.env.ADMIN_PASSWORD||"")}
function roomKey(room){return "room:"+encodeURIComponent(room)}
async function getRoom(room){return await rooms.get(roomKey(room),{type:"json"})}
async function saveRoom(room,data){await rooms.setJSON(roomKey(room),data)}
async function freshRoom(room,data){return data&&data.roomName===room&&data.createdAt&&data.createdAt+ROOM_RESET_MS>Date.now()}
function timeNow(){return new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})}
async function authRoom(room,rt){const r=await getRoom(room);if(!freshRoom(room,r))return null;const s=secret();if(!s)return null;const ok=await verifyToken(rt,`${room}.${r.generation}`,s);return ok?r:null}
function prunePresence(r){const now=Date.now();r.presence=Array.isArray(r.presence)?r.presence.filter(x=>x&&now-x.lastSeen<PRESENCE_MS):[]}
async function directoryRegister(r){await directory.setJSON(roomKey(r.roomName),{name:r.roomName,createdAt:r.createdAt,expiresAt:r.createdAt+ROOM_RESET_MS})}
async function directoryRemove(room){await directory.delete(roomKey(room))}
async function roomList(q){const out=[];let cursor;do{const page=await directory.list({prefix:"room:",cursor,limit:100});for(const x of page.blobs){const v=await directory.get(x.key,{type:"json"});if(v&&v.expiresAt>Date.now()&&(!q||v.name.toLowerCase().includes(q.toLowerCase())))out.push(v);else if(v)await directory.delete(x.key)}cursor=page.cursor}while(cursor);out.sort((a,b)=>a.name.localeCompare(b.name,"ko"));return out.slice(0,100)}
function getBody(req){return req.json().catch(()=>({}))}
export default async (req)=>{
 const u=new URL(req.url), path=u.pathname.replace(/^\/api/,"")||"/";
 try{
  if(path==="/health")return json({ok:true,service:"easy-second-chat-netlify",version:1});
  if(path==="/rooms"&&req.method==="GET")return json({ok:true,rooms:await roomList(clean(u.searchParams.get("q"),MAX_ROOM))});
  if(path==="/room-exists"&&req.method==="GET"){const room=clean(u.searchParams.get("room"),MAX_ROOM),r=await getRoom(room);return json({ok:true,exists:freshRoom(room,r)})}
  if(path==="/room-create"&&req.method==="POST"){
   const b=await getBody(req),room=clean(b.room,MAX_ROOM),password=String(b.password||"");if(!room||!password)return json({ok:false,error:"방 이름과 비밀번호가 필요합니다."},400);
   if(password.length<MIN_NEW_ROOM_PASSWORD||password.length>MAX_ROOM_PASSWORD)return json({ok:false,error:`비밀번호는 ${MIN_NEW_ROOM_PASSWORD}~${MAX_ROOM_PASSWORD}자여야 합니다.`},400);
   if(!secret())return json({ok:false,error:"Netlify 환경변수 ROOM_AUTH_SECRET 또는 ADMIN_PASSWORD를 설정하세요."},503);
   const old=await getRoom(room);if(freshRoom(room,old))return json({ok:false,error:"이미 존재하는 방입니다. 방 들어가기를 이용하세요."},409);
   const createdAt=Date.now(),generation=crypto.randomUUID(),r={roomName:room,password:await hashPassword(password),createdAt,generation,messages:[],presence:[]};
   await saveRoom(room,r);await directoryRegister(r);return json({ok:true,room,createdAt,expiresAt:createdAt+ROOM_RESET_MS});
  }
  if(path==="/room-login"&&req.method==="POST"){
   const b=await getBody(req),room=clean(b.room,MAX_ROOM),password=String(b.password||""),r=await getRoom(room);
   if(!freshRoom(room,r))return json({ok:false,error:"존재하지 않는 방입니다."},404);
   if(!(await verifyPassword(password,r.password)))return json({ok:false,error:"방 비밀번호가 올바르지 않습니다."},401);
   const rt=await token(`${room}.${r.generation}`,secret(),TOKEN_TTL_MS);return json({ok:true,token:rt,expiresInMs:TOKEN_TTL_MS});
  }
  if(path==="/admin-login"&&req.method==="POST"){
   const b=await getBody(req),ap=adminPassword();if(!ap)return json({ok:false,error:"ADMIN_PASSWORD가 설정되지 않았습니다."},503);
   if(!equal(String(b.password||""),ap))return json({ok:false,error:"관리자 비밀번호가 올바르지 않습니다."},401);
   return json({ok:true,token:await token("admin",ap,ADMIN_TOKEN_TTL_MS)});
  }
  if(path==="/state"&&req.method==="GET"){
   const room=clean(u.searchParams.get("room"),MAX_ROOM),name=clean(u.searchParams.get("name"),MAX_NAME),rt=u.searchParams.get("roomToken")||"",at=u.searchParams.get("adminToken")||"",r=await authRoom(room,rt);
   if(!r)return json({ok:false,error:"방 인증이 만료되었습니다."},403);if(badWord(name))return json({ok:false,error:"사용할 수 없는 닉네임입니다."},400);
   if(protectedName(name)&&!(await verifyToken(at,"admin",adminPassword())))return json({ok:false,error:"관리자 인증이 필요합니다."},403);
   prunePresence(r);let p=r.presence.find(x=>x.name===name);if(!p){if(r.presence.length>=MAX_MEMBERS)return json({ok:false,error:"방 인원이 가득 찼습니다."},429);r.presence.push({name,lastSeen:Date.now()})}else p.lastSeen=Date.now();
   await saveRoom(room,r);return json({ok:true,members:r.presence.map(x=>x.name),messages:r.messages||[]});
  }
  if(path==="/send"&&req.method==="POST"){
   const b=await getBody(req),room=clean(b.room,MAX_ROOM),name=clean(b.name,MAX_NAME),text=clean(b.text,MAX_MESSAGE),r=await authRoom(room,b.roomToken||"");
   if(!r)return json({ok:false,error:"방 인증이 만료되었습니다."},403);if(!name||!text)return json({ok:false,error:"내용이 필요합니다."},400);
   if(badWord(name))return json({ok:false,error:"사용할 수 없는 닉네임입니다."},400);if(badWord(text))return json({ok:false,error:"욕설이 포함된 메시지는 전송할 수 없습니다."},400);
   if(protectedName(name)&&!(await verifyToken(b.adminToken||"","admin",adminPassword())))return json({ok:false,error:"관리자 인증이 필요합니다."},403);
   prunePresence(r);if(!r.presence.some(x=>x.name===name))return json({ok:false,error:"채팅방에 다시 입장해 주세요."},403);
   r.messages=Array.isArray(r.messages)?r.messages:[];r.messages.push({type:"message",name,text,time:timeNow()});r.messages=r.messages.slice(-100);await saveRoom(room,r);return json({ok:true});
  }
  if(path==="/leave"&&req.method==="POST"){
   const b=await getBody(req),room=clean(b.room,MAX_ROOM),r=await authRoom(room,b.roomToken||"");if(!r)return json({ok:true});
   r.presence=(r.presence||[]).filter(x=>x.name!==clean(b.name,MAX_NAME));await saveRoom(room,r);return json({ok:true});
  }
  return json({ok:false,error:"Not Found"},404);
 }catch(e){console.error(e);return json({ok:false,error:"서버 내부 오류가 발생했습니다."},500)}
};
