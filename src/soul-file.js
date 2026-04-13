import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

const SOUL_PATH = () => path.join(config.DATA_DIR, 'soul.json');

// ---------------------------------------------------------------------------
// Default soul — a brand-new Clawd
// ---------------------------------------------------------------------------
const DEFAULT_SOUL = () => ({
  version: 3,
  name: config.get().petName || 'Clawd',
  createdAt: new Date().toISOString(),

  // Personality archetype ('playful' | 'curious' | 'caring' | 'snarky' | 'chill')
  archetype: 'playful',

  // Evolved traits (shift over time based on interactions, 0–1)
  evolvedTraits: {},

  // Mood axes (0.0–1.0)
  mood: {
    energy: 0.5,
    interest: 0.5,
    affection: 0.3,
  },

  // Trust grows with interactions (0.0–1.0)
  trust: 0.0,

  // Long-term memory — curated facts about the user (max 100)
  longTermMemory: [],

  // Timestamp of last memory consolidation
  lastConsolidation: null,

  // Questions the pet has already asked (for drive system)
  askedQuestions: [],

  // Stats
  stats: {
    totalObservations: 0,
    totalChats: 0,
    totalDiaryEntries: 0,
    firstInteraction: null,
    lastInteraction: null,
    lastChatTime: null,
  },

  // Proactiveness level override (null = use config default)
  proactivenessOverride: null,
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _soul = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load soul from disk, or create a fresh one */
function load() {
  const soulPath = SOUL_PATH();
  if (fs.existsSync(soulPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(soulPath, 'utf8'));
      // Merge with defaults to pick up any new fields from upgrades
      _soul = { ...DEFAULT_SOUL(), ...raw, mood: { ...DEFAULT_SOUL().mood, ...raw.mood }, stats: { ...DEFAULT_SOUL().stats, ...raw.stats } };

      // --- v1/v2 → v3 migration ---
      if (_soul.version < 3) {
        // Rename semanticMemory → longTermMemory
        if (Array.isArray(_soul.semanticMemory)) {
          _soul.longTermMemory = _soul.semanticMemory;
        }
        delete _soul.semanticMemory;
        // Remove dead fields
        delete _soul.catchphrases;
        if (_soul.stats) delete _soul.stats.daysActive;
        // Ensure new fields exist
        if (_soul.lastConsolidation === undefined) _soul.lastConsolidation = null;
        _soul.version = 3;
        save();
      }
    } catch {
      console.error('[soul] corrupt soul.json, creating fresh soul');
      _soul = DEFAULT_SOUL();
    }
  } else {
    _soul = DEFAULT_SOUL();
  }
  return _soul;
}

/** Save soul to disk */
function save() {
  config.load(); // ensure data dir exists
  fs.writeFileSync(SOUL_PATH(), JSON.stringify(_soul, null, 2), 'utf8');
}

/** Get current soul (loads if needed) */
function get() {
  if (!_soul) load();
  return _soul;
}

/** Export soul as a portable JSON object */
function exportSoul() {
  return { ...get(), exportedAt: new Date().toISOString() };
}

/** Import soul from a portable JSON object */
function importSoul(soulData) {
  if (!soulData || typeof soulData !== 'object') {
    throw new Error('Invalid soul data');
  }
  if (!soulData.name || !soulData.createdAt) {
    throw new Error('Soul data missing required fields (name, createdAt)');
  }
  _soul = { ...DEFAULT_SOUL(), ...soulData };
  delete _soul.exportedAt;
  save();
  return _soul;
}

/** Update mood values (clamped 0–1) */
function updateMood(changes) {
  const soul = get();
  for (const [axis, delta] of Object.entries(changes)) {
    if (axis in soul.mood) {
      soul.mood[axis] = Math.max(0, Math.min(1, soul.mood[axis] + delta));
    }
  }
  return soul.mood;
}

/** Set mood to absolute values (clamped 0–1) */
function setMood(values) {
  const soul = get();
  for (const [axis, value] of Object.entries(values)) {
    if (axis in soul.mood) {
      soul.mood[axis] = Math.max(0, Math.min(1, value));
    }
  }
  return soul.mood;
}

/** Increment trust (clamped 0–1) */
function addTrust(delta) {
  const soul = get();
  soul.trust = Math.max(0, Math.min(1, soul.trust + delta));
  return soul.trust;
}

/** Record an interaction for stats */
function recordInteraction(type) {
  const soul = get();
  const now = new Date().toISOString();
  soul.stats.lastInteraction = now;
  if (!soul.stats.firstInteraction) {
    soul.stats.firstInteraction = now;
  }
  if (type === 'observation') soul.stats.totalObservations++;
  if (type === 'chat') soul.stats.totalChats++;
  if (type === 'diary') soul.stats.totalDiaryEntries++;
}

/** Add a long-term memory (deduped, max 100, FIFO eviction, immutable) */
function addLongTermMemory(text) {
  const soul = get();
  const memories = soul.longTermMemory || [];
  // Skip if similar text already exists (exact match)
  if (memories.includes(text)) return;
  // Create new array (immutable) — evict oldest if at capacity
  const updated = memories.length >= 100
    ? [...memories.slice(1), text]
    : [...memories, text];
  soul.longTermMemory = updated;
}

/** @deprecated Use addLongTermMemory — backward compat alias */
function addSemanticMemory(text) {
  addLongTermMemory(text);
}

export default {
  load, save, get, exportSoul, importSoul,
  updateMood, setMood, addTrust,
  recordInteraction, addLongTermMemory, addSemanticMemory,
};
