import config from './config.js';
import provider from './provider.js';
import memory from './memory.js';
import engine from './engine.js';
import soul from './soul-file.js';
import personality from './personality.js';
import session from './chat-session.js';
import promptEngine from './prompt-engine.js';
import activeMemory from './active-memory.js';
import innerLife from './inner-life.js';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
let _lastObserveTime = 0;
let _lastScreenSummary = '';

const MIN_OBSERVE_INTERVAL_MS = 15000;

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
// Shared context builder — assembles the ctx object for prompt-engine
// ---------------------------------------------------------------------------
function buildContext(foregroundApp) {
  engine.tickMoodDecay();
  const pCtx = engine.getPersonalityContext();
  const s = soul.get();
  return {
    ...pCtx,
    innerLife: s.innerLife,                    // v0.0.4: pet's own state (Layer 0)
    longTermMemory: s.longTermMemory || [],
    activeMemories: null, // set per-method after recall()
    recentObservations: session.getRecentObservationSummaries(5),
    timeOfDay: engine.getTimeOfDay(),
    currentDrive: null,
    recentPetMessages: session.getRecentAssistantMessages(3),
    appCategory: categorizeApp(foregroundApp),
    dailySummary: null,
  };
}

// ---------------------------------------------------------------------------
// Initialize — load chat session from disk
// ---------------------------------------------------------------------------
function init() {
  session.load();
  console.log(`[observer] chat session loaded: ${session.getHistory().messages.length} messages`);

  // v0.0.4: ensure pet has today's inner life (regen if stale)
  // Fire-and-forget — don't block startup on this
  innerLife.ensureFresh().then((il) => {
    if (il) console.log(`[observer] inner life ready: ${il.currentMood}`);
  }).catch((err) => {
    console.warn('[observer] inner life init failed:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Observation — feeds SILENTLY into the conversation context
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

  // Extract and store facts from the observation
  activeMemory.storeExtractedFacts(null, screenSummary).catch(() => {});
  soul.recordInteraction('observation');

  // Compact session if needed
  if (session.needsCompaction(provider.getUsageStats().lastPromptTokens)) {
    await session.compact();
  }

  // Save soul periodically
  if (soul.get().stats.totalObservations % 10 === 0) soul.save();

  return { ok: true, action: 'silent', commentary: '', summary: screenSummary, mood: { ...soul.get().mood } };
}

// ---------------------------------------------------------------------------
// React to screen — user clicked the pet, read screen + respond in ONE call
// ---------------------------------------------------------------------------
async function reactToScreen({ screenshot, foregroundApp, windowTitle }) {
  if (!config.hasApiKey()) return { ok: false, error: 'No API key configured' };

  const ctx = buildContext(foregroundApp);
  const isZh = ctx.language === 'zh';

  // Active Memory: recall relevant memories
  ctx.activeMemories = await activeMemory.recall(
    `${foregroundApp} ${windowTitle} ${_lastScreenSummary}`,
    { language: ctx.language },
  );

  // Build messages with prompt engine
  const messages = promptEngine.buildMessages('react', ctx, session);

  // Add screenshot as user turn
  messages.push({ role: 'user', content: [
    { type: 'text', text: isZh
      ? `[主人点了你] 应用: ${foregroundApp || '未知'}\n窗口: ${windowTitle || ''}\n看看屏幕，接着聊。`
      : `[Owner clicked you] App: ${foregroundApp || 'unknown'}\nWindow: ${windowTitle || ''}\nLook at screen, continue talking.` },
    ...(screenshot ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}`, detail: 'auto' } }] : []),
  ]});

  try {
    // gpt-5 family: reasoningEffort='minimal' skips extended reasoning
    // so all 120 tokens go to visible output instead of being eaten by reasoning
    let reply = await provider.chat(messages, {
      purpose: 'react',
      maxTokens: 120,
      // gpt-5.4-mini only supports default temperature, so we omit it here
      reasoningEffort: 'minimal',
    });
    // Fallback: if model returned empty (token budget exhausted by reasoning),
    // give a brief default reaction so the bubble isn't blank
    if (!reply || !reply.trim()) {
      const isZh = ctx.language === 'zh';
      reply = isZh ? '*歪头看你*' : '*tilts head*';
      console.warn('[observer] react returned empty, using fallback');
    }
    session.addAssistant(reply);
    session.addObservation(`${foregroundApp}: ${windowTitle}`);
    soul.recordInteraction('observation');
    engine.applyEvent('observation-interesting');

    // Extract and store facts from this interaction
    activeMemory.storeExtractedFacts(null, reply).catch(() => {});

    return { ok: true, reply, mood: { ...soul.get().mood } };
  } catch (err) {
    console.error('[observer] reactToScreen failed:', err.message);
    // v0.0.4: graceful fallback — user still sees a reply, pet doesn't look broken
    const isZh = (buildContext(foregroundApp).language || 'zh') === 'zh';
    const fallbackReplies = isZh
      ? ['*歪头看你*', '嗯?', '*眨眨眼*', '哦, 是你。', '*盯了你一眼*']
      : ['*tilts head*', 'hm?', '*blinks*', 'oh. you.', '*looks up*'];
    const reply = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
    return { ok: true, reply, mood: { ...soul.get().mood } };
  }
}

// ---------------------------------------------------------------------------
// Heartbeat — the pet's "inner voice" that decides to speak or not
// ---------------------------------------------------------------------------
async function heartbeat() {
  if (!config.hasApiKey()) return null;

  engine.tickMoodDecay();

  // v0.0.4: DEFAULT SILENCE — pets spend most time staring at walls.
  // 75% chance of silent exit BEFORE even calling AI. Combined with
  // model's own silence bias this should land at ~85% total silence.
  if (Math.random() < 0.75) return null;

  engine.generateProactiveContext();

  // Check proactive messages (engine-generated templates) first
  // v0.0.4: these are still valuable (break nudges, morning greetings)
  // but rate-limited by the silence gate above.
  const proactive = engine.getProactiveMessage();
  if (proactive) {
    session.addHeartbeat(proactive);
    return { commentary: proactive, action: 'speech-bubble' };
  }

  // Check drives — but only fire the question pool occasionally
  const s = soul.get();
  const cfg = config.get();
  const lastChat = s.stats.lastChatTime ? new Date(s.stats.lastChatTime).getTime() : 0;
  const hoursSinceChat = (Date.now() - lastChat) / 3600000;

  if (hoursSinceChat > 2.5 && Math.random() < 0.2) {  // v0.0.4: less aggressive (2.5h vs 1.5h, 20% vs 40%)
    const question = personality.pickQuestion(cfg.language || 'zh', s.askedQuestions || []);
    if (question) {
      s.askedQuestions = [...(s.askedQuestions || []), question];
      soul.save();
      session.addHeartbeat(question);
      return { commentary: question, action: 'speech-bubble' };
    }
  }

  // Let AI decide — feed last screen summary + recent observations for richer context
  const ctx = buildContext(null);
  const recentObs = session.getRecentObservationSummaries(5);
  const recallQuery = [_lastScreenSummary, ...recentObs].filter(Boolean).join(' ');
  ctx.activeMemories = await activeMemory.recall(
    recallQuery || 'general',
    { language: ctx.language },
  );
  // v0.0.4: anti-repetition for heartbeat includes recent heartbeat messages,
  // since they're excluded from main AI context but we still need to avoid loops
  ctx.recentPetMessages = [
    ...session.getRecentHeartbeatMessages(5),
    ...session.getRecentAssistantMessages(3),
  ].slice(-8);

  const messages = promptEngine.buildMessages('heartbeat', ctx, session);

  try {
    // v0.0.4: heartbeat uses same cheap/brief mini model as react.
    // gpt-5.4-mini doesn't accept custom temperature, so omit it.
    const reply = await provider.chat(messages, {
      purpose: 'react',
      maxTokens: 80,
      reasoningEffort: 'minimal',
    });
    if (reply && !reply.includes('[沉默]') && !reply.includes('[silent]') && reply.trim().length > 0) {
      session.addHeartbeat(reply);
      return { commentary: reply, action: 'speech-bubble' };
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// Chat — continuous conversation using full persistent context
// ---------------------------------------------------------------------------
async function chat(message) {
  if (!config.hasApiKey()) return { ok: false, error: 'No API key configured' };

  const ctx = buildContext(null);

  // Active Memory: recall relevant to this message
  ctx.activeMemories = await activeMemory.recall(message, { language: ctx.language });

  session.addUser(message);

  const messages = promptEngine.buildMessages('chat', ctx, session);

  try {
    const reply = await provider.chat(messages, { purpose: 'chat', maxTokens: 200, temperature: 0.9 });
    session.addAssistant(reply);

    await memory.addEpisode({
      type: 'chat',
      summary: `User: "${message.slice(0, 80)}" → Pet: "${reply.slice(0, 80)}"`,
      detail: reply,
      mood: soul.get().mood,
    });

    // Learn + evolve
    await activeMemory.storeExtractedFacts(message, reply);
    const signals = personality.detectSignals(message);
    const s = soul.get();
    for (const signal of signals) {
      s.evolvedTraits = personality.evolveTraits(s.evolvedTraits, signal);
    }
    s.stats.lastChatTime = new Date().toISOString();
    soul.recordInteraction('chat');
    engine.applyEvent(message.length > 50 ? 'chat-long' : 'chat-received');
    soul.save();

    if (session.needsCompaction(provider.getUsageStats().lastPromptTokens)) {
      session.compact().catch((err) => console.error('[observer] compaction failed:', err.message));
    }

    return { ok: true, reply, mood: { ...soul.get().mood } };
  } catch (err) {
    console.error('[observer] chat failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Onboarding — first-meeting conversation to learn about the user
// ---------------------------------------------------------------------------
async function onboardingChat(message, history = []) {
  if (!config.hasApiKey()) return { ok: false, error: 'No API key configured' };

  const cfg = config.get();
  const s = soul.get();

  const ctx = {
    petName: cfg.petName || s.name || 'Clawd',
    language: cfg.language || 'zh',
    archetype: s.archetype || 'playful',
    evolvedTraits: {},
    mood: { ...s.mood },
    trust: s.trust,
    longTermMemory: [],
    activeMemories: null,
    recentObservations: [],
    timeOfDay: engine.getTimeOfDay(),
    currentDrive: null,
    recentPetMessages: [],
    appCategory: 'other',
    dailySummary: null,
    onboardingHistory: history,
  };

  // Add user message to history
  if (message) {
    ctx.onboardingHistory = [...history, { role: 'user', content: message }];
  }

  const messages = promptEngine.buildMessages('onboarding', ctx, session);

  try {
    const reply = await provider.chat(messages, {
      purpose: 'chat',
      maxTokens: 500,
      temperature: 0.85,
    });

    // Check if the pet decided it's done (JSON response)
    let done = false;
    let result = null;
    try {
      // Try to parse as JSON (the pet signals completion with JSON)
      const jsonMatch = reply.match(/\{[\s\S]*"done"\s*:\s*true[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
        done = true;
      }
    } catch {}

    if (done && result) {
      // Onboarding complete — save learned info
      if (result.archetype) {
        const s = soul.get();
        s.archetype = result.archetype;
        s.evolvedTraits = {};
        soul.save();
      }
      if (result.petName) {
        const s = soul.get();
        s.name = result.petName;
        config.update({ petName: result.petName });
      }
      if (result.userName) {
        soul.addLongTermMemory(`主人的名字是${result.userName} / Owner's name is ${result.userName}`);
      }
      if (result.facts && Array.isArray(result.facts)) {
        for (const fact of result.facts.slice(0, 10)) {
          soul.addLongTermMemory(fact);
          await memory.addEpisode({ type: 'onboarding', summary: fact, mood: soul.get().mood });
        }
      }
      soul.save();

      return {
        ok: true,
        reply: result.reason || reply,
        done: true,
        archetype: result.archetype,
        userName: result.userName,
        petName: result.petName,
        facts: result.facts || [],
      };
    }

    return { ok: true, reply, done: false };
  } catch (err) {
    console.error('[observer] onboardingChat failed:', err.message);
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

export default { init, observe, reactToScreen, heartbeat, chat, onboardingChat, getChatHistory, getLastScreenSummary };
