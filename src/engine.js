import config from './config.js';
import soul from './soul-file.js';
import memory from './memory.js';
import provider from './provider.js';

// ---------------------------------------------------------------------------
// Mood decay — moods drift toward baseline over time
// ---------------------------------------------------------------------------
const MOOD_BASELINE = { energy: 0.5, interest: 0.5, affection: 0.3 };
const DECAY_RATE = 0.02; // per tick (~30s)

let _lastDecayTime = Date.now();

/** Tick mood decay toward baseline */
function tickMoodDecay() {
  const now = Date.now();
  const elapsed = now - _lastDecayTime;
  if (elapsed < 25000) return; // don't decay faster than ~25s
  _lastDecayTime = now;

  const s = soul.get();
  for (const [axis, baseline] of Object.entries(MOOD_BASELINE)) {
    const current = s.mood[axis];
    const diff = baseline - current;
    if (Math.abs(diff) > 0.01) {
      s.mood[axis] = current + diff * DECAY_RATE;
    }
  }
}

// ---------------------------------------------------------------------------
// Event → mood effects
// ---------------------------------------------------------------------------
const MOOD_EFFECTS = {
  'observation-interesting': { energy: 0.05, interest: 0.1, affection: 0.02 },
  'observation-boring':      { energy: -0.03, interest: -0.05 },
  'observation-silent':      { energy: -0.01 },
  'chat-received':           { energy: 0.1, interest: 0.08, affection: 0.05 },
  'chat-long':               { energy: 0.15, interest: 0.1, affection: 0.08 },
  'pet-clicked':             { energy: 0.05, affection: 0.03 },
  'user-returned':           { energy: 0.1, interest: 0.05, affection: 0.05 },
  'user-absent-long':        { energy: -0.1, interest: -0.05, affection: -0.02 },
  'diary-written':           { energy: -0.05, affection: 0.02 },
  'morning':                 { energy: 0.3, interest: 0.1 },
  'night':                   { energy: -0.2, interest: -0.1 },
};

/** Apply a mood event */
function applyEvent(eventName) {
  const effects = MOOD_EFFECTS[eventName];
  if (!effects) return;
  soul.updateMood(effects);

  // Trust grows with positive interactions
  const trustGrowth = {
    'chat-received': 0.015,
    'chat-long': 0.025,
    'pet-clicked': 0.01,
    'user-returned': 0.01,
    'observation-interesting': 0.005,
  };
  if (trustGrowth[eventName]) {
    soul.addTrust(trustGrowth[eventName]);
  }
}

// ---------------------------------------------------------------------------
// Time-of-day awareness
// ---------------------------------------------------------------------------
let _lastObservationTime = 0;
let _todayGreeted = false;
let _lastBreakNudge = 0;
let _continuousWorkStart = 0;

const BREAK_NUDGE_AFTER_MS = 90 * 60 * 1000;    // 90 min continuous work
const BREAK_NUDGE_COOLDOWN_MS = 60 * 60 * 1000;  // don't re-nudge for 60 min
const ABSENCE_THRESHOLD_MS = 30 * 60 * 1000;     // 30 min = "long absence"

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/** Called on every observation — tracks timing for greetings/breaks */
function recordObservationTime() {
  const now = Date.now();
  const gap = _lastObservationTime > 0 ? now - _lastObservationTime : 0;
  _lastObservationTime = now;

  // Reset daily greeting at day boundary
  const today = new Date().toDateString();
  if (!_todayGreeted || _greetingDate !== today) {
    _todayGreeted = false;
    _greetingDate = today;
  }

  // Track continuous work
  if (gap > ABSENCE_THRESHOLD_MS || gap === 0) {
    _continuousWorkStart = now; // reset on long gap or first observation
  }

  return { gap, timeOfDay: getTimeOfDay() };
}
let _greetingDate = '';

// ---------------------------------------------------------------------------
// Proactiveness decisions
// ---------------------------------------------------------------------------
const PROACTIVE_THRESHOLDS = {
  silent: Infinity,     // never proactive
  quiet: 0.45,          // was 0.75 — too aggressive, pet almost never spoke
  companion: 0.3,       // moderate threshold
  chatty: 0.15,         // almost always has something to say
};

/** Pending proactive message queue */
let _proactiveQueue = [];

/** Set a proactive message (from observation that the pet wants to share) */
function setProactiveMessage(message, priority = 0) {
  _proactiveQueue.push({ message, priority, expiry: Date.now() + 120000 });
  // Sort by priority descending, keep max 3
  _proactiveQueue.sort((a, b) => b.priority - a.priority);
  if (_proactiveQueue.length > 3) _proactiveQueue.length = 3;
}

/** Check if the pet wants to say something unprompted */
function getProactiveMessage() {
  // Prune expired
  const now = Date.now();
  _proactiveQueue = _proactiveQueue.filter((m) => now < m.expiry);

  if (_proactiveQueue.length === 0) return null;
  return _proactiveQueue.shift().message;
}

/**
 * Generate context-aware proactive messages based on time/absence/breaks.
 * Called periodically by the server's proactive poll.
 */
