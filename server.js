import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const PORT=Number(process.env.PORT||10000),MAX_PLAYERS=6,ROOM_TTL_MS=15*60*1000;
const rooms=new Map(),app=express(),server=http.createServer(app),wss=new WebSocketServer({server});
app.disable('x-powered-by'); app.use(express.static('public',{extensions:['html']}));
app.get('/health',(_q,res)=>res.json({ok:true,rooms:rooms.size,players:[...rooms.values()].reduce((n,r)=>n+r.players.size,0)}));
app.get('/api/seed',(_q,res)=>res.json({seed:crypto.randomInt(1,0x7fffffff),serverTime:Date.now()}));
app.get('/api/lobbies',(_q,res)=>res.json({rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)}));
app.get('/{*splat}',(_q,res)=>res.sendFile(process.cwd()+'/public/index.html'));
const id=()=>crypto.randomBytes(6).toString('hex'), code=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
const cleanName=n=>String(n||'Player').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,18)||'Player';
const emptyBoard=()=>Array.from({length:8},()=>Array(8).fill(0));
const SHAPES=[[[1]],[[1,1]],[[1,1,1]],[[1,1,1,1]],[[1],[1],[1]],[[1],[1],[1],[1]],[[1,1],[1,1]],[[1,0],[1,1]],[[0,1],[1,1]],[[1,1],[1,0]],[[1,1],[0,1]],[[1,1,1],[0,1,0]],[[0,1,0],[1,1,1]],[[1,0,0],[1,1,1]],[[0,0,1],[1,1,1]],[[1,1,0],[0,1,1]],[[0,1,1],[1,1,0]],[[1,1,1],[1,0,0]],[[1,0,0],[1,1,1]],[[1,1,1],[0,0,1]],[[1,1,1],[1,1,0]],[[1,1,0],[1,1,1]],[[1,1,1],[1,1,1]],[[1,1,1,1,1]],[[1],[1],[1],[1],[1]],[[1,0,1],[1,1,1]],[[1,1,1],[1,0,1]]];
const rngStep=a=>{let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return [(t^t>>>14)>>>0,a]};
function makePieces(seed){let a=seed,p=[];for(let i=0;i<3;i++){let z=rngStep(a);a=z[1];p.push(SHAPES[z[0]%SHAPES.length].map(r=>r.slice()))}return {pieces:p,seed:a}}
const publicLobby=r=>({code:r.code,mode:r.mode,host:r.host,started:r.started,players:r.players.size,maxPlayers:MAX_PLAYERS,createdAt:r.createdAt,lastActivity:r.lastActivity});
const roomState=r=>({type:'roomState',room:r.code,mode:r.mode,host:r.host,started:r.started,round:r.round,teamScore:r.coopScore,teamLines:r.coopLines,teamCombo:r.coopCombo,teamLevel:r.coopLevel,coopSeq:r.coopSeq,coopBoard:r.mode==='coop'?r.coopBoard:null,coopPieces:r.mode==='coop'?r.coopPieces:null,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,ready:p.ready,score:p.score,alive:p.alive,board:p.board,active:p.active}))});
const send=(ws,msg)=>{if(ws?.readyState===1)ws.send(JSON.stringify(msg))};
const broadcast=(r,msg)=>{const s=JSON.stringify(msg);for(const p of r.players.values())if(p.ws.readyState===1)p.ws.send(s)};
const touch=r=>{r.lastActivity=Date.now()};
const broadcastLobbies=()=>{const msg={type:'lobbies',rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)};for(const ws of wss.clients)send(ws,msg)};
const broadcastState=r=>{touch(r);broadcast(r,roomState(r));broadcastLobbies()};
const makeRoom=(c,mode,host)=>({code:c,mode:mode==='coop'?'coop':'versus',host,started:false,round:1,seed:crypto.randomInt(1,0x7fffffff),players:new Map(),createdAt:Date.now(),lastActivity:Date.now(),coopBoard:emptyBoard(),coopScore:0,coopLines:0,coopCombo:0,coopLevel:1,coopSeq:0,coopPieces:[]});
function resetPlayers(r){for(const p of r.players.values()){p.ready=false;p.score=0;p.alive=true;p.board=r.mode==='coop'?r.coopBoard.map(x=>x.slice()):emptyBoard();p.active=null}}
function leave(p){if(!p.room)return;const r=rooms.get(p.room);p.room=null;if(!r)return;const running=r.started;r.players.delete(p.id);if(r.host===p.id)r.host=r.players.values().next().value?.id||null;if(running){r.started=false;resetPlayers(r);if(r.players.size)broadcast(r,{type:'roundInterrupted',round:r.round,reason:'A player left the game.'})}if(!r.players.size)rooms.delete(r.code);else broadcastState(r);broadcastLobbies()}
function beginRound(r,next=false){if(!r.players.size||[...r.players.values()].some(p=>!p.ready))return false;r.started=true;if(next)r.round++;r.seed=crypto.randomInt(1,0x7fffffff);r.coopBoard=emptyBoard();r.coopScore=0;r.coopLines=0;r.coopCombo=0;r.coopLevel=1;r.coopSeq=0;const mp=makePieces(r.seed);r.coopPieces=mp.pieces;r.pieceSeed=mp.seed;resetPlayers(r);for(const p of r.players.values())p.ready=true;broadcast(r,{type:next?'roundStart':'start',seed:r.seed,round:r.round,mode:r.mode,pieces:r.coopPieces});broadcastState(r);return true}
function clearBoard(board){const full=[];for(let y=0;y<8;y++)if(board[y].every(Boolean))full.push(y);for(let x=0;x<8;x++)if(board.every(row=>row[x]))full.push(8+x);const rows=[...new Set(full.filter(n=>n<8))],cols=[...new Set(full.filter(n=>n>=8).map(n=>n-8))];if(!full.length)return{rows:[],cols:[]};for(const y of rows)for(let x=0;x<8;x++)board[y][x]=0;for(const x of cols)for(let y=0;y<8;y++)board[y][x]=0;return{rows,cols}}
function fits(board,matrix,x,y){for(let yy=0;yy<matrix.length;yy++)for(let xx=0;xx<(matrix[yy]?.length||0);xx++)if(matrix[yy][xx]){const bx=x+xx,by=y+yy;if(bx<0||bx>=8||by<0||by>=8||board[by][bx])return false}return true}
function coopLock(r,m){if(!r.started||r.mode!=='coop'||!Array.isArray(m.matrix)||Number(m.round)!==r.round)return;const p=r.players.get(m.player);if(!p)return;const matrix=m.matrix.map(row=>Array.isArray(row)?row.map(v=>v?1:0):[]),x=Math.trunc(Number(m.x)||0),y=Math.trunc(Number(m.y)||0);if(!fits(r.coopBoard,matrix,x,y)){return send(p.ws,{type:'coopSync',board:r.coopBoard,seq:r.coopSeq,score:r.coopScore,lines:r.coopLines,combo:r.coopCombo,level:r.coopLevel,pieces:r.coopPieces,round:r.round,reject:true})}const slot=Math.max(0,Math.min(2,Number(m.slot)||0));
  const expected=r.coopPieces[slot];
  if(!expected||JSON.stringify(expected)!==JSON.stringify(matrix)){return send(p.ws,{type:'coopSync',board:r.coopBoard,seq:r.coopSeq,score:r.coopScore,lines:r.coopLines,combo:r.coopCombo,level:r.coopLevel,pieces:r.coopPieces,round:r.round,reject:true})}
  const c=Math.max(1,Math.min(7,slot+1));for(let yy=0;yy<matrix.length;yy++)for(let xx=0;xx<(matrix[yy]?.length||0);xx++)if(matrix[yy][xx])r.coopBoard[y+yy][x+xx]=c;const cleared=clearBoard(r.coopBoard),n=cleared.rows.length+cleared.cols.length;let gained=0;if(n){const base=[0,100,300,500,800,1100,1500,2000,2600][n]||3200;r.coopCombo++;r.coopLines+=n;r.coopLevel=1+Math.floor(r.coopLines/8);gained=base*r.coopLevel+Math.min(r.coopCombo,12)*75;r.coopScore+=gained;p.score+=gained}else r.coopCombo=0;r.coopSeq++;let z=rngStep(r.pieceSeed);r.pieceSeed=z[1];r.coopPieces[slot]=SHAPES[z[0]%SHAPES.length].map(row=>row.slice());for(const q of r.players.values()){q.board=r.coopBoard.map(x=>x.slice());q.active=null}touch(r);broadcast(r,{type:'coopState',board:r.coopBoard,seq:r.coopSeq,score:r.coopScore,lines:r.coopLines,combo:r.coopCombo,level:r.coopLevel,rows:cleared.rows,cols:cleared.cols,round:r.round,by:p.id,byName:p.name,gained,pieces:r.coopPieces});broadcastState(r)}
