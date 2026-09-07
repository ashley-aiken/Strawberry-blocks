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
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) }));
app.get('/api/lobbies', (_req, res) => res.json({ rooms: [...rooms.values()].map(publicLobby) }));
app.get('/{*splat}', (_req, res) => res.sendFile(process.cwd() + '/public/index.html'));

function id() { return crypto.randomBytes(6).toString('hex'); }
function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function cleanName(n) { return String(n || 'Player').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 18) || 'Player'; }
function publicLobby(r) { return { code: r.code, mode: r.mode, host: r.host, started: r.started, players: r.players.size, maxPlayers: MAX_PLAYERS, createdAt: r.createdAt, lastActivity: r.lastActivity }; }
function roomState(r) {
  return { type: 'roomState', room: r.code, mode: r.mode, host: r.host, started: r.started,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready, score: p.score, alive: p.alive, board: p.board || null, active: p.active || null })) };
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg) { const s = JSON.stringify(msg); for (const p of r.players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function touch(r) { r.lastActivity = Date.now(); }
function broadcastState(r) { touch(r); broadcast(r, roomState(r)); }
function makeRoom(c, mode, host) { return { code: c, mode: mode === 'coop' ? 'coop' : 'versus', host, started: false, seed: crypto.randomInt(1, 0x7fffffff), players: new Map(), createdAt: Date.now(), lastActivity: Date.now() }; }
function leave(p) {
  if (!p.room) return;
  const r = rooms.get(p.room);
  p.room = null;
  if (!r) return;
  r.players.delete(p.id);
  if (r.host === p.id) r.host = r.players.values().next().value?.id || null;
  if (r.started) r.started = false;
  if (!r.players.size) rooms.delete(r.code); else broadcastState(r);
}
function resetPlayer(p) { p.ready = false; p.score = 0; p.alive = true; p.board = null; p.active = null; }
function startIfReady(r) {
  if (r.started || !r.players.size) return;
  if (![...r.players.values()].every(p => p.ready)) return;
  r.started = true; r.seed = crypto.randomInt(1, 0x7fffffff); touch(r);
  for (const p of r.players.values()) { p.score = 0; p.alive = true; p.board = null; p.active = null; }
  broadcast(r, { type: 'start', seed: r.seed, mode: r.mode });
  broadcastState(r);
}

wss.on('connection', ws => {
  const p = { ws, id: id(), name: 'Player', room: null, ready: false, score: 0, alive: true, board: null, active: null };
  send(ws, { type: 'hello', id: p.id });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m?.type) return;
    const r0 = p.room ? rooms.get(p.room) : null;
    if (r0) touch(r0);

    if (m.type === 'lobbies') {
      send(ws, { type: 'lobbies', rooms: [...rooms.values()].filter(r => !r.started).map(publicLobby) });
      return;
    }
    if (m.type === 'createRoom') {
      leave(p);
      let c = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || code();
      while (rooms.has(c)) c = code();
      const r = makeRoom(c, m.mode, p.id);
      p.name = cleanName(m.name); resetPlayer(p); p.room = c;
      r.players.set(p.id, p); rooms.set(c, r);
      send(ws, { type: 'joined', room: c, mode: r.mode }); broadcastState(r); return;
    }
    if (m.type === 'joinRoom') {
      const c = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const r = rooms.get(c);
      if (!r) return send(ws, { type: 'error', message: 'Room not found. Refresh the lobby list and try again.' });
      if (r.started) return send(ws, { type: 'error', message: 'That game is already running.' });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Room is full.' });
      leave(p); p.name = cleanName(m.name); resetPlayer(p); p.room = c; r.players.set(p.id, p);
      send(ws, { type: 'joined', room: c, mode: r.mode }); broadcastState(r); return;
    }
    if (m.type === 'setReady') {
      const r = rooms.get(p.room); if (!r || r.started) return;
      p.ready = !!m.ready; broadcastState(r); startIfReady(r); return;
    }
    if (m.type === 'state') {
      const r = rooms.get(p.room); if (!r || !r.started) return;
      p.score = Math.max(0, Number(m.score) || 0); p.alive = m.alive !== false; p.board = Array.isArray(m.board) ? m.board : null; p.active = m.active || null;
      broadcast(r, { type: 'playerState', id: p.id, name: p.name, score: p.score, alive: p.alive, board: p.board, active: p.active }); return;
    }
    if (m.type === 'event') { const r = rooms.get(p.room); if (r) broadcast(r, { type: 'gameEvent', id: p.id, event: String(m.event || '').slice(0, 80) }); return; }
    if (m.type === 'leave') { leave(p); send(ws, { type: 'left' }); }
  });
  ws.on('close', () => leave(p));
  ws.on('error', () => leave(p));
});

setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    if (!r.players.size || now - r.lastActivity > ROOM_TTL_MS) { for (const p of r.players.values()) send(p.ws, { type: 'roomExpired' }); rooms.delete(c); }
  }
}, 30_000).unref();

setInterval(() => { for (const ws of wss.clients) if (ws.readyState === 1) ws.ping(); }, 25_000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`Neon Blocks Online listening on ${PORT}`));
process.on('SIGTERM', () => { for (const ws of wss.clients) ws.close(1001, 'Server restarting'); server.close(() => process.exit(0)); });
