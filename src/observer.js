import config from './config.js';
import provider from './provider.js';
import memory from './memory.js';
import engine from './engine.js';
import soul from './soul-file.js';
import prompts from './prompts.js';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
let _lastObserveTime = 0;
let _lastScreenSummary = '';
let _consecutiveSilent = 0;
let _recentCommentaries = []; // last 5 commentaries (for dedup/variety)

const MIN_OBSERVE_INTERVAL_MS = 10000; // minimum 10s between observations

// ---------------------------------------------------------------------------
// Semantic memory extraction — learn facts about the user over time
// ---------------------------------------------------------------------------
const _appUsageCount = new Map(); // track which apps the user uses most

function extractSemanticMemory(app, summary) {
  // Track app usage
  if (app) {
    _appUsageCount.set(app, (_appUsageCount.get(app) || 0) + 1);
    const count = _appUsageCount.get(app);
    // After seeing an app 3+ times, remember it
    if (count === 3) {
      soul.addSemanticMemory(`Owner frequently uses ${app}`);
    }
  }

  // Extract facts from summary (simple pattern matching)
  const lower = summary.toLowerCase();
  if (lower.includes('code') || lower.includes('coding') || lower.includes('programming') || lower.includes('github')) {
    soul.addSemanticMemory('Owner is a programmer/developer');
  }
  if (lower.includes('bilibili') || lower.includes('b站')) {
    soul.addSemanticMemory('Owner watches Bilibili');
  }
  if (lower.includes('youtube')) {
    soul.addSemanticMemory('Owner watches YouTube');
  }
  if (lower.includes('slack') || lower.includes('discord') || lower.includes('teams')) {
    soul.addSemanticMemory('Owner uses team chat for work');
  }
  if (lower.includes('chinese') || lower.includes('中文')) {
    soul.addSemanticMemory('Owner reads/writes Chinese');
  }
}

function extractFromChat(userMessage) {
  const lower = userMessage.toLowerCase();
  // Learn from personal statements — broad matching
  const personalPatterns = [
    /my name is|i am|i'm|我叫|我是/,
    /i like|i love|i enjoy|i prefer|我喜欢|我爱|我最爱/,
    /i work|my job|i do|我工作|我做|我在做|在做/,
    /i hate|i don't like|i dislike|我讨厌|我不喜欢/,
    /i live|i'm from|i moved|我住|我来自|我从/,
    /i study|i'm learning|i'm studying|我在学|我学/,
    /my favorite|最喜欢|最爱的/,
    /today i|今天我/,
  ];

  for (const pattern of personalPatterns) {
    if (pattern.test(lower)) {
      soul.addSemanticMemory(userMessage.slice(0, 120));
      soul.save();
      break; // one match per message is enough
    }
  }
}

// ---------------------------------------------------------------------------
// App categorization — helps the pet react appropriately
// ---------------------------------------------------------------------------
const APP_CATEGORIES = {
  coding: ['Visual Studio Code', 'Code', 'Cursor', 'Xcode', 'IntelliJ', 'WebStorm', 'PyCharm', 'Sublime Text', 'Atom', 'Vim', 'Neovim', 'Emacs', 'Terminal', 'iTerm', 'Warp', 'Alacritty', 'Ghostty', 'Hyper'],
  browsing: ['Arc', 'Safari', 'Chrome', 'Firefox', 'Brave', 'Edge', 'Opera', 'Vivaldi'],
  communication: ['Slack', 'Discord', 'Telegram', 'WhatsApp', 'Messages', 'WeChat', 'Teams', 'Zoom', 'FaceTime'],
  creative: ['Figma', 'Sketch', 'Photoshop', 'Illustrator', 'Blender', 'Final Cut', 'Logic Pro', 'GarageBand'],
  writing: ['Notion', 'Obsidian', 'Bear', 'Ulysses', 'Pages', 'Word', 'Google Docs'],
  media: ['Spotify', 'Music', 'YouTube', 'Netflix', 'Bilibili', 'VLC', 'IINA'],
  gaming: ['Steam', 'Minecraft', 'Roblox'],
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
// Observation handler
// ---------------------------------------------------------------------------

/**
 * Handle a screen observation.
 * @param {Object} params
 * @param {string} params.screenshot - base64 JPEG
 * @param {string} params.foregroundApp - current app name
 * @param {string} params.windowTitle - current window title
 * @param {string} params.trigger - 'periodic' | 'app-switch' | 'user-click'
 * @returns {Object} { ok, commentary, mood, action, duration }
 */
async function observe({ screenshot, foregroundApp, windowTitle, trigger }) {
  // Rate limit
  const now = Date.now();
  if (now - _lastObserveTime < MIN_OBSERVE_INTERVAL_MS && trigger === 'periodic') {
    return { ok: true, action: 'throttled', commentary: '' };
  }
  _lastObserveTime = now;

  // Check if provider is configured
  if (!config.hasApiKey()) {
    return { ok: false, error: 'No API key configured', action: 'silent', commentary: '' };
  }

  // Track timing (morning greeting, absence detection, break nudges)
  const timing = engine.recordObservationTime();
  if (timing.gap > 0) {
    engine.handleUserReturn(timing.gap);
  }

  // Tick mood decay
  engine.tickMoodDecay();

  // Get personality context + app category
  const ctx = engine.getPersonalityContext();
  const appCategory = categorizeApp(foregroundApp);

  // Retrieve relevant memories
  const searchQuery = `${foregroundApp} ${windowTitle}`.trim();
  let relevantMemories = [];
  try {
    const results = await memory.search(searchQuery, 5);
    relevantMemories = results.map((r) => r.summary);
  } catch {
    // Memory search failed — continue without memories
  }

  // Build the system prompt with app context + recent commentaries for variety
  const systemPrompt = prompts.observation({
    ...ctx,
    memories: relevantMemories,
    appCategory,
    timeOfDay: timing.timeOfDay,
    recentCommentaries: _recentCommentaries,
  });

  // Build user message with screenshot
  const userContent = [
    { type: 'text', text: `App: ${foregroundApp || 'unknown'}\nWindow: ${windowTitle || 'unknown'}\nTrigger: ${trigger}` },
  ];

  if (screenshot) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'auto' },
    });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  try {
    const raw = await provider.chat(messages, {
      purpose: 'observe',
      maxTokens: 500,
      temperature: 0.85,
      jsonMode: true,
    });

    // Parse AI response
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // If not valid JSON, treat as raw commentary
      parsed = { commentary: raw, action: 'speech-bubble', summary: raw, interesting: false };
    }

    const action = parsed.action || 'speech-bubble';
    const commentary = parsed.commentary || '';
    const summary = parsed.summary || commentary;
    const interesting = parsed.interesting ?? false;

    // Store in memory (always, even silent ones — the pet remembers what it sees)
    await memory.addEpisode({
      type: 'observation',
      summary,
      detail: commentary,
      app: foregroundApp,
      mood: soul.get().mood,
    });

    // Extract semantic memory — learn about the user from observations
    if (interesting && summary) {
      extractSemanticMemory(foregroundApp, summary);
    }

    // Update soul stats
    soul.recordInteraction('observation');

    // Apply mood effects
    if (action === 'silent') {
      engine.applyEvent('observation-silent');
      _consecutiveSilent++;
    } else if (interesting) {
      engine.applyEvent('observation-interesting');
      _consecutiveSilent = 0;
    } else {
      engine.applyEvent('observation-boring');
      _consecutiveSilent = 0;
    }

    // Check if pet should comment (proactiveness filter)
    const finalAction = action === 'silent' ? 'silent'
      : (!engine.shouldComment() && trigger === 'periodic') ? 'silent'
      : action;

    // If pet has something interesting to say but was filtered, save for proactive
    if (action !== 'silent' && finalAction === 'silent' && interesting) {
      engine.setProactiveMessage(commentary);
    }

    _lastScreenSummary = summary;

    // Track recent commentaries for variety (dedup)
    if (commentary && finalAction !== 'silent') {
      _recentCommentaries.push(commentary);
      if (_recentCommentaries.length > 5) _recentCommentaries.shift();
    }

    // Save soul periodically (every 10 observations)
    if (soul.get().stats.totalObservations % 10 === 0) {
      soul.save();
    }

    return {
      ok: true,
      commentary: finalAction === 'silent' ? '' : commentary,
      mood: { ...soul.get().mood },
      action: finalAction,
      duration: finalAction === 'silent' ? 0 : 8000,
    };
  } catch (err) {
    console.error('[observer] AI call failed:', err.message);
    return { ok: false, error: err.message, action: 'silent', commentary: '' };
  }
}

