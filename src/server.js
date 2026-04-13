import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import soul from './soul-file.js';
import engine from './engine.js';
import memory from './memory.js';
import observer from './observer.js';
import diary from './diary.js';
import provider from './provider.js';

// ---------------------------------------------------------------------------
// Load .env file (simple parser, no dependency)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10MB (screenshots can be large)
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
const routes = {};

// POST /observe — screen observation
routes['POST /observe'] = async (req, res) => {
  const body = await readBody(req);
  if (!body) return json(res, { ok: false, error: 'Invalid JSON' }, 400);

  const result = await observer.observe({
    screenshot: body.screenshot,
    foregroundApp: body.foregroundApp,
    windowTitle: body.windowTitle,
    trigger: body.trigger || 'periodic',
  });
  json(res, result);
};

// POST /chat — talk to the pet
routes['POST /chat'] = async (req, res) => {
  const body = await readBody(req);
  if (!body?.message) return json(res, { ok: false, error: 'Missing message' }, 400);

  const result = await observer.chat(body.message);
  json(res, result);
};

// POST /onboarding/chat — conversational onboarding (first meeting)
routes['POST /onboarding/chat'] = async (req, res) => {
  const body = await readBody(req);
  if (!body) return json(res, { ok: false, error: 'Invalid JSON' }, 400);

  const { message, history } = body;
  const result = await observer.onboardingChat(message, history || []);
  json(res, result);
};

// POST /react — user clicked pet, read screen + respond as friend (screenshot included)
routes['POST /react'] = async (req, res) => {
  const body = await readBody(req);
  const result = await observer.reactToScreen({
    screenshot: body?.screenshot,
    foregroundApp: body?.foregroundApp,
    windowTitle: body?.windowTitle,
  });
  json(res, result);
};

// GET /proactive — heartbeat: pet decides if it wants to say something
routes['GET /proactive'] = async (_req, res) => {
  const result = await observer.heartbeat();
  if (result && result.commentary) {
    json(res, { ok: true, commentary: result.commentary, mood: { ...soul.get().mood }, action: result.action || 'speech-bubble', duration: 10000 });
  } else {
    json(res, { ok: true, commentary: '', action: 'none' });
  }
};

// GET /chat/history — get full conversation history for chat window
routes['GET /chat/history'] = async (_req, res) => {
  const history = observer.getChatHistory();
  json(res, { ok: true, ...history });
};

// POST /mood/event — report lifecycle events
routes['POST /mood/event'] = async (req, res) => {
  const body = await readBody(req);
  if (!body?.event) return json(res, { ok: false, error: 'Missing event' }, 400);

  engine.applyEvent(body.event);
  json(res, { ok: true, mood: { ...soul.get().mood } });
};

// GET /diary — get diary for a date
routes['GET /diary'] = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const entry = memory.getDiary(date);
  if (entry) {
    json(res, { ok: true, ...entry });
  } else {
    json(res, { ok: true, date, content: null });
  }
};

// GET /diary/list — recent diary entries
routes['GET /diary/list'] = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') || '7', 10);
  const entries = memory.listDiary(limit);
  json(res, { ok: true, entries });
};

// POST /diary/generate — force diary generation
routes['POST /diary/generate'] = async (req, res) => {
  const body = await readBody(req);
  const date = body?.date || undefined;
  const result = await diary.generate(date);
  json(res, result);
};

// GET /memory/recent — recent episodic memories
routes['GET /memory/recent'] = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  const episodes = memory.getRecent(limit);
  json(res, { ok: true, episodes });
};

// POST /memory/consolidate — manually trigger nightly memory consolidation
routes['POST /memory/consolidate'] = async (_req, res) => {
  const result = await engine.consolidateMemories();
  json(res, result);
};

// GET /memory/search — search memories
routes['GET /memory/search'] = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams.get('q');
  if (!q) return json(res, { ok: false, error: 'Missing query parameter q' }, 400);

  const results = await memory.search(q, 10);
  json(res, { ok: true, results });
};

// GET /soul — export soul file
routes['GET /soul'] = async (_req, res) => {
  json(res, { ok: true, soul: soul.exportSoul() });
};

// POST /soul/import — import soul file
routes['POST /soul/import'] = async (req, res) => {
  const body = await readBody(req);
  if (!body?.soul) return json(res, { ok: false, error: 'Missing soul data' }, 400);

  try {
    const imported = soul.importSoul(body.soul);
    json(res, { ok: true, soul: imported });
  } catch (err) {
    json(res, { ok: false, error: err.message }, 400);
  }
};

// GET /config — get config (no secrets)
routes['GET /config'] = async (_req, res) => {
  json(res, { ok: true, config: config.getSafe() });
};

// PUT /config — update config
routes['PUT /config'] = async (req, res) => {
  const body = await readBody(req);
  if (!body) return json(res, { ok: false, error: 'Invalid JSON' }, 400);

  config.update(body);
  json(res, { ok: true, config: config.getSafe() });
};

