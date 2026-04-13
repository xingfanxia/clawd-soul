import memory from './memory.js';
import soul from './soul-file.js';

// ---------------------------------------------------------------------------
// Recall relevant memories for prompt injection
// ---------------------------------------------------------------------------

/**
 * Returns formatted string of recalled memories, or null if nothing relevant.
 * Used for injecting context before every reply.
 */
async function recall(query, options = {}) {
  const { limit = 5, threshold = 0.2, language = 'zh' } = options;

  if (!query || query.trim().length < 3) return null;

  const results = await memory.autoRecall(query, limit);
  if (!results || results.length === 0) return null;

  // Filter by score threshold
  const relevant = results.filter((r) => r.combinedScore >= threshold);
  if (relevant.length === 0) return null;

  // Format as natural prompt injection with relative timestamps
  const isZh = language === 'zh';
  const now = Date.now();
  const lines = relevant.map((r) => {
    const age = Math.floor((now - new Date(r.timestamp).getTime()) / 86400000);
    const timeLabel = age === 0
      ? (isZh ? '今天' : 'today')
      : age === 1
        ? (isZh ? '昨天' : 'yesterday')
        : age < 7
          ? (isZh ? `${age}天前` : `${age} days ago`)
          : (isZh ? `${Math.floor(age / 7)}周前` : `${Math.floor(age / 7)} weeks ago`);
    return `- ${timeLabel}: ${r.summary}`;
  });

  const header = isZh ? '[你记得的事]' : '[Things you remember]';
  return `${header}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Extract memorable facts from a conversation turn
// ---------------------------------------------------------------------------

/** Personal fact patterns to detect */
const PERSONAL_PATTERNS = [
  { pattern: /my name is|i am|i'm|我叫|我是/, type: 'identity' },
  { pattern: /i like|i love|i enjoy|我喜欢|我爱|我最爱/, type: 'preference' },
  { pattern: /i work|my job|i'm a|我工作|我做|我的工作/, type: 'work' },
  { pattern: /i hate|i don't like|我讨厌|我不喜欢/, type: 'dislike' },
  { pattern: /i live|i'm from|我住|我来自|我在/, type: 'location' },
  { pattern: /i study|i'm learning|我在学|我学/, type: 'learning' },
  { pattern: /my favorite|最喜欢|最爱的/, type: 'favorite' },
  { pattern: /i feel|i'm feeling|我觉得|我感觉/, type: 'feeling' },
  { pattern: /today i|今天我/, type: 'activity' },
];

/**
 * Extract memorable facts from a conversation turn.
 * Returns array of fact strings to store as episodes.
 */
function extract(userMessage, _petReply) {
  if (!userMessage) return [];

  const lower = userMessage.toLowerCase();

  for (const { pattern } of PERSONAL_PATTERNS) {
    if (pattern.test(lower)) {
      return [userMessage.slice(0, 150)];  // one fact per message is enough
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Store extracted facts as episodes
// ---------------------------------------------------------------------------

/** Store extracted facts as personal-fact episodes */
async function storeExtractedFacts(userMessage, petReply) {
  const facts = extract(userMessage, petReply);
  for (const fact of facts) {
    await memory.addEpisode({
      type: 'personal-fact',
      summary: fact,
      mood: soul.get().mood,
    });
  }
  return facts;
}

export default { recall, extract, storeExtractedFacts };
