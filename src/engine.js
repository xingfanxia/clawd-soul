import config from './config.js';
import soul from './soul-file.js';

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
  const trustEvents = new Set(['chat-received', 'chat-long', 'pet-clicked', 'user-returned']);
  if (trustEvents.has(eventName)) {
    soul.addTrust(0.005);
  }
}

// ---------------------------------------------------------------------------
// Proactiveness decisions
// ---------------------------------------------------------------------------
const PROACTIVE_THRESHOLDS = {
  silent: Infinity,     // never proactive
  quiet: 0.75,          // only when very interested + energetic
  companion: 0.5,       // moderate threshold
  chatty: 0.25,         // almost always has something to say
};

/** Pending proactive message, if any */
let _proactiveMessage = null;
let _proactiveExpiry = 0;

/** Set a proactive message (from observation that the pet wants to share) */
function setProactiveMessage(message) {
  _proactiveMessage = message;
  _proactiveExpiry = Date.now() + 120000; // expires in 2 min
}

/** Check if the pet wants to say something unprompted */
function getProactiveMessage() {
  if (!_proactiveMessage) return null;
  if (Date.now() > _proactiveExpiry) {
    _proactiveMessage = null;
    return null;
  }
  const msg = _proactiveMessage;
  _proactiveMessage = null;
  return msg;
}

/** Should the pet comment on this observation? */
function shouldComment() {
  const s = soul.get();
  const cfg = config.get();
  const level = s.proactivenessOverride || cfg.proactivenessLevel;
  const threshold = PROACTIVE_THRESHOLDS[level] ?? 0.5;

  // Score based on mood
  const score = (s.mood.energy * 0.4 + s.mood.interest * 0.4 + s.mood.affection * 0.2);
  return score >= threshold;
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
    semanticMemory: [...s.semanticMemory],
  };
}

export default {
  tickMoodDecay,
  applyEvent,
  shouldComment,
  setProactiveMessage,
  getProactiveMessage,
  getProactivenessLevel,
  getPersonalityContext,
};
