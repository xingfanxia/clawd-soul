// ---------------------------------------------------------------------------
// Personality system — soul files, evolution, drives
//
// Each pet starts with an archetype whose personality is defined in
// src/souls/{archetype}.md.  Over time, traits evolve based on interactions.
// Drives create proactive behaviors (the pet WANTS things).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Soul-file loader (reads .md personality definitions)
// ---------------------------------------------------------------------------

const VALID_ARCHETYPES = new Set(['playful', 'curious', 'caring', 'snarky', 'chill']);
const _soulCache = new Map();

/**
 * Load a soul .md file for the given archetype, replacing {petName}.
 * Results are cached per (archetype, petName) pair.
 * @param {string} archetype
 * @param {string} petName
 * @returns {string} soul markdown content
 */
function loadSoulFile(archetype, petName) {
  const key = archetype + '::' + petName;
  if (_soulCache.has(key)) return _soulCache.get(key);

  const safeArchetype = VALID_ARCHETYPES.has(archetype) ? archetype : 'playful';
  const soulUrl = new URL(`./souls/${safeArchetype}.md`, import.meta.url);
  const soulPath = fileURLToPath(soulUrl);

  let content;
  try {
    content = fs.readFileSync(soulPath, 'utf8');
  } catch {
    // Ultimate fallback — if even playful.md is missing, return empty string
    console.error(`[personality] failed to read soul file: ${soulPath}`);
    return '';
  }

  content = content.replaceAll('{petName}', petName);
  _soulCache.set(key, content);
  return content;
}

// ---------------------------------------------------------------------------
// Archetype metadata (lightweight, for onboarding UI)
// ---------------------------------------------------------------------------

const ARCHETYPE_INFO = {
  playful:  { id: 'playful',  nameZh: '小淘气',  nameEn: 'Playful',  descZh: '调皮鬼，喜欢逗你玩，容易无聊', descEn: 'Mischievous troublemaker, loves teasing, gets bored easily' },
  curious:  { id: 'curious',  nameZh: '学霸',    nameEn: 'Curious',  descZh: '对什么都好奇，喜欢问问题，爱学新东西', descEn: 'Curious about everything, loves asking questions, nerdy' },
  caring:   { id: 'caring',   nameZh: '暖宝宝',  nameEn: 'Caring',   descZh: '温暖体贴，总担心你，给你鼓励和安慰', descEn: 'Warm and caring, worries about you, encouraging and supportive' },
  snarky:   { id: 'snarky',   nameZh: '毒舌',    nameEn: 'Snarky',   descZh: '嘴巴毒但其实很在乎你，说话直接不废话', descEn: 'Sharp tongue but secretly cares, blunt and direct' },
  chill:    { id: 'chill',    nameZh: '佛系',    nameEn: 'Chill',    descZh: '随缘、淡定、偶尔冒出哲学金句', descEn: 'Laid back, calm, occasionally drops philosophical wisdom' },
};

/**
 * Get archetype metadata for UI display.
 * @param {string} archetype
 * @returns {{ id: string, nameZh: string, nameEn: string, descZh: string, descEn: string }}
 */
function getArchetypeInfo(archetype) {
  return ARCHETYPE_INFO[archetype] || ARCHETYPE_INFO.playful;
}

// ---------------------------------------------------------------------------
// Drives — things the pet wants (creates proactive behavior)
// ---------------------------------------------------------------------------