function generateProactiveContext() {
  const now = Date.now();
  const s = soul.get();
  const cfg = config.get();
  const lang = cfg.language || 'en';
  const name = cfg.petName || s.name || 'Clawd';
  const tod = getTimeOfDay();

  // Morning greeting (once per day, first poll of the morning)
  if (!_todayGreeted && (tod === 'morning' || tod === 'afternoon')) {
    _todayGreeted = true;
    _greetingDate = new Date().toDateString();
    applyEvent('morning');

    const greetings = lang === 'zh'
      ? [`*伸懒腰* 早上好呀～今天也要加油哦！`, `*揉揉眼睛* 新的一天开始啦！`, `*挥挥小钳子* 早安！今天想做什么呢？`]
      : [`*stretches claws* Good morning! Ready for a new day!`, `*yawns and waves* Hey, you're here! Let's go!`, `*clicks claws excitedly* Morning! What are we up to today?`];
    setProactiveMessage(greetings[Math.floor(Math.random() * greetings.length)], 2);
  }

  // Break nudge (after 90min continuous work)
  if (_continuousWorkStart > 0 && (now - _continuousWorkStart) > BREAK_NUDGE_AFTER_MS) {
    if ((now - _lastBreakNudge) > BREAK_NUDGE_COOLDOWN_MS) {
      _lastBreakNudge = now;
      const nudges = lang === 'zh'
        ? [`*拉拉你的袖子* 你已经工作好久了，休息一下吧～`, `*担心地看着你* 要不要站起来活动活动？`]
        : [`*tugs your sleeve* You've been working a while... maybe take a break?`, `*looks up worried* Hey, stretch your legs? You've been at it for a while!`];
      setProactiveMessage(nudges[Math.floor(Math.random() * nudges.length)], 1);
    }
  }

  // Night time mood
  if (tod === 'night' && s.mood.energy > 0.4) {
    // Occasionally comment about it being late
    if (Math.random() < 0.1) { // ~10% chance per poll
      const nightMsgs = lang === 'zh'
        ? [`*打哈欠* 好晚了呢...你也早点休息吧`, `*眯起眼睛* 夜深了哦～`]
        : [`*yawns* It's getting late... don't stay up too long!`, `*blinks sleepily* It's pretty late, you know...`];
      setProactiveMessage(nightMsgs[Math.floor(Math.random() * nightMsgs.length)], 0);
    }
  }
}

/**
 * Handle user return after absence.
 * @param {number} gapMs - milliseconds since last observation
 */
function handleUserReturn(gapMs) {
  if (gapMs < ABSENCE_THRESHOLD_MS) return;

  applyEvent('user-returned');

  const lang = (config.get().language) || 'en';
  const hours = Math.floor(gapMs / 3600000);
  const mins = Math.floor((gapMs % 3600000) / 60000);

  let msg;
  if (hours > 0) {
    msg = lang === 'zh'
      ? `*兴奋地挥钳子* 你回来啦！你走了 ${hours} 个多小时，我好无聊哦～`
      : `*waves claws excitedly* You're back! You were gone for ${hours}+ hours, I was so bored!`;
  } else {
    msg = lang === 'zh'
      ? `*探头看看* 欢迎回来！离开了 ${mins} 分钟呢～`
      : `*peeks up* Welcome back! You were away for ${mins} minutes~`;
  }
  setProactiveMessage(msg, 2);
}

/** Get the current proactiveness level name */
function getProactivenessLevel() {
  const s = soul.get();
  const cfg = config.get();
  return s.proactivenessOverride || cfg.proactivenessLevel;
}

// ---------------------------------------------------------------------------
// Personality context for prompts
// ---------------------------------------------------------------------------

/** Get personality context for prompt building */
function getPersonalityContext() {
  const s = soul.get();
  const cfg = config.get();
  return {
    petName: cfg.petName || s.name,
    language: cfg.language,
    mood: { ...s.mood },
    trust: s.trust,
    longTermMemory: [...(s.longTermMemory || [])],
    archetype: s.archetype || 'playful',
    evolvedTraits: { ...s.evolvedTraits },
  };
}

// ---------------------------------------------------------------------------
// Nightly memory consolidation — "dreaming" pass
// ---------------------------------------------------------------------------

async function consolidateMemories() {
  const todayEpisodes = memory.getTodayEpisodes();
  if (todayEpisodes.length === 0) return { ok: true, promoted: 0 };

  const cfg = config.get();
  const isZh = (cfg.language || 'zh') === 'zh';

  const prompt = isZh
    ? '回顾今天的观察和对话。选出3-5个最值得长期记住的关于主人的事实。重点：个人偏好、生活事件、关系进展、重复出现的模式。每行一条，简洁。'
    : 'Review today\'s observations and conversations. Pick 3-5 facts most worth remembering long-term about the owner. Focus on: personal preferences, life events, relationship milestones, recurring patterns. One fact per line, concise.';

  try {
    const result = await provider.chat([
      { role: 'system', content: prompt },
      { role: 'user', content: todayEpisodes.map((e) => e.summary).join('\n') },
    ], { purpose: 'reason', maxTokens: 300, temperature: 0.3 });

    const facts = result.split('\n').filter((f) => f.trim().length > 5);
    let promoted = 0;
    for (const fact of facts.slice(0, 5)) {
      const clean = fact.replace(/^[-•*\d.]\s*/, '').trim();
      if (clean.length > 5) {
        soul.addLongTermMemory(clean);
        promoted++;
      }
    }

    soul.get().lastConsolidation = new Date().toISOString();
    soul.save();

    console.log(`[engine] consolidated ${promoted} memories`);
    return { ok: true, promoted };
  } catch (err) {
    console.error('[engine] consolidation failed:', err.message);
    return { ok: false, error: err.message, promoted: 0 };
  }
}

export default {
  tickMoodDecay,
  applyEvent,
  consolidateMemories,
  setProactiveMessage,
  getProactiveMessage,
  getProactivenessLevel,
  getPersonalityContext,
  recordObservationTime,
  generateProactiveContext,
  handleUserReturn,
  getTimeOfDay,
};