// PUT /soul/archetype — set personality archetype
routes['PUT /soul/archetype'] = async (req, res) => {
  const body = await readBody(req);
  if (!body?.archetype) return json(res, { ok: false, error: 'Missing archetype' }, 400);

  const valid = ['playful', 'curious', 'caring', 'snarky', 'chill'];
  if (!valid.includes(body.archetype)) {
    return json(res, { ok: false, error: `Invalid archetype. Valid: ${valid.join(', ')}` }, 400);
  }

  const s = soul.get();
  s.archetype = body.archetype;
  s.evolvedTraits = {}; // reset traits on archetype change
  soul.save();
  json(res, { ok: true, archetype: s.archetype });
};

// POST /config/test-key — test API key
routes['POST /config/test-key'] = async (req, res) => {
  const body = await readBody(req);
  if (!body?.provider || !body?.key) return json(res, { ok: false, error: 'Missing provider or key' }, 400);

  const result = await provider.testKey(body.provider, {
    key: body.key,
    endpoint: body.endpoint,
    deployment: body.deployment,
    apiVersion: body.apiVersion,
  });
  json(res, result);
};

// GET /health — health check
routes['GET /health'] = async (_req, res) => {
  json(res, {
    ok: true,
    service: 'clawd-soul',
    version: '0.1.0',
    uptime: Math.floor(process.uptime()),
    hasApiKey: config.hasApiKey(),
    provider: config.get().provider,
    memoryCount: memory.count(),
    chatSession: {
      messages: observer.getChatHistory().messages.length,
      hasSummary: !!(observer.getChatHistory().summary),
    },
    tokenUsage: provider.getUsageStats(),
    mood: { ...soul.get().mood },
    trust: soul.get().trust,
  });
};

// GET /mood — get current mood
routes['GET /mood'] = async (_req, res) => {
  const s = soul.get();
  json(res, {
    ok: true,
    mood: { ...s.mood },
    trust: s.trust,
    proactivenessLevel: engine.getProactivenessLevel(),
  });
};

// ---------------------------------------------------------------------------
// Pairing / multi-device
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import os from 'node:os';

/** Generate a 6-digit pairing code (valid for 5 minutes) */
let _pairingCode = null;
let _pairingExpiry = 0;

// POST /pair/generate — host generates a pairing code
routes['POST /pair/generate'] = async (_req, res) => {
  _pairingCode = String(Math.floor(100000 + Math.random() * 900000));
  _pairingExpiry = Date.now() + 5 * 60 * 1000; // 5 min

  json(res, { ok: true, code: _pairingCode, expiresIn: 300 });
};

// POST /pair/connect — client submits pairing code to get auth token
routes['POST /pair/connect'] = async (req, res) => {
  const body = await readBody(req);
  if (!body?.code || !body?.deviceName) {
    return json(res, { ok: false, error: 'Missing code or deviceName' }, 400);
  }

  if (!_pairingCode || Date.now() > _pairingExpiry) {
    return json(res, { ok: false, error: 'No active pairing code or code expired' }, 403);
  }

  if (body.code !== _pairingCode) {
    return json(res, { ok: false, error: 'Invalid pairing code' }, 403);
  }

  // Pairing successful — generate auth token if not exists
  const cfg = config.get();
  if (!cfg.authToken) {
    cfg.authToken = crypto.randomBytes(32).toString('hex');
    config.save();
  }

  // Register device
  const devices = cfg.pairedDevices || [];
  const existing = devices.find((d) => d.name === body.deviceName);
  if (!existing) {
    devices.push({ name: body.deviceName, pairedAt: new Date().toISOString() });
    config.update({ pairedDevices: devices });
  }

  // Clear pairing code (single use)
  _pairingCode = null;
  _pairingExpiry = 0;

  json(res, {
    ok: true,
    authToken: cfg.authToken,
    soulName: soul.get().name,
    message: `Paired with ${body.deviceName}!`,
  });
};

// GET /pair/status — check pairing status and LAN info
routes['GET /pair/status'] = async (_req, res) => {
  const cfg = config.get();
  const addresses = [];
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        addresses.push(addr.address);
      }
    }
  }

  json(res, {
    ok: true,
    networkMode: cfg.networkMode,
    lanAddresses: addresses,
    pairedDevices: cfg.pairedDevices || [],
    hasPendingCode: !!_pairingCode && Date.now() < _pairingExpiry,
  });
};

// POST /pair/enable-lan — switch to LAN mode
routes['POST /pair/enable-lan'] = async (_req, res) => {
  const cfg = config.get();
  if (!cfg.authToken) {
    cfg.authToken = crypto.randomBytes(32).toString('hex');
  }
  config.update({ networkMode: 'lan', authToken: cfg.authToken });

  json(res, {
    ok: true,
    networkMode: 'lan',
    message: 'LAN mode enabled. Restart soul server to apply. Use POST /pair/generate to create a pairing code.',
  });
};