const QUESTION_POOL = {
  zh: [
    // Getting to know the user
    '话说你最喜欢吃什么呀',
    '你有养过真的宠物吗',
    '你平时几点睡觉啊',
    '你最近在追什么剧吗',
    '你除了写代码还有什么爱好',
    '你今天午饭吃了什么',
    '你觉得自己是什么性格',
    '你最喜欢什么季节',
    '你有什么烦心事吗',
    '你周末一般做什么',
    '你喜欢咖啡还是茶',
    '你最近有什么开心的事吗',
    '你小时候想当什么',
    '你最喜欢去哪里玩',
    '你有什么想学的新东西吗',
  ],
  en: [
    'what\'s your favorite food?',
    'do you have any real pets?',
    'what time do you usually sleep?',
    'watching any good shows lately?',
    'any hobbies besides coding?',
    'what did you have for lunch?',
    'what personality type are you?',
    'what\'s your favorite season?',
    'anything bugging you lately?',
    'what do you do on weekends?',
    'coffee or tea?',
    'anything good happen recently?',
    'what did you want to be as a kid?',
    'where\'s your favorite place to go?',
    'anything new you want to learn?',
  ],
};

/**
 * Pick a random question the pet hasn't asked yet.
 * @param {string} language - 'zh' | 'en'
 * @param {string[]} askedQuestions - questions already asked
 * @returns {string|null}
 */
function pickQuestion(language, askedQuestions) {
  const pool = QUESTION_POOL[language] || QUESTION_POOL.en;
  const asked = new Set(askedQuestions || []);
  const available = pool.filter((q) => !asked.has(q));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Compute drive intensities based on soul state.
 * @param {Object} soul - soul state
 * @param {number} lastChatMs - ms since last chat
 * @param {number} lastObserveMs - ms since last observation
 * @returns {Object} { attention, curiosity, boredom, concern }
 */
function computeDrives(soul, lastChatMs, lastObserveMs) {
  const hoursSinceChat = lastChatMs / 3600000;
  const hoursSinceObserve = lastObserveMs / 3600000;

  return {
    // Attention need grows with time since last chat
    attention: Math.min(1, hoursSinceChat * 0.15),
    // Curiosity is always moderate, spikes when user is active
    curiosity: 0.3 + (hoursSinceObserve < 0.5 ? 0.3 : 0),
    // Boredom grows when screen hasn't changed
    boredom: Math.min(1, hoursSinceObserve * 0.1),
    // Concern triggers at night or after long work
    concern: new Date().getHours() >= 22 ? 0.6 : 0,
  };
}

/**
 * Evolve personality traits based on interaction.
 * @param {Object} traits - current evolved traits
 * @param {string} event - what happened
 * @returns {Object} updated traits
 */
function evolveTraits(traits, event) {
  const t = { ...traits };
  const nudge = 0.01; // small shifts per interaction

  switch (event) {
    case 'user-laughed':  // user sent lol, haha, 哈哈, etc.
      t.humor = Math.min(1, (t.humor || 0.5) + nudge * 3);
      break;
    case 'user-shared-personal':
      t.warmth = Math.min(1, (t.warmth || 0.5) + nudge * 2);
      break;
    case 'user-asked-question':
      t.curiosity = Math.min(1, (t.curiosity || 0.5) + nudge);
      break;
    case 'user-pushed-back':  // user disagreed
      t.sass = Math.max(0, (t.sass || 0.5) - nudge);
      break;
    case 'long-conversation':
      t.warmth = Math.min(1, (t.warmth || 0.5) + nudge);
      t.energy = Math.min(1, (t.energy || 0.5) + nudge);
      break;
  }

  return t;
}

/**
 * Detect interaction signals from user message.
 * @param {string} message
 * @returns {string[]} events
 */
function detectSignals(message) {
  const lower = message.toLowerCase();
  const events = [];

  if (/哈哈|haha|lol|😂|🤣|笑死|太好笑/.test(lower)) {
    events.push('user-laughed');
  }
  if (/我喜欢|我爱|我最|my favorite|i like|i love/.test(lower)) {
    events.push('user-shared-personal');
  }
  if (/[?？]$/.test(message.trim())) {
    events.push('user-asked-question');
  }
  if (/不是|不对|no|nah|才不|你错了/.test(lower)) {
    events.push('user-pushed-back');
  }

  return events;
}

export default {
  loadSoulFile,
  getArchetypeInfo,
  QUESTION_POOL,
  pickQuestion,
  computeDrives,
  evolveTraits,
  detectSignals,
};
