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
      image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'low' },
    });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  try {
    const raw = await provider.chat(messages, {
      purpose: 'observe',
      maxTokens: 300,
      temperature: 0.8,
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
// Chat handler
// ---------------------------------------------------------------------------

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

  const messages = [
    { role: 'system', content: systemPrompt },
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
