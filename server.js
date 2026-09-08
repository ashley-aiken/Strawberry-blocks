import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 6;
const ROOM_TTL_MS = 15 * 60 * 1000;
const rooms = new Map();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.disable('x-powered-by');
app.use(express.static('public', { extensions: ['html'] }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }));
app.get('/api/lobbies', (_req, res) => res.json({ rooms: [...rooms.values()].filter(r => !r.started).map(publicLobby) }));
app.get('/{*splat}', (_req, res) => res.sendFile(process.cwd() + '/public/index.html'));

const id = () => crypto.randomBytes(6).toString('hex');
const code = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const cleanName = n => String(n || 'Player').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 18) || 'Player';
const BW = 8, BH = 8;
const emptyBoard = () => Array.from({ length: BH }, () => Array(BW).fill(0));
const BLAST_SHAPES = [[[1]],[[1,1]],[[1,1,1]],[[1,1],[1,1]],[[1,0],[1,1]],[[0,1],[1,1]],[[1,1,1],[0,1,0]],[[1,1,0],[0,1,1]],[[1,1,1,1]],[[1,0,1],[1,1,1]],[[1,1],[1,0]],[[1,1,1],[1,0,0]]];
const shapeFits = (board, m, x, y) => m.every((row,dy)=>row.every((v,dx)=>!v || (x+dx>=0&&x+dx<BW&&y+dy>=0&&y+dy<BH&&!board[y+dy][x+dx])));
const hasBlastMove = (board,pieces) => pieces.some(pi=>{const m=BLAST_SHAPES[pi]; for(let y=0;y<BH;y++) for(let x=0;x<BW;x++) if(shapeFits(board,m,x,y)) return true; return false;});
const blastClear = board => { const rows=[]; const cols=[]; for(let y=0;y<BH;y++) if(board[y].every(Boolean)) rows.push(y); for(let x=0;x<BW;x++) if(board.every(row=>row[x])) cols.push(x); if(!rows.length&&!cols.length)return 0; const cells=new Set(); rows.forEach(y=>{for(let x=0;x<BW;x++)cells.add(`${x},${y}`)}); cols.forEach(x=>{for(let y=0;y<BH;y++)cells.add(`${x},${y}`)}); for(const key of cells){const [x,y]=key.split(',').map(Number);board[y][x]=0;} return cells.size; };
const scoreFor = (cleared,level,combo) => cleared ? cleared*100*level + (combo+1)*50 : 0;
const publicLobby = r => ({ code: r.code, mode: r.mode, host: r.host, started: r.started, players: r.players.size, maxPlayers: MAX_PLAYERS, createdAt: r.createdAt, lastActivity: r.lastActivity });
const roomState = r => ({ type: 'roomState', room: r.code, mode: r.mode, host: r.host, started: r.started, round: r.round, teamScore: r.coopScore, teamLines: r.coopLines, teamCombo: r.coopCombo, teamLevel: r.coopLevel, coopSeq: r.coopSeq, coopBoard: r.mode === 'coop' ? r.coopBoard : null, players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, score: p.score, alive: p.alive, board: p.board, active: p.active })) });
const send = (ws, msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (r, msg) => { const s = JSON.stringify(msg); for (const p of r.players.values()) if (p.ws.readyState === 1) p.ws.send(s); };
const touch = r => { r.lastActivity = Date.now(); };
const broadcastLobbies = () => { const msg = { type: 'lobbies', rooms: [...rooms.values()].filter(r => !r.started).map(publicLobby) }; for (const ws of wss.clients) send(ws, msg); };
const broadcastState = r => { touch(r); broadcast(r, roomState(r)); broadcastLobbies(); };
const makeRoom = (c, mode, host) => ({ code: c, mode: mode === 'coop' ? 'coop' : 'versus', host, started: false, round: 1, seed: crypto.randomInt(1, 0x7fffffff), players: new Map(), createdAt: Date.now(), lastActivity: Date.now(), coopBoard: emptyBoard(), coopScore: 0, coopLines: 0, coopCombo: 0, coopLevel: 1, coopSeq: 0 });

function resetPlayers(r) {
  for (const p of r.players.values()) { p.ready = false; p.score = 0; p.lines=0; p.combo=0; p.level=1; p.alive = true; p.board = emptyBoard(); p.active = null; p.pieces=[]; }
}
function leave(p) {
  if (!p.room) return;
  const r = rooms.get(p.room);
  p.room = null;
  if (!r) return;
  const wasRunning = r.started;
  r.players.delete(p.id);
  if (r.host === p.id) r.host = r.players.values().next().value?.id || null;
  if (wasRunning) {
    r.started = false;
    resetPlayers(r);
    if (r.players.size) broadcast(r, { type: 'roundInterrupted', round: r.round, reason: 'A player left the game.' });
  }
  if (!r.players.size) rooms.delete(r.code); else broadcastState(r);
  broadcastLobbies();
}
function randomPieces(seed) { const r = seeded(seed); return [0,1,2].map(() => Math.floor(r()*BLAST_SHAPES.length)); }
function seeded(s){let a=(s>>>0)||1;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function resetPlayerBlast(p, r) { p.board = emptyBoard(); p.score=0; p.lines=0; p.combo=0; p.level=1; p.alive=true; p.pieces=r.pieces.slice(); }
function beginRound(r, isNext = false) {
  if (!r.players.size || [...r.players.values()].some(p => !p.ready)) return false;
  r.started=true; if(isNext) r.round+=1; r.seed=crypto.randomInt(1,0x7fffffff); r.pieces=randomPieces(r.seed);
  r.coopBoard=emptyBoard(); r.coopScore=0; r.coopLines=0; r.coopCombo=0; r.coopLevel=1; r.coopSeq=0;
  for(const p of r.players.values()) resetPlayerBlast(p,r);
  touch(r);
  broadcast(r,{type:isNext?'roundStart':'start',seed:r.seed,round:r.round,mode:r.mode,pieces:r.pieces});
  broadcastState(r); return true;
}
function blastPlace(r,p,m){
  if(!r.started || !p || Number(m.round)!==r.round) return;
  const slot=Number(m.slot), pi=Number(m.piece), x=Number(m.x), y=Number(m.y);
  if(slot<0||slot>2||!Number.isInteger(pi)||pi!==p.pieces[slot]||!BLAST_SHAPES[pi]) return send(p.ws,{type:'blastReject',round:r.round,board:p.board,pieces:p.pieces,score:p.score,lines:p.lines,combo:p.combo,level:p.level});
  const target=r.mode==='coop'?r.coopBoard:p.board, shape=BLAST_SHAPES[pi];
  if(!shapeFits(target,shape,x,y)) return send(p.ws,{type:'blastReject',round:r.round,board:target,pieces:p.pieces,score:r.mode==='coop'?r.coopScore:p.score,lines:r.mode==='coop'?r.coopLines:p.lines,combo:r.mode==='coop'?r.coopCombo:p.combo,level:r.mode==='coop'?r.coopLevel:p.level});
  for(let yy=0;yy<shape.length;yy++)for(let xx=0;xx<shape[yy].length;xx++)if(shape[yy][xx])target[y+yy][x+xx]=(pi%7)+1;
  const cleared=blastClear(target), state=r.mode==='coop'?r:null;
  if(r.mode==='coop'){
    if(cleared){r.coopCombo++;r.coopLines+=cleared;r.coopLevel=1+Math.floor(r.coopLines/8);const gained=scoreFor(cleared,r.coopLevel,r.coopCombo-1);r.coopScore+=gained;p.score+=gained;}else r.coopCombo=0;
  }else{
    if(cleared){p.combo++;p.lines+=cleared;p.level=1+Math.floor(p.lines/8);p.score+=scoreFor(cleared,p.level,p.combo-1);}else p.combo=0;
  }
  p.pieces[slot]=randomPieces(Date.now()+r.coopSeq+Math.random()*1e6)[0];
  if(r.mode==='coop'){
    r.pieces[slot]=p.pieces[slot]; r.coopSeq++;
    for(const q of r.players.values()){q.board=r.coopBoard.map(row=>row.slice());q.pieces=r.pieces.slice();}
    const aliveMoves=hasBlastMove(r.coopBoard,r.pieces); if(!aliveMoves) return finishRound(r,'No more moves');
    broadcast(r,{type:'blastState',board:r.coopBoard,pieces:r.pieces,seq:r.coopSeq,score:r.coopScore,lines:r.coopLines,combo:r.coopCombo,level:r.coopLevel,rows:cleared,round:r.round,by:p.id,byName:p.name,gained:cleared?scoreFor(cleared,r.coopLevel,r.coopCombo-1):0});
  }else{
    if(!hasBlastMove(p.board,p.pieces)) p.alive=false;
    send(p.ws,{type:'blastState',board:p.board,pieces:p.pieces,seq:(p.seq||0)+1,score:p.score,lines:p.lines,combo:p.combo,level:p.level,rows:cleared,round:r.round,by:p.id,byName:p.name,gained:cleared?scoreFor(cleared,p.level,p.combo-1):0,alive:p.alive});
    broadcast(r,{type:'playerState',id:p.id,name:p.name,score:p.score,alive:p.alive,board:p.board,active:null});
    if([...r.players.values()].every(q=>q.alive===false)) finishRound(r,'All players are out');
  }
  touch(r); broadcastState(r);
}
function finishRound(r, reason='gameover') { if(!r.started)return; r.started=false; for(const p of r.players.values()){p.ready=false;p.alive=false;p.active=null;} touch(r); broadcast(r,{type:'roundEnd',round:r.round,reason,score:r.mode==='coop'?r.coopScore:0,lines:r.mode==='coop'?r.coopLines:0}); broadcastState(r); }

wss.on('connection', ws => {
  const p = { ws, id: id(), name: 'Player', room: null, ready: false, score: 0, lines: 0, combo: 0, level: 1, alive: true, board: emptyBoard(), active: null, pieces: [] };
  send(ws, { type: 'hello', id: p.id });
  send(ws, { type: 'lobbies', rooms: [...rooms.values()].filter(r => !r.started).map(publicLobby) });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m?.type) return;
    const r0 = p.room ? rooms.get(p.room) : null; if (r0) touch(r0);
    if (m.type === 'lobbies') { send(ws, { type: 'lobbies', rooms: [...rooms.values()].filter(r => !r.started).map(publicLobby) }); return; }
    if (m.type === 'createRoom') {
      leave(p); let c = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || code(); while (rooms.has(c)) c = code();
      const r = makeRoom(c, m.mode, p.id); p.name = cleanName(m.name); p.room = c; p.ready = false; p.score = 0; p.lines=0; p.combo=0; p.level=1; p.alive = true; p.board = emptyBoard(); p.active = null; p.pieces=[]; r.players.set(p.id, p); rooms.set(c, r);
      send(ws, { type: 'joined', room: c, mode: r.mode }); broadcastState(r); return;
    }
    if (m.type === 'joinRoom') {
      const c = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6), r = rooms.get(c);
      if (!r) return send(ws, { type: 'error', message: 'Room not found. Refresh the lobby list and try again.' });
      if (r.started) return send(ws, { type: 'error', message: 'That game is already running.' });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Room is full.' });
      leave(p); p.name = cleanName(m.name); p.room = c; p.ready = false; p.score = 0; p.lines=0; p.combo=0; p.level=1; p.alive = true; p.board = emptyBoard(); p.active = null; p.pieces=[]; r.players.set(p.id, p);
      send(ws, { type: 'joined', room: c, mode: r.mode }); broadcastState(r); return;
    }
    if (m.type === 'setReady') { const r = rooms.get(p.room); if (!r || r.started) return; p.ready = !!m.ready; broadcastState(r); if ([...r.players.values()].every(q => q.ready)) beginRound(r); return; }
    if (m.type === 'nextRound') { const r = rooms.get(p.room); if (!r || r.started) return; p.ready = true; broadcastState(r); if ([...r.players.values()].every(q => q.ready)) beginRound(r, true); return; }
    if (m.type === 'state') return;
    if (m.type === 'blastPlace') { const r = rooms.get(p.room); if (r) blastPlace(r,p,m); return; }
    if (m.type === 'roundEnd') { const r = rooms.get(p.room); if (r?.started) finishRound(r, 'player_game_over'); return; }
    if (m.type === 'leave') { leave(p); send(ws, { type: 'left' }); return; }
  });
  ws.on('close', () => leave(p));
  ws.on('error', () => leave(p));
});
setInterval(() => { const now = Date.now(); for (const [c, r] of rooms) if (!r.players.size || now - r.lastActivity > ROOM_TTL_MS) { for (const p of r.players.values()) send(p.ws, { type: 'roomExpired' }); rooms.delete(c); } broadcastLobbies(); }, 30000).unref();
setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25000).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Strawberry Blocks Online listening on ${PORT}`));
process.on('SIGTERM', () => { for (const ws of wss.clients) ws.close(1001, 'Server restarting'); server.close(() => process.exit(0)); });
