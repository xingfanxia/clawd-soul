import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

const SOUL_PATH = () => path.join(config.DATA_DIR, 'soul.json');

// ---------------------------------------------------------------------------
// Default soul — a brand-new Clawd
// ---------------------------------------------------------------------------
const DEFAULT_SOUL = () => ({
  version: 1,
  name: config.get().petName || 'Clawd',
  createdAt: new Date().toISOString(),

  // Mood axes (0.0–1.0)
  mood: {
    energy: 0.5,
    interest: 0.5,
    affection: 0.3,
  },

  // Trust grows with interactions (0.0–1.0)
  trust: 0.0,

  // Semantic memory — key phrases the pet remembers about the user
  semanticMemory: [],

  // Catchphrases the pet has developed
  catchphrases: [],

  // Stats
  stats: {
    totalObservations: 0,
    totalChats: 0,
    totalDiaryEntries: 0,
    daysActive: 0,
    firstInteraction: null,
    lastInteraction: null,
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

/** Add a semantic memory (deduped, max 50) */
function addSemanticMemory(text) {
  const soul = get();
  if (soul.semanticMemory.includes(text)) return;
  soul.semanticMemory.push(text);
  if (soul.semanticMemory.length > 50) {
    soul.semanticMemory.shift();
  }
}

export default {
  load, save, get, exportSoul, importSoul,
  updateMood, setMood, addTrust,
  recordInteraction, addSemanticMemory,
};
