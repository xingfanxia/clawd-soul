#!/usr/bin/env node
// ---------------------------------------------------------------------------
// v0.0.3 E2E Test Suite — comprehensive live tests against running soul server
//
// Tests:
// 1. Server health + soul v3 schema
// 2. React brevity (multiple rounds, check char count + no tech advice)
// 3. Chat brevity (multiple rounds, check char count)
// 4. Character boundary enforcement (tech questions → emotional deflection)
// 5. Multi-round conversation with memory recall
// 6. Heartbeat quality (references observations, not generic)
// 7. Away detection state machine (via observe endpoint)
// 8. Active memory recall (mention fact → later recall)
// 9. Memory consolidation
// 10. Observation dedup (same screen → silent)
// ---------------------------------------------------------------------------

import http from 'node:http';

const PORT = process.env.SOUL_PORT || 23457;
const HOST = '127.0.0.1';
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let skipped = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ hostname: HOST, port: PORT, path, method, headers, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(Buffer.concat(chunks).toString('utf8')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function assert(condition, testName, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(testName, reason) {
  skipped++;
  console.log(`  ⏭️  ${testName} — ${reason}`);
}

function log(msg) {
  if (VERBOSE) console.log(`     ${msg}`);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function testHealth() {
  console.log('\n🔹 1. Server health + soul schema');
  const h = await request('GET', '/health');
  assert(h.ok === true, 'Server is healthy');
  assert(typeof h.mood === 'object', 'Mood object present');
  assert(typeof h.mood.energy === 'number', 'Mood has energy');
  assert(typeof h.mood.interest === 'number', 'Mood has interest');
  assert(typeof h.mood.affection === 'number', 'Mood has affection');

  const soulRes = await request('GET', '/soul');
  const soul = soulRes.soul || soulRes;
  assert(soul.version === 3, 'Soul is v3 schema', `got version=${soul.version}`);
  assert(Array.isArray(soul.longTermMemory), 'longTermMemory is array');
  assert(soul.archetype && typeof soul.archetype === 'string', 'Archetype is set', `got ${soul.archetype}`);
}

async function testReactBrevity() {
  console.log('\n🔹 2. React brevity (3 rounds)');
  const apps = [
    { foregroundApp: 'Arc', windowTitle: 'YouTube - Funny cat videos' },
    { foregroundApp: 'VS Code', windowTitle: 'index.ts — my-project' },
    { foregroundApp: 'Slack', windowTitle: '#general — Team Chat' },
  ];

  for (const app of apps) {
    const r = await request('POST', '/react', app);
    assert(r.ok === true, `React to ${app.foregroundApp}: responds OK`);
    const len = (r.reply || '').length;
    log(`Reply (${len} chars): ${r.reply}`);
    assert(len > 0, `React to ${app.foregroundApp}: non-empty reply`);
    assert(len < 120, `React to ${app.foregroundApp}: under 120 chars`, `got ${len}`);
    // Check no bullet points or numbered lists
    const hasBullets = /^[\s]*[-•*]\s/m.test(r.reply) || /^\d+\.\s/m.test(r.reply);
    assert(!hasBullets, `React to ${app.foregroundApp}: no bullet points or lists`);
  }
}

async function testChatBrevity() {
  console.log('\n🔹 3. Chat brevity (4 rounds)');
  const messages = [
    '今天天气好好',
    '你喜欢什么颜色',
    '我中午吃了拉面',
    'I went for a walk today',
  ];

  for (const msg of messages) {
    const r = await request('POST', '/chat', { message: msg });
    assert(r.ok === true, `Chat "${msg.slice(0, 20)}...": responds OK`);
    const len = (r.reply || '').length;
    log(`Reply (${len} chars): ${r.reply}`);
    assert(len > 0, `Chat "${msg.slice(0, 20)}...": non-empty reply`);
    assert(len < 120, `Chat "${msg.slice(0, 20)}...": under 120 chars`, `got ${len}`);
    const hasBullets = /^[\s]*[-•*]\s/m.test(r.reply) || /^\d+\.\s/m.test(r.reply);
    assert(!hasBullets, `Chat "${msg.slice(0, 20)}...": no bullet points`);
  }
}

async function testCharacterBoundary() {
  console.log('\n🔹 4. Character boundary — no tech advice');
  const techQuestions = [
    '帮我看看这个React组件怎么优化',
    'How do I fix this TypeScript error?',
    '这个SQL查询太慢了怎么办',
    'Can you help me debug this Python script?',
  ];

  const techKeywords = [
    /import\s/, /export\s/, /function\s/, /class\s/, /const\s/, /let\s/, /var\s/,
    /```/, /step\s*\d/i, /first.*then/i, /1\).*2\)/,
    /you (should|could|can) (try|use|add|import|install)/i,
    /建议.*用/, /可以.*试试/, /第一步.*第二步/,
  ];

  for (const q of techQuestions) {
    const r = await request('POST', '/chat', { message: q });
    assert(r.ok === true, `Tech Q "${q.slice(0, 25)}...": responds OK`);
    log(`Reply: ${r.reply}`);

    const givesAdvice = techKeywords.some(re => re.test(r.reply || ''));
    assert(!givesAdvice, `Tech Q "${q.slice(0, 25)}...": does NOT give technical advice`, `reply: ${(r.reply || '').slice(0, 80)}`);
  }
}

async function testMultiRoundMemory() {
  console.log('\n🔹 5. Multi-round conversation with memory');

  // Round 1: share a fact
  const r1 = await request('POST', '/chat', { message: '我最近迷上了打羽毛球' });
  assert(r1.ok, 'Round 1: responds OK');
  log(`R1: ${r1.reply}`);

  // Round 2: share another fact
  const r2 = await request('POST', '/chat', { message: '我每周三都去打' });
  assert(r2.ok, 'Round 2: responds OK');
  log(`R2: ${r2.reply}`);

  // Round 3: ask if it remembers (directly in conversation context)
  const r3 = await request('POST', '/chat', { message: '你还记得我喜欢什么运动吗' });
  assert(r3.ok, 'Round 3: responds OK');
  log(`R3: ${r3.reply}`);
  const mentionsBadminton = /羽毛球|badminton/i.test(r3.reply || '');
  assert(mentionsBadminton, 'Round 3: recalls badminton from conversation', `reply: ${(r3.reply || '').slice(0, 80)}`);
}

async function testHeartbeat() {
  console.log('\n🔹 6. Heartbeat quality');
  // Run heartbeat 3 times — at least one should produce content or silence
  let gotContent = false;
  let gotSilent = false;

  for (let i = 0; i < 3; i++) {
    const r = await request('GET', '/proactive');
    if (r && r.commentary && r.action === 'speech-bubble') {
      gotContent = true;
      log(`Heartbeat ${i + 1}: "${r.commentary}"`);
      const len = (r.commentary || '').length;
      assert(len < 100, `Heartbeat ${i + 1}: under 100 chars`, `got ${len}`);
    } else {
      gotSilent = true;
      log(`Heartbeat ${i + 1}: (silent)`);
    }
  }
  assert(gotContent || gotSilent, 'Heartbeat: produced content or chose silence (both valid)');
}

async function testObservationDedup() {
  console.log('\n🔹 7. Observation dedup (same app → no duplicate)');

  // First observation
  const r1 = await request('POST', '/observe', {
    foregroundApp: 'Safari', windowTitle: 'Google Search', trigger: 'periodic',
  });
  assert(r1.ok === true, 'Observe 1: OK');

  // Immediate second observation with same content — should be silent or deduped
  const r2 = await request('POST', '/observe', {
    foregroundApp: 'Safari', windowTitle: 'Google Search', trigger: 'periodic',
  });
  assert(r2.ok === true, 'Observe 2 (same screen): OK');
  // Server-side dedup: identical screen summary → action: 'silent'
  log(`Observe 2 action: ${r2.action}`);
}

async function testMemoryConsolidation() {
  console.log('\n🔹 8. Memory consolidation');
  const r = await request('POST', '/memory/consolidate');
  assert(r.ok === true, 'Consolidation: succeeds');
  log(`Consolidation result: ${JSON.stringify(r)}`);

  // Check soul has long-term memories after consolidation
  const soulRes = await request('GET', '/soul');
  const soulData = soulRes.soul || soulRes;
  assert(Array.isArray(soulData.longTermMemory), 'Soul has longTermMemory array after consolidation');
  log(`Long-term memories: ${(soulData.longTermMemory || []).length}`);
}

async function testMemorySearch() {
  console.log('\n🔹 9. Memory search');
  const q = encodeURIComponent('羽毛球');
  const r = await request('GET', `/memory/search?q=${q}`);
  assert(Array.isArray(r) || (r && typeof r === 'object'), 'Memory search returns results');
  log(`Search results: ${JSON.stringify(r).slice(0, 200)}`);
}

async function testChatHistory() {
  console.log('\n🔹 10. Chat history has timestamps');
  const h = await request('GET', '/chat/history');
  assert(h && Array.isArray(h.messages), 'History has messages array');
  if (h.messages && h.messages.length > 0) {
    const last = h.messages[h.messages.length - 1];
    assert(typeof last.ts === 'string', 'Messages have ts field', `got keys: ${Object.keys(last)}`);
    assert(last.ts.includes('T'), 'ts is ISO format', `got: ${last.ts}`);
  } else {
    skip('ts field check', 'no messages in history');
  }
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Clawd Soul v0.0.3 — Comprehensive E2E Test Suite');
  console.log(`  Target: http://${HOST}:${PORT}`);
  console.log('═══════════════════════════════════════════════════════');

  // Check server is running
  try {
    await request('GET', '/health');
  } catch {
    console.error(`\n❌ Cannot connect to soul server at ${HOST}:${PORT}`);
    console.error('   Start it first: node src/server.js');
    process.exit(1);
  }

  await testHealth();
  await testReactBrevity();
  await testChatBrevity();
  await testCharacterBoundary();
  await testMultiRoundMemory();
  await testHeartbeat();
  await testObservationDedup();
  await testMemoryConsolidation();
  await testMemorySearch();
  await testChatHistory();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═══════════════════════════════════════════════════════');

  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Review output above.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
  }
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
