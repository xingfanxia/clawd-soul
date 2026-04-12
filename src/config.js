import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Data directory — all clawd data lives in ~/.clawd/
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.clawd');

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Default config schema
// ---------------------------------------------------------------------------
const DEFAULTS = {
  petName: 'Clawd',
  language: 'en',            // 'en' | 'zh'
  provider: 'azure-openai',  // 'azure-openai' | 'openai' | 'gemini' | 'claude'

  // Azure OpenAI
  azureOpenaiKey: '',
  azureOpenaiEndpoint: '',
  azureOpenaiApiVersion: '2024-12-01-preview',
  azureOpenaiDeploymentObserve: 'gpt-5.4-nano-standard',
  azureOpenaiDeploymentChat: 'gpt-5.4-mini-standard',
  azureOpenaiDeploymentReason: 'gpt-5.4-standard',

  // OpenAI
  openaiKey: '',
  openaiModelObserve: 'gpt-4o-mini',
  openaiModelChat: 'gpt-4o-mini',

  // Gemini
  geminiKey: '',
  geminiModelObserve: 'gemini-2.0-flash',
  geminiModelChat: 'gemini-2.0-flash',

  // Claude
  claudeKey: '',
  claudeModelObserve: 'claude-sonnet-4-5-20250514',
  claudeModelChat: 'claude-sonnet-4-5-20250514',

  // Embeddings (always Gemini — cheap & good)
  geminiEmbeddingKey: '',

  // Observation settings
  observeIntervalMs: 30000,     // 30s between observations
  observeOnAppSwitch: true,
  maxCommentaryLength: 200,

  // Personality
  proactivenessLevel: 'quiet',  // 'silent' | 'quiet' | 'companion' | 'chatty'
};

// Secret fields that should never be exposed via GET /config
const SECRET_FIELDS = new Set([
  'azureOpenaiKey', 'openaiKey', 'geminiKey', 'claudeKey', 'geminiEmbeddingKey',
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _config = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Ensure data directory exists */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Load config from disk + env vars. Creates defaults if missing. */
function load() {
  ensureDataDir();

  let disk = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      console.error('[config] corrupt config.json, using defaults');
    }
  }

  // Merge: defaults ← disk ← env vars (env wins)
  _config = { ...DEFAULTS, ...disk };

  // Env var overrides (for dev / CI)
  const envMap = {
    AI_PROVIDER:                      'provider',
    AZURE_OPENAI_KEY:                 'azureOpenaiKey',
    AZURE_OPENAI_ENDPOINT:            'azureOpenaiEndpoint',
    AZURE_OPENAI_API_VERSION:         'azureOpenaiApiVersion',
    AZURE_OPENAI_DEPLOYMENT_OBSERVE:  'azureOpenaiDeploymentObserve',
    AZURE_OPENAI_DEPLOYMENT_CHAT:     'azureOpenaiDeploymentChat',
    AZURE_OPENAI_DEPLOYMENT_REASON:   'azureOpenaiDeploymentReason',
    OPENAI_API_KEY:                   'openaiKey',
    OPENAI_MODEL_OBSERVE:             'openaiModelObserve',
    OPENAI_MODEL_CHAT:                'openaiModelChat',
    GEMINI_API_KEY:                   'geminiKey',
    GEMINI_MODEL_OBSERVE:             'geminiModelObserve',
    GEMINI_MODEL_CHAT:                'geminiModelChat',
    CLAUDE_API_KEY:                   'claudeKey',
    CLAUDE_MODEL_OBSERVE:             'claudeModelObserve',
    CLAUDE_MODEL_CHAT:                'claudeModelChat',
    GEMINI_EMBEDDING_KEY:             'geminiEmbeddingKey',
  };

  for (const [envKey, configKey] of Object.entries(envMap)) {
    if (process.env[envKey]) {
      _config[configKey] = process.env[envKey];
    }
  }

  // Embedding key falls back to gemini key
  if (!_config.geminiEmbeddingKey && _config.geminiKey) {
    _config.geminiEmbeddingKey = _config.geminiKey;
  }

  return _config;
}

/** Save current config to disk (secrets included — it's the user's local file) */
function save() {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2), 'utf8');
}

/** Get full config (internal use) */
function get() {
  if (!_config) load();
  return _config;
}

/** Get config safe for API response (no secrets) */
function getSafe() {
  const cfg = get();
  const safe = {};
  for (const [k, v] of Object.entries(cfg)) {
    safe[k] = SECRET_FIELDS.has(k) ? (v ? '••••' : '') : v;
  }
  return safe;
}

/** Partial update — merges provided fields into config */
function update(partial) {
  const cfg = get();
  for (const [k, v] of Object.entries(partial)) {
    if (k in DEFAULTS) {
      cfg[k] = v;
    }
  }
  save();
  return cfg;
}

/** Check if the current provider has a valid API key configured */
function hasApiKey() {
  const cfg = get();
  switch (cfg.provider) {
    case 'azure-openai': return !!(cfg.azureOpenaiKey && cfg.azureOpenaiEndpoint);
    case 'openai':       return !!cfg.openaiKey;
    case 'gemini':       return !!cfg.geminiKey;
    case 'claude':       return !!cfg.claudeKey;
    default:             return false;
  }
}

/** Check if embedding is available */
function hasEmbeddingKey() {
  const cfg = get();
  return !!(cfg.geminiEmbeddingKey || cfg.geminiKey);
}

export default { DATA_DIR, load, save, get, getSafe, update, hasApiKey, hasEmbeddingKey };
