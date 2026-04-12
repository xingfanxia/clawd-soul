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

// GET /proactive — poll for unprompted pet messages
routes['GET /proactive'] = async (_req, res) => {
  const msg = engine.getProactiveMessage();
  if (msg) {
    json(res, { ok: true, commentary: msg, mood: { ...soul.get().mood }, action: 'speech-bubble', duration: 8000 });
  } else {
    json(res, { ok: true, commentary: '', action: 'none' });
  }
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
// Router
// ---------------------------------------------------------------------------
function route(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const routeKey = `${req.method} ${url.pathname}`;

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

function tryListen(server, port) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else resolve(false);
    });
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
}

// ---------------------------------------------------------------------------
// Runtime file (for clawd-on-desk to discover the server)
// ---------------------------------------------------------------------------
function writeRuntime(port) {
  const runtimePath = path.join(config.DATA_DIR, 'soul-runtime.json');
  fs.writeFileSync(runtimePath, JSON.stringify({
    port,
    pid: process.pid,
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

  // Start diary timer
  diary.startTimer();

  // Create HTTP server
  const server = http.createServer(route);

  // Find available port
  let port = PORT_START;
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await tryListen(server, p)) {
      port = p;
      break;
    }
  }

  // Write runtime file
  writeRuntime(port);

  console.log(`[clawd-soul] listening on http://127.0.0.1:${port}`);
  console.log(`[clawd-soul] trust: ${(soul.get().trust * 100).toFixed(0)}%, mood: energy=${soul.get().mood.energy.toFixed(2)} interest=${soul.get().mood.interest.toFixed(2)} affection=${soul.get().mood.affection.toFixed(2)}`);

  // Graceful shutdown handlers
  process.on('SIGINT', () => shutdown(server));
  process.on('SIGTERM', () => shutdown(server));
}

main().catch((err) => {
  console.error('[clawd-soul] fatal:', err);
  process.exit(1);
});
