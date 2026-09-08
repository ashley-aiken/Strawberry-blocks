import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 6;
const ROOM_TTL_MS = 5 * 60 * 1000;
const rooms = new Map();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.disable('x-powered-by');
app.use(express.static('public', { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok:true, rooms:rooms.size, players:[...rooms.values()].reduce((n,r)=>n+r.players.size,0) }));
app.get('/api/lobbies', (_req,res)=>res.json({rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)}));
app.get('/{*splat}', (_req,res)=>res.sendFile(process.cwd()+'/public/index.html'));
function id(){return crypto.randomBytes(6).toString('hex')}
function code(){return crypto.randomBytes(3).toString('hex').toUpperCase()}
function cleanName(n){return String(n||'Player').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,18)||'Player'}
function emptyBoard(){return Array.from({length:20},()=>Array(10).fill(0))}
function publicLobby(r){return {code:r.code,mode:r.mode,host:r.host,started:r.started,players:r.players.size,maxPlayers:MAX_PLAYERS,createdAt:r.createdAt,lastActivity:r.lastActivity}}
function roomState(r){return {type:'roomState',room:r.code,mode:r.mode,host:r.host,started:r.started,round:r.round,teamScore:r.coopScore||0,teamLines:r.coopLines||0,teamCombo:r.coopCombo||0,teamLevel:r.coopLevel||1,coopBoard:r.mode==='coop'?r.coopBoard:null,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,ready:p.ready,score:p.score,alive:p.alive,board:p.board||null,active:p.active||null}))}}
function send(ws,msg){if(ws.readyState===1)ws.send(JSON.stringify(msg))}
function broadcast(r,msg){const s=JSON.stringify(msg);for(const p of r.players.values())if(p.ws.readyState===1)p.ws.send(s)}
function touch(r){r.lastActivity=Date.now()}
function broadcastState(r){touch(r);broadcast(r,roomState(r));broadcastLobbies()}
function broadcastLobbies(){const msg={type:'lobbies',rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)};for(const ws of wss.clients)send(ws,msg)}
function makeRoom(c,mode,host){return {code:c,mode:mode==='coop'?'coop':'versus',host,started:false,round:1,seed:crypto.randomInt(1,0x7fffffff),players:new Map(),createdAt:Date.now(),lastActivity:Date.now(),coopBoard:emptyBoard(),coopScore:0,coopLines:0,coopCombo:0,coopLevel:1,coopNextPiece:0}}
function leave(p){if(!p.room)return;const r=rooms.get(p.room);p.room=null;if(!r)return;r.players.delete(p.id);if(r.host===p.id)r.host=r.players.values().next().value?.id||null;if(r.started)r.started=false; for(const q of r.players.values()) q.ready=false;if(!r.players.size)rooms.delete(r.code);else broadcastState(r);broadcastLobbies()}
function resetPlayer(p){p.ready=false;p.score=0;p.alive=true;p.board=null;p.active=null}
function startIfReady(r){if(r.started||!r.players.size||![...r.players.values()].every(p=>p.ready))return;r.started=true;r.seed=crypto.randomInt(1,0x7fffffff);r.coopBoard=emptyBoard();r.coopScore=0;r.coopLines=0;r.coopCombo=0;r.coopLevel=1;r.coopNextPiece=crypto.randomInt(0,7);touch(r);for(const p of r.players.values()){p.score=0;p.alive=true;p.board=null;p.active=null}broadcast(r,{type:'start',seed:r.seed,round:r.round,mode:r.mode,nextPiece:r.coopNextPiece});broadcastState(r)}
function clearBoard(board){const rows=[];for(let y=0;y<20;y++)if(board[y].every(Boolean))rows.push(y);if(!rows.length)return rows;const survivors=board.filter((_,y)=>!rows.includes(y));while(survivors.length<20)survivors.unshift(Array(10).fill(0));for(let y=0;y<20;y++)board[y]=survivors[y];return rows}
function coopLock(r,m){
  if(!r.started||r.mode!=='coop'||Number(m.round)!==r.round||!Array.isArray(m.matrix))return;
  const p=r.players.get(m.player); if(!p)return;
  const x=Number(m.x),y=Number(m.y),c=Math.max(0,Math.min(6,Number(m.c)||0))+1;
  for(let yy=0;yy<m.matrix.length;yy++)for(let xx=0;xx<(m.matrix[yy]?.length||0);xx++)if(m.matrix[yy][xx]){
    const bx=x+xx,by=y+yy;
    if(bx>=0&&bx<10&&by>=0&&by<20)r.coopBoard[by][bx]=c;
  }
  const rows=clearBoard(r.coopBoard),n=rows.length;
  let gained=0;
  if(n){const base=[0,100,300,500,800][n]||1200;r.coopCombo++;r.coopLines+=n;r.coopLevel=1+Math.floor(r.coopLines/10);gained=base*r.coopLevel+Math.min(r.coopCombo,12)*75;r.coopScore+=gained;p.score+=gained}else r.coopCombo=0;
  r.coopNextPiece=crypto.randomInt(0,7);
  p.board=r.coopBoard.map(row=>row.slice());p.active=null;
  touch(r);
  broadcast(r,{type:'coopState',board:r.coopBoard,score:r.coopScore,lines:r.coopLines,combo:r.coopCombo,level:r.coopLevel,rows,round:r.round,nextPiece:r.coopNextPiece,by:p.id,byName:p.name,gained});
  broadcastState(r);
}
function finishRound(r,reason='gameover'){
  if(!r.started)return;
  r.started=false;
  for(const p of r.players.values()){p.ready=false;p.alive=false;p.board=null;p.active=null}
  touch(r);
  broadcast(r,{type:'roundEnd',round:r.round,reason});
  broadcastState(r);
}
function startNextRound(r){
  if(r.started||!r.players.size||![...r.players.values()].every(p=>p.ready))return false;
  r.round++;r.seed=crypto.randomInt(1,0x7fffffff);r.coopBoard=emptyBoard();r.coopScore=0;r.coopLines=0;r.coopCombo=0;r.coopLevel=1;r.coopNextPiece=crypto.randomInt(0,7);r.started=true;
  for(const p of r.players.values()){p.score=0;p.alive=true;p.board=null;p.active=null}
  touch(r);broadcast(r,{type:'roundStart',seed:r.seed,round:r.round,mode:r.mode,nextPiece:r.coopNextPiece});broadcastState(r);return true;
}

