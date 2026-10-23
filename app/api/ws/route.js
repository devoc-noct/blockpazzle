import { experimental_upgradeWebSocket } from '@vercel/functions';
import Redis from 'ioredis';
import { randomInt, randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

const CHANNEL = 'block-puzzle:events:v1';
const ROOM_PREFIX = 'block-puzzle:room:';
const ROOM_TTL_SECONDS = 60 * 60;

// Each Vercel Function instance keeps only its own live sockets here.
// Redis Pub/Sub relays events between instances; Redis keys hold shared room state.
const root = globalThis;
root.__blockPuzzleLocalRooms ??= new Map();
root.__blockPuzzleRedis ??= null;
root.__blockPuzzleSubscriber ??= null;
root.__blockPuzzleSubscriberPromise ??= null;

function redisOptions() {
  return {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 250, 3000),
    connectTimeout: 10000,
  };
}

function getRedis() {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL_MISSING');
  if (!root.__blockPuzzleRedis) root.__blockPuzzleRedis = new Redis(process.env.REDIS_URL, redisOptions());
  return root.__blockPuzzleRedis;
}

function send(ws, message) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(message)); } catch { /* disconnected */ }
  }
}

function localAdd(code, ws) {
  const rooms = root.__blockPuzzleLocalRooms;
  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);
}

function localRemove(code, ws) {
  if (!code) return;
  const rooms = root.__blockPuzzleLocalRooms;
  const set = rooms.get(code);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(code);
}

async function ensureSubscriber() {
  if (root.__blockPuzzleSubscriberPromise) return root.__blockPuzzleSubscriberPromise;
  root.__blockPuzzleSubscriberPromise = (async () => {
    const sub = new Redis(process.env.REDIS_URL, redisOptions());
    sub.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      let packet;
      try { packet = JSON.parse(raw); } catch { return; }
      const sockets = root.__blockPuzzleLocalRooms.get(packet.code);
      if (!sockets) return;
      for (const peer of sockets) {
        if (packet.targetId && peer.bpId !== packet.targetId) continue;
        if (packet.excludeId && peer.bpId === packet.excludeId) continue;
        send(peer, packet.message);
      }
    });
    await sub.subscribe(CHANNEL);
    root.__blockPuzzleSubscriber = sub;
    return sub;
  })().catch((error) => {
    root.__blockPuzzleSubscriberPromise = null;
    throw error;
  });
  return root.__blockPuzzleSubscriberPromise;
}

async function publish(code, message, options = {}) {
  const packet = { code, message, ...options };
  await getRedis().publish(CHANNEL, JSON.stringify(packet));
}

function roomKey(code) { return ROOM_PREFIX + code; }

async function createRoom(ws) {
  const redis = getRedis();
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = String(randomInt(1000, 10000));
    const room = { players: [ws.bpId], started: false, createdAt: Date.now() };
    const result = await redis.set(roomKey(code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS, 'NX');
    if (result === 'OK') {
      ws.bpRoom = code;
      localAdd(code, ws);
      send(ws, { type: 'created', code });
      return;
    }
  }
  send(ws, { type: 'error', message: '部屋を作成できませんでした。もう一度試してね。' });
}

const JOIN_ROOM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_FOUND' end
local room = cjson.decode(raw)
if #room.players >= 2 then return 'FULL' end
table.insert(room.players, ARGV[1])
room.started = (#room.players == 2)
redis.call('SET', KEYS[1], cjson.encode(room), 'EX', ARGV[2])
return cjson.encode(room)
`;

async function joinRoom(ws, inputCode) {
  const code = String(inputCode || '');
  if (!/^\d{4}$/.test(code)) {
    send(ws, { type: 'error', message: '4桁の部屋番号を入力してね。' });
    return;
  }
  const raw = await getRedis().eval(JOIN_ROOM_SCRIPT, 1, roomKey(code), ws.bpId, String(ROOM_TTL_SECONDS));
  if (raw === 'NOT_FOUND') {
    send(ws, { type: 'error', message: 'その部屋は見つかりません。番号を確認してね。' });
    return;
  }
  if (raw === 'FULL') {
    send(ws, { type: 'error', message: 'その部屋は満員です。' });
    return;
  }
  const room = JSON.parse(raw);
  ws.bpRoom = code;
  localAdd(code, ws);
  for (let i = 0; i < room.players.length; i++) {
    await publish(code, { type: 'paired', code, player: i + 1 }, { targetId: room.players[i] });
  }
  if (room.players.length === 2) await publish(code, { type: 'start' });
}

const LEAVE_ROOM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local room = cjson.decode(raw)
local players = {}
for _, player in ipairs(room.players) do
  if player ~= ARGV[1] then table.insert(players, player) end
end
room.players = players
if #players == 0 then
  redis.call('DEL', KEYS[1])
  return ''
end
room.started = false
redis.call('SET', KEYS[1], cjson.encode(room), 'EX', ARGV[2])
return cjson.encode(room)
`;

async function leaveRoom(ws) {
  const code = ws.bpRoom;
  if (!code) return;
  ws.bpRoom = null;
  localRemove(code, ws);
  try {
    const raw = await getRedis().eval(LEAVE_ROOM_SCRIPT, 1, roomKey(code), ws.bpId, String(ROOM_TTL_SECONDS));
    if (raw) await publish(code, { type: 'opponent-left' }, { excludeId: ws.bpId });
  } catch (error) {
    console.error('[block-puzzle] leave failed:', error?.message || error);
  }
}

async function handleMessage(ws, raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
  const text = raw.toString();
  if (text.length > 4096) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  await ensureSubscriber();

  if (message.type === 'create') {
    await leaveRoom(ws);
    return createRoom(ws);
  }
  if (message.type === 'join') {
    await leaveRoom(ws);
    return joinRoom(ws, message.code);
  }

  const code = ws.bpRoom;
  if (!code) return;
  if (message.type === 'leave') return leaveRoom(ws);
  if (message.type === 'state') {
    return publish(code, {
      type: 'state',
      score: Math.max(0, Math.min(999999999, Number(message.score) || 0)),
      lines: Math.max(0, Math.min(999999, Number(message.lines) || 0)),
      level: Math.max(1, Math.min(999, Number(message.level) || 1)),
      gameOver: Boolean(message.gameOver),
    }, { excludeId: ws.bpId });
  }
  if (message.type === 'attack') {
    const lines = Math.max(0, Math.min(4, Number(message.lines) || 0));
    if (lines > 0) return publish(code, { type: 'attack', lines }, { excludeId: ws.bpId });
  }
}

export async function GET() {
  if (!process.env.REDIS_URL) {
    return new Response('ブロックパズルの通信設定が未完了です。Vercelの環境変数 REDIS_URL を設定してください。', { status: 503 });
  }

  return experimental_upgradeWebSocket((ws) => {
    ws.bpId = randomUUID();
    ws.bpRoom = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      void leaveRoom(ws);
    };
    ws.on('message', (data) => {
      void handleMessage(ws, data).catch((error) => {
        console.error('[block-puzzle] message failed:', error?.message || error);
        send(ws, { type: 'error', message: '通信エラーが発生しました。少し待ってから試してね。' });
      });
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}