// POST /pair/disable-lan — switch back to local mode
routes['POST /pair/disable-lan'] = async (_req, res) => {
  config.update({ networkMode: 'local' });
  json(res, { ok: true, networkMode: 'local', message: 'Local mode enabled. Restart soul server to apply.' });
};

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function isLocalRequest(req) {
  const ip = req.socket.remoteAddress;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function checkAuth(req) {
  // Local requests always allowed (same machine)
  if (isLocalRequest(req)) return true;

  // Remote requests need auth token in LAN mode
  const cfg = config.get();
  if (cfg.networkMode !== 'lan') return false; // not in LAN mode, reject remote

  const authHeader = req.headers['authorization'];
  if (!authHeader || !cfg.authToken) return false;

  const token = authHeader.replace(/^Bearer\s+/i, '');
  return token === cfg.authToken;
}

// Public routes (no auth needed) — pairing endpoints
const PUBLIC_ROUTES = new Set(['POST /pair/connect', 'GET /health']);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function route(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method} ${url.pathname}`;

  // Auth check for non-public routes
  if (!PUBLIC_ROUTES.has(routeKey) && !checkAuth(req)) {
    json(res, { ok: false, error: 'Unauthorized' }, 401);
    return;
  }

  const handler = routes[routeKey];
  if (handler) {
    handler(req, res).catch((err) => {
      console.error(`[server] ${routeKey} error:`, err);
      json(res, { ok: false, error: 'Internal error' }, 500);
    });
  } else {
    json(res, { ok: false, error: 'Not found' }, 404);
  }
}

// ---------------------------------------------------------------------------
// Port discovery (try 23456, then 23457–23460)
// ---------------------------------------------------------------------------
const PORT_START = 23456;
const PORT_END = 23460;

function tryListen(server, port, bindAddress) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else resolve(false);
    });
    server.listen(port, bindAddress, () => resolve(true));
  });
}

// ---------------------------------------------------------------------------
// Runtime file (for clawd-on-desk to discover the server)
// ---------------------------------------------------------------------------
function writeRuntime(port, bindAddress) {
  const runtimePath = path.join(config.DATA_DIR, 'soul-runtime.json');
  const lanAddresses = [];
  if (bindAddress === '0.0.0.0') {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          lanAddresses.push(addr.address);
        }
      }
    }
  }
  fs.writeFileSync(runtimePath, JSON.stringify({
    port,
    pid: process.pid,
    bindAddress,
    lanAddresses,
    networkMode: config.get().networkMode,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function clearRuntime() {
  const runtimePath = path.join(config.DATA_DIR, 'soul-runtime.json');
  try { fs.unlinkSync(runtimePath); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(server) {
  console.log('\n[clawd-soul] shutting down...');
  diary.stopTimer();
  soul.save();
  memory.close();
  clearRuntime();
  server.close(() => {
    console.log('[clawd-soul] goodbye! 🦀');
    process.exit(0);
  });
  // Force exit after 3s
  setTimeout(() => process.exit(0), 3000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Load .env
  loadEnv();

  // Initialize
  config.load();
  soul.load();

  console.log(`[clawd-soul] ${soul.get().name} waking up...`);
  console.log(`[clawd-soul] provider: ${config.get().provider}`);
  console.log(`[clawd-soul] API key: ${config.hasApiKey() ? 'configured' : 'NOT configured'}`);
  console.log(`[clawd-soul] embedding key: ${config.hasEmbeddingKey() ? 'configured' : 'NOT configured'}`);

  // Initialize memory (triggers DB creation)
  memory.getDb();
  console.log(`[clawd-soul] memories: ${memory.count()}`);

  // Initialize chat session (load from disk)
  observer.init();

  // Start diary timer
  diary.startTimer();

  // Create HTTP server
  const server = http.createServer(route);

  // Determine bind address based on network mode
  const bindAddress = config.get().networkMode === 'lan' ? '0.0.0.0' : '127.0.0.1';

  // Find available port
  let port = PORT_START;
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await tryListen(server, p, bindAddress)) {
      port = p;
      break;
    }
  }

  // Write runtime file (includes LAN addresses if in LAN mode)
  writeRuntime(port, bindAddress);

  console.log(`[clawd-soul] listening on http://${bindAddress}:${port}`);
  if (bindAddress === '0.0.0.0') {
    console.log(`[clawd-soul] LAN mode enabled — remote devices can connect with auth token`);
    const nets = os.networkInterfaces();
    for (const [name, iface] of Object.entries(nets)) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`[clawd-soul]   ${name}: http://${addr.address}:${port}`);
        }
      }
    }
  }
  console.log(`[clawd-soul] trust: ${(soul.get().trust * 100).toFixed(0)}%, mood: energy=${soul.get().mood.energy.toFixed(2)} interest=${soul.get().mood.interest.toFixed(2)} affection=${soul.get().mood.affection.toFixed(2)}`);

  // Graceful shutdown handlers
  process.on('SIGINT', () => shutdown(server));
  process.on('SIGTERM', () => shutdown(server));
}

main().catch((err) => {
  console.error('[clawd-soul] fatal:', err);
  process.exit(1);
});