// ---------------------------------------------------------------------------
// Chat handler — with conversation history
// ---------------------------------------------------------------------------

/** Rolling conversation history (last 20 turns, expires after 30 min of silence) */
let _chatHistory = [];
let _lastChatTime = 0;
const CHAT_HISTORY_MAX = 20;
const CHAT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function getChatHistory() {
  // Clear history if session timed out
  if (_lastChatTime > 0 && (Date.now() - _lastChatTime) > CHAT_SESSION_TIMEOUT_MS) {
    _chatHistory = [];
  }
  return _chatHistory;
}

function appendChatHistory(role, content) {
  _chatHistory.push({ role, content });
  // Keep only last N turns
  if (_chatHistory.length > CHAT_HISTORY_MAX) {
    _chatHistory = _chatHistory.slice(-CHAT_HISTORY_MAX);
  }
  _lastChatTime = Date.now();
}

/**
 * Handle a chat message from the user.
 * @param {string} message - User's message
 * @returns {Object} { ok, reply, mood }
 */
async function chat(message) {
  if (!config.hasApiKey()) {
    return { ok: false, error: 'No API key configured' };
  }

  engine.tickMoodDecay();

  const ctx = engine.getPersonalityContext();

  // Search for relevant memories
  let relevantMemories = [];
  try {
    const results = await memory.search(message, 5);
    relevantMemories = results.map((r) => r.summary);
  } catch {
    // Continue without memories
  }

  // Get recent observations for context
  const recentObs = memory.getRecentByType('observation', 5)
    .map((o) => o.summary);

  const systemPrompt = prompts.chat({
    ...ctx,
    memories: relevantMemories,
    recentObservations: recentObs,
  });

  // Build messages with conversation history
  const history = getChatHistory();
  appendChatHistory('user', message);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history, // previous turns
    { role: 'user', content: message },
  ];

  try {
    const reply = await provider.chat(messages, {
      purpose: 'chat',
      maxTokens: 300,
      temperature: 0.8,
    });

    // Store chat in memory
    await memory.addEpisode({
      type: 'chat',
      summary: `User said: "${message.slice(0, 100)}" — Pet replied: "${reply.slice(0, 100)}"`,
      detail: reply,
      mood: soul.get().mood,
    });

    // Append AI reply to conversation history
    appendChatHistory('assistant', reply);

    // Learn about the user from what they say
    extractFromChat(message);

    // Update stats and mood
    soul.recordInteraction('chat');
    engine.applyEvent(message.length > 50 ? 'chat-long' : 'chat-received');
    soul.save();

    return {
      ok: true,
      reply,
      mood: { ...soul.get().mood },
    };
  } catch (err) {
    console.error('[observer] chat failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Get the last screen summary (for diary context) */
function getLastScreenSummary() {
  return _lastScreenSummary;
}

export default { observe, chat, getLastScreenSummary };