function finishRound(r,reason='gameover'){if(!r.started)return;r.started=false;for(const p of r.players.values()){p.ready=false;p.alive=false;p.active=null}touch(r);broadcast(r,{type:'roundEnd',round:r.round,reason,score:r.coopScore,lines:r.coopLines});broadcastState(r)}
wss.on('connection',ws=>{const p={ws,id:id(),name:'Player',room:null,ready:false,score:0,alive:true,board:null,active:null};send(ws,{type:'hello',id:p.id});send(ws,{type:'lobbies',rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)});
ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(!m?.type)return;const r0=p.room?rooms.get(p.room):null;if(r0)touch(r0);
if(m.type==='lobbies')return send(ws,{type:'lobbies',rooms:[...rooms.values()].filter(r=>!r.started).map(publicLobby)});
if(m.type==='createRoom'){leave(p);let c=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6)||code();while(rooms.has(c))c=code();const r=makeRoom(c,m.mode,p.id);p.name=cleanName(m.name);p.room=c;r.players.set(p.id,p);rooms.set(c,r);send(ws,{type:'joined',room:c,mode:r.mode});return broadcastState(r)}
if(m.type==='joinRoom'){const c=String(m.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6),r=rooms.get(c);if(!r)return send(ws,{type:'error',message:'Room not found. Refresh the lobby list.'});if(r.started)return send(ws,{type:'error',message:'That game is already running.'});if(r.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'Room is full.'});leave(p);p.name=cleanName(m.name);p.room=c;p.ready=false;p.score=0;p.alive=true;p.board=emptyBoard();r.players.set(p.id,p);send(ws,{type:'joined',room:c,mode:r.mode});return broadcastState(r)}
if(m.type==='setReady'){const r=rooms.get(p.room);if(!r||r.started)return;p.ready=!!m.ready;broadcastState(r);if(r.players.size&&[...r.players.values()].every(q=>q.ready))beginRound(r);return}
if(m.type==='nextRound'){const r=rooms.get(p.room);if(!r||r.started)return;p.ready=true;broadcastState(r);if([...r.players.values()].every(q=>q.ready))beginRound(r,true);return}
if(m.type==='state'){const r=rooms.get(p.room);if(!r||!r.started||r.mode!=='versus')return;p.score=Math.max(0,Number(m.score)||0);p.alive=m.alive!==false;p.board=Array.isArray(m.board)?m.board:p.board;p.active=m.active||null;broadcast(r,{type:'playerState',id:p.id,name:p.name,score:p.score,alive:p.alive,board:p.board,active:p.active});broadcastState(r);return}
if(m.type==='coopLock'){const r=rooms.get(p.room);if(r)coopLock(r,m);return}
if(m.type==='roundEnd'){const r=rooms.get(p.room);if(r?.started)finishRound(r,'player_game_over');return}
if(m.type==='leave'){leave(p);send(ws,{type:'left'});return}
});ws.on('close',()=>leave(p));ws.on('error',()=>leave(p))});
setInterval(()=>{const now=Date.now();for(const[c,r]of rooms)if(!r.players.size||now-r.lastActivity>ROOM_TTL_MS){for(const p of r.players.values())send(p.ws,{type:'roomExpired'});rooms.delete(c)}broadcastLobbies()},30000).unref();
setInterval(()=>{for(const ws of wss.clients)if(ws.readyState===1)ws.ping()},25000).unref();server.listen(PORT,'0.0.0.0',()=>console.log(`Strawberry Blocks Online listening on ${PORT}`));
process.on('SIGTERM',()=>{for(const ws of wss.clients)ws.close(1001,'Server restarting');server.close(()=>process.exit(0))});