wss.on('connection',ws=>{const p={ws,id:id(),name:'Player',room:null,ready:false,score:0,alive:true,board:null,active:null};send(ws,{type:'hello',id:p.id});send(ws,{type:'lobbies',rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)});
ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(!m?.type)return;const r0=p.room?rooms.get(p.room):null;if(r0)touch(r0);
if(m.type==='lobbies'){send(ws,{type:'lobbies',rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)});return}
if(m.type==='createRoom'){leave(p);let c=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6)||code();while(rooms.has(c))c=code();const r=makeRoom(c,m.mode,p.id);p.name=cleanName(m.name);resetPlayer(p);p.room=c;r.players.set(p.id,p);rooms.set(c,r);send(ws,{type:'joined',room:c,mode:r.mode});broadcastState(r);return}
if(m.type==='joinRoom'){const c=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6),r=rooms.get(c);if(!r)return send(ws,{type:'error',message:'Room not found. Refresh the lobby list and try again.'});if(r.started)return send(ws,{type:'error',message:'That game is already running.'});if(r.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Room is full.'});leave(p);p.name=cleanName(m.name);resetPlayer(p);p.room=c;r.players.set(p.id,p);send(ws,{type:'joined',room:c,mode:r.mode});broadcastState(r);return}
if(m.type==='setReady'){const r=rooms.get(p.room);if(!r||r.started)return;p.ready=!!m.ready;broadcastState(r);startIfReady(r);return}
if(m.type==='state'){const r=rooms.get(p.room);if(!r||!r.started)return;p.score=Math.max(0,Number(m.score)||0);p.alive=m.alive!==false;p.board=Array.isArray(m.board)?m.board:null;p.active=m.active||null;broadcast(r,{type:'playerState',id:p.id,name:p.name,score:p.score,alive:p.alive,board:p.board,active:p.active});return}
if(m.type==='coopLock'){const r=rooms.get(p.room);if(r)coopLock(r,m);return}
if(m.type==='roundEnd'){const r=rooms.get(p.room);if(r&&r.started)finishRound(r,'player_game_over');return}
if(m.type==='nextRound'){const r=rooms.get(p.room);if(!r)return;p.ready=true;broadcastState(r);startNextRound(r);return}
if(m.type==='event'){const r=rooms.get(p.room);if(r)broadcast(r,{type:'gameEvent',id:p.id,event:String(m.event||'').slice(0,80)});return}
if(m.type==='leave'){leave(p);send(ws,{type:'left'});return}
});ws.on('close',()=>leave(p));ws.on('error',()=>leave(p))});
setInterval(()=>{const now=Date.now();for(const [c,r] of rooms)if(!r.players.size||now-r.lastActivity>ROOM_TTL_MS){for(const p of r.players.values())send(p.ws,{type:'roomExpired'});rooms.delete(c)}broadcastLobbies()},30000).unref();
setInterval(()=>{for(const ws of wss.clients)if(ws.readyState===1)ws.ping()},25000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Strawberry Blocks Online listening on ${PORT}`));
process.on('SIGTERM',()=>{for(const ws of wss.clients)ws.close(1001,'Server restarting');server.close(()=>process.exit(0))});
