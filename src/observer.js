import config from './config.js';
import provider from './provider.js';
import memory from './memory.js';
import engine from './engine.js';
import soul from './soul-file.js';
import prompts from './prompts.js';
import personality from './personality.js';
import session from './chat-session.js';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
let _lastObserveTime = 0;
let _lastScreenSummary = '';

const MIN_OBSERVE_INTERVAL_MS = 15000;

// ---------------------------------------------------------------------------
// Semantic memory extraction
// ---------------------------------------------------------------------------
const _appUsageCount = new Map();

function extractSemanticMemory(app, summary) {
  if (app) {
    _appUsageCount.set(app, (_appUsageCount.get(app) || 0) + 1);
    if (_appUsageCount.get(app) === 3) {
      soul.addSemanticMemory(`Owner frequently uses ${app}`);
    }
  }
  const lower = (summary || '').toLowerCase();
  if (lower.includes('code') || lower.includes('github')) soul.addSemanticMemory('Owner is a programmer');
  if (lower.includes('bilibili') || lower.includes('b站')) soul.addSemanticMemory('Owner watches Bilibili');
  if (lower.includes('youtube')) soul.addSemanticMemory('Owner watches YouTube');
}

function extractFromChat(message) {
  const lower = message.toLowerCase();
  const patterns = [
    /my name is|i am|i'm|我叫|我是/,
    /i like|i love|i enjoy|我喜欢|我爱|我最爱/,
    /i work|my job|我工作|我做|我在做|在做/,
    /i hate|i don't like|我讨厌|我不喜欢/,
    /i live|i'm from|我住|我来自/,
    /i study|i'm learning|我在学/,
    /my favorite|最喜欢|最爱的/,
    /today i|今天我/,
  ];
  for (const p of patterns) {
    if (p.test(lower)) {
      soul.addSemanticMemory(message.slice(0, 120));
      soul.save();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// App categorization
// ---------------------------------------------------------------------------
const APP_CATEGORIES = {
  coding: ['Visual Studio Code', 'Code', 'Cursor', 'Xcode', 'IntelliJ', 'WebStorm', 'PyCharm', 'Terminal', 'iTerm', 'Warp', 'Alacritty', 'Ghostty'],
  browsing: ['Arc', 'Safari', 'Chrome', 'Firefox', 'Brave', 'Edge'],
  communication: ['Slack', 'Discord', 'Telegram', 'WhatsApp', 'Messages', 'WeChat', 'Teams', 'Zoom'],
  creative: ['Figma', 'Sketch', 'Photoshop', 'Blender', 'Final Cut'],
  writing: ['Notion', 'Obsidian', 'Bear', 'Pages', 'Word'],
  media: ['Spotify', 'Music', 'YouTube', 'Netflix', 'Bilibili', 'VLC'],
};

function categorizeApp(appName) {
  if (!appName) return 'unknown';
  const lower = appName.toLowerCase();
  for (const [cat, apps] of Object.entries(APP_CATEGORIES)) {
    if (apps.some((a) => lower.includes(a.toLowerCase()))) return cat;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Initialize — load chat session from disk
// ---------------------------------------------------------------------------
function init() {
  session.load();
  console.log(`[observer] chat session loaded: ${session.getHistory().messages.length} messages`);
}

// ---------------------------------------------------------------------------
// Observation — feeds SILENTLY into the conversation context
//
// The pet sees the screen and REMEMBERS what it saw, but does NOT
// automatically comment. Commentary happens via heartbeat or chat.
// ---------------------------------------------------------------------------
async function observe({ screenshot, foregroundApp, windowTitle, trigger }) {
  const now = Date.now();
  if (now - _lastObserveTime < MIN_OBSERVE_INTERVAL_MS && trigger === 'periodic') {
    return { ok: true, action: 'silent', commentary: '' };
  }
  _lastObserveTime = now;

  if (!config.hasApiKey()) {
    return { ok: false, error: 'No API key configured', action: 'silent', commentary: '' };
  }

  // Track timing
  const timing = engine.recordObservationTime();
  if (timing.gap > 0) engine.handleUserReturn(timing.gap);
  engine.tickMoodDecay();

  const appCategory = categorizeApp(foregroundApp);

  // Ask AI to describe the screen briefly (for context, NOT for display)
  const descMessages = [
    { role: 'system', content: 'Describe what you see on this screen in one brief sentence. Focus on the main activity. Chinese if the content is Chinese, English otherwise.' },
    { role: 'user', content: [
      { type: 'text', text: `App: ${foregroundApp || 'unknown'}, Window: ${windowTitle || 'unknown'}` },
      ...(screenshot ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'auto' } }] : []),
    ]},
  ];

  let screenSummary = `${foregroundApp}: ${windowTitle}`;
  try {
    screenSummary = await provider.chat(descMessages, { purpose: 'observe', maxTokens: 100, temperature: 0.3 });
  } catch {}

  // Skip if screen hasn't changed
  if (screenSummary === _lastScreenSummary) {
    return { ok: true, action: 'silent', commentary: '' };
  }
  _lastScreenSummary = screenSummary;

  // Add to conversation context SILENTLY (not shown to user)
  session.addObservation(screenSummary);

  // Store in episodic memory
  await memory.addEpisode({
    type: 'observation',
    summary: screenSummary,
    app: foregroundApp,
    mood: soul.get().mood,
  });

  extractSemanticMemory(foregroundApp, screenSummary);
  soul.recordInteraction('observation');

  // Compact session if needed
  if (session.needsCompaction()) {
    await session.compact();
  }

  // Save soul periodically
  if (soul.get().stats.totalObservations % 10 === 0) soul.save();

  return { ok: true, action: 'silent', commentary: '', summary: screenSummary };
}

// ---------------------------------------------------------------------------
// Heartbeat — the pet's "inner voice" that decides to speak or not
//
// Called every ~30 min. Reviews accumulated context (observations, time,
// drives) and decides if it wants to say something to the user.
// This is what makes the pet feel ALIVE — it initiates, not just reacts.
// ---------------------------------------------------------------------------
async function heartbeat() {
  if (!config.hasApiKey()) return null;

  engine.tickMoodDecay();
  engine.generateProactiveContext();

  // Check if there's a proactive message (morning greeting, break nudge, etc.)
  const proactive = engine.getProactiveMessage();
  if (proactive) {
    session.addAssistant(proactive);
    return { commentary: proactive, action: 'speech-bubble' };
  }

  // Check drives — does the pet want to ask a question?
  const s = soul.get();
  const cfg = config.get();
  const lastChat = s.stats.lastChatTime ? new Date(s.stats.lastChatTime).getTime() : 0;
  const hoursSinceChat = (Date.now() - lastChat) / 3600000;

  if (hoursSinceChat > 1.5 && Math.random() < 0.4) {
    const question = personality.pickQuestion(cfg.language || 'zh', s.askedQuestions || []);
    if (question) {
      s.askedQuestions = [...(s.askedQuestions || []), question];
      soul.save();
      session.addAssistant(question);
      return { commentary: question, action: 'speech-bubble' };
    }
  }

  // Otherwise, let the AI decide if it wants to say something
  // based on the accumulated context
  const ctx = engine.getPersonalityContext();
  const systemPrompt = prompts.chat({
    ...ctx,
    recentObservations: [],
    dailyContext: '',
  });

  const messages = session.getMessagesForAI(systemPrompt);
  messages.push({
    role: 'system',
    content: ctx.language === 'zh'
      ? '根据上面的对话和你最近观察到的事情，你现在想不想主动跟主人说点什么？如果想说就说，不想说就回复"[沉默]"。说话要自然，像朋友发微信。'
      : 'Based on the conversation above and what you\'ve observed, do you want to say something to your owner? If yes, just say it. If not, reply "[silent]". Be natural, like texting a friend.',
  });

  try {
    const reply = await provider.chat(messages, { purpose: 'chat', maxTokens: 200, temperature: 0.95 });
    if (reply && !reply.includes('[沉默]') && !reply.includes('[silent]') && reply.trim().length > 0) {
      session.addAssistant(reply);
      return { commentary: reply, action: 'speech-bubble' };
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// Chat — continuous conversation using full persistent context
// ---------------------------------------------------------------------------
async function chat(message) {
  if (!config.hasApiKey()) {
    return { ok: false, error: 'No API key configured' };
  }

  engine.tickMoodDecay();

  const ctx = engine.getPersonalityContext();

  // Add user message to persistent session
  session.addUser(message);

  // Build system prompt
  const systemPrompt = prompts.chat({
    ...ctx,
    recentObservations: [],
    dailyContext: '',
  });

  // Get full conversation from session (includes summary + all history)
  const messages = session.getMessagesForAI(systemPrompt);

  try {
    const reply = await provider.chat(messages, {
      purpose: 'chat',
      maxTokens: 300,
      temperature: 0.9,
    });

    // Add reply to persistent session
    session.addAssistant(reply);

    // Store in episodic memory too (for search)
    await memory.addEpisode({
      type: 'chat',
      summary: `User: "${message.slice(0, 80)}" → Pet: "${reply.slice(0, 80)}"`,
      detail: reply,
      mood: soul.get().mood,
    });

    // Learn + evolve
    extractFromChat(message);
    const signals = personality.detectSignals(message);
    const s = soul.get();
    for (const signal of signals) {
      s.evolvedTraits = personality.evolveTraits(s.evolvedTraits, signal);
    }
    s.stats.lastChatTime = new Date().toISOString();

    soul.recordInteraction('chat');
    engine.applyEvent(message.length > 50 ? 'chat-long' : 'chat-received');
    soul.save();

    // Compact if approaching limit
    if (session.needsCompaction()) {
      session.compact().catch((err) => console.error('[observer] compaction failed:', err.message));
    }

    return { ok: true, reply, mood: { ...soul.get().mood } };
  } catch (err) {
    console.error('[observer] chat failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Get chat history for UI
// ---------------------------------------------------------------------------
function getChatHistory() {
  return session.getHistory();
}

function getLastScreenSummary() {
  return _lastScreenSummary;
}

export default { init, observe, heartbeat, chat, getChatHistory, getLastScreenSummary };
