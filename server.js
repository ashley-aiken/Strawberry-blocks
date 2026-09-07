import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server});
const rooms=new Map();
const MAX_PLAYERS=6;
app.use(express.static('public'));
app.get('/health',(req,res)=>res.json({ok:true,rooms:rooms.size}));
app.get('/{*splat}',(req,res)=>res.sendFile(process.cwd()+'/public/index.html'));

function id(){return crypto.randomBytes(4).toString('hex');}
function cleanName(n){return String(n||'Player').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,18)||'Player';}
function roomState(room){return {type:'roomState',room:room.code,mode:room.mode,host:room.host,started:room.started,players:[...room.players.values()].map(p=>({id:p.id,name:p.name,ready:p.ready,score:p.score,alive:p.alive,board:p.board||null,active:p.active||null}))};}
function broadcast(room,msg){const s=JSON.stringify(msg);for(const p of room.players.values())if(p.ws.readyState===1)p.ws.send(s);}
function broadcastState(room){broadcast(room,roomState(room));}
function makeRoom(code,mode,host){return {code,mode,host,started:false,players:new Map(),seed:Math.floor(Math.random()*2**31)}}
function leave(p){if(!p.room)return;const r=rooms.get(p.room);if(!r)return;r.players.delete(p.id);if(r.host===p.id){const next=r.players.values().next().value;r.host=next?.id||null}if(r.players.size===0)rooms.delete(r.code);else{if(r.started)r.started=false;broadcastState(r)}p.room=null}

wss.on('connection',(ws)=>{
 const p={ws,id:id(),name:'Player',room:null,ready:false,score:0,alive:true};
 ws.send(JSON.stringify({type:'hello',id:p.id}));
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw)}catch{return}
  if(m.type==='createRoom'){
   leave(p);let code=(String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6)||id().slice(0,6).toUpperCase());while(rooms.has(code))code=id().slice(0,6).toUpperCase();
   const r=makeRoom(code,m.mode==='coop'?'coop':'versus',p.id);p.name=cleanName(m.name);p.room=code;p.ready=false;p.score=0;r.players.set(p.id,p);rooms.set(code,r);p.ws.send(JSON.stringify({type:'joined',room:code,mode:r.mode}));broadcastState(r);return;
  }
  if(m.type==='joinRoom'){
   const code=String(m.code||'').toUpperCase();const r=rooms.get(code);if(!r)return ws.send(JSON.stringify({type:'error',message:'Room not found.'}));if(r.started)return ws.send(JSON.stringify({type:'error',message:'That game is already running.'}));if(r.players.size>=MAX_PLAYERS)return ws.send(JSON.stringify({type:'error',message:'Room is full.'}));
   leave(p);p.name=cleanName(m.name);p.room=code;p.ready=false;p.score=0;r.players.set(p.id,p);ws.send(JSON.stringify({type:'joined',room:code,mode:r.mode}));broadcastState(r);return;
  }
  if(m.type==='setReady'){
   const r=rooms.get(p.room);if(!r)return;p.ready=!!m.ready;broadcastState(r);if(r.players.size>=1&&[...r.players.values()].every(x=>x.ready)){r.started=true;for(const x of r.players.values()){x.score=0;x.alive=true}broadcast(r,{type:'start',seed:r.seed,mode:r.mode});broadcastState(r)}return;
  }
  if(m.type==='state'){
   const r=rooms.get(p.room);if(!r||!r.started)return;p.score=Number(m.score)||0;p.alive=m.alive!==false;p.board=m.board||null;p.active=m.active||null;broadcast(r,{type:'playerState',id:p.id,name:p.name,score:p.score,alive:p.alive,board:p.board,active:p.active});return;
  }
  if(m.type==='event'){
   const r=rooms.get(p.room);if(!r)return;broadcast(r,{type:'gameEvent',id:p.id,event:m.event});return;
  }
  if(m.type==='leave'){leave(p);ws.send(JSON.stringify({type:'left'}));}
 });
 ws.on('close',()=>leave(p));
});

const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(ws.readyState===1)ws.ping()}},25000);
const PORT=process.env.PORT||10000;server.listen(PORT,'0.0.0.0',()=>console.log(`Neon Blocks online on ${PORT}`));
process.on('SIGTERM',()=>{clearInterval(heartbeat);for(const ws of wss.clients)ws.close(1001,'Server restarting');server.close(()=>process.exit(0));});
