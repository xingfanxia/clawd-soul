// ---------------------------------------------------------------------------
// Chat session — persistent conversation with JSONL history + compaction
//
// Every message (user, assistant, observation) is appended to a JSONL file.
// The full conversation is loaded into every AI call as context.
// When the conversation approaches the token limit, older messages are
// compacted into a summary.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import provider from './provider.js';
import memory from './memory.js';
import soul from './soul-file.js';

const HISTORY_FILE = () => path.join(config.DATA_DIR, 'chat-history.jsonl');
const SUMMARY_FILE = () => path.join(config.DATA_DIR, 'chat-summary.json');

// ---------------------------------------------------------------------------
// Token management
//
// gpt-5.4-mini has a large context window. We target ~500k tokens for
// compaction. Approximation: 1 Chinese char ≈ 1.5 tokens, 1 English char ≈ 0.3 tokens.
// Conservative estimate: 1 char ≈ 1 token for mixed content.
//
// Cache hit strategy: keep the system prompt + summary STABLE at the top
// of the message array. Azure/OpenAI cache input prefix — if the first N
// tokens are identical between calls, they get a cache hit (cheaper + faster).
// So: [system prompt (stable)] + [summary (stable)] + [history (grows)] + [new msg]
// The stable prefix maximizes cache hits.
// ---------------------------------------------------------------------------
const TOKEN_LIMIT = 500000;           // compact at 500k tokens
const CHARS_PER_TOKEN = 1;            // conservative: 1 char ≈ 1 token
const COMPACT_THRESHOLD_CHARS = TOKEN_LIMIT * CHARS_PER_TOKEN;
const KEEP_RECENT_MESSAGES = 50;      // keep last 50 messages intact after compaction

// ---------------------------------------------------------------------------
// In-memory state (loaded from disk on init)
// ---------------------------------------------------------------------------
let _messages = [];    // full message history [{role, content, ts, type?}]
let _summary = null;   // compacted summary of older messages
let _loaded = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load chat history from JSONL file */
function load() {
  _messages = [];
  _summary = null;

  // Load summary
  const summaryPath = SUMMARY_FILE();
  if (fs.existsSync(summaryPath)) {
    try {
      _summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    } catch {
      _summary = null;
    }
  }

  // Load JSONL history
  const historyPath = HISTORY_FILE();
  if (fs.existsSync(historyPath)) {
    try {
      const lines = fs.readFileSync(historyPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          _messages.push(JSON.parse(line));
        } catch { /* skip corrupt lines */ }
      }
    } catch {
      _messages = [];
    }
  }

  _loaded = true;
  return { messages: _messages, summary: _summary };
}

/** Append a message to JSONL file */
function append(role, content, type) {
  if (!_loaded) load();

  const msg = {
    role,
    content,
    ts: new Date().toISOString(),
    ...(type ? { type } : {}),
  };

  _messages.push(msg);

  // Append to disk
  try {
    config.load(); // ensure data dir
    fs.appendFileSync(HISTORY_FILE(), JSON.stringify(msg) + '\n', 'utf8');
  } catch (err) {
    console.error('[chat-session] append failed:', err.message);
  }

  return msg;
}

/** Add a user message */
function addUser(content) {
  return append('user', content);
}

/** Add an assistant (pet) message */
function addAssistant(content) {
  return append('assistant', content);
}

/** Add an observation (pet sees screen) — type: 'observation' */
function addObservation(summary) {
  return append('system', `[观察] ${summary}`, 'observation');
}

/** Add a system event (morning greeting, break nudge, etc.) */
function addEvent(content) {
  return append('system', content, 'event');
}

// ---------------------------------------------------------------------------
// Build messages for AI call
// ---------------------------------------------------------------------------

/**
 * Get the conversation messages formatted for an AI chat completion call.
 * Includes summary (if any) + recent messages.
 * @param {string} systemPrompt - the character/personality prompt
 * @returns {Array} [{role, content}] ready for provider.chat()
 */
/**
 * Get the conversation messages formatted for an AI chat completion call.
 *
 * CACHE HIT STRATEGY:
 * Azure/OpenAI caches the input prefix. If the first N tokens of two
 * consecutive calls are identical, the cached portion is cheaper and faster.
 *
 * Message order optimized for cache hits:
 * 1. [STABLE] System prompt — same across all calls within a session
 * 2. [STABLE] Compacted summary — only changes on compaction (rare)
 * 3. [STABLE] Older messages — these don't change between calls
 * 4. [NEW] Most recent messages — only the tail grows
 *
 * This means the stable prefix (system + summary + older history) gets
 * cached across rapid back-and-forth chat exchanges.
 *
 * @param {string} systemPrompt - the character/personality prompt
 * @returns {Array} [{role, content}] ready for provider.chat()
 */
function getMessagesForAI(systemPrompt) {
  if (!_loaded) load();

  const messages = [];

  // [STABLE PREFIX — cached across calls]
  // 1. System prompt (identical every call within a session)
  messages.push({ role: 'system', content: systemPrompt });

  // 2. Compacted summary (only changes on compaction — rare)
  if (_summary && _summary.text) {
    messages.push({
      role: 'system',
      content: `[之前的对话总结 / Previous conversation summary]\n${_summary.text}`,
    });
  }

  // [GROWING TAIL — new content appended here]
  // 3. Conversation history
  // Bundle consecutive observations into a single system message to reduce
  // message count (fewer messages = more cache-friendly prefix)
  let pendingObs = [];

  for (const msg of _messages) {
    if (msg.type === 'observation') {
      pendingObs.push(msg.content);
      continue;
    }

    // Flush accumulated observations as one system message
    if (pendingObs.length > 0) {
      messages.push({ role: 'system', content: pendingObs.join('\n') });
      pendingObs = [];
    }

    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (msg.type === 'event') {
      messages.push({ role: 'system', content: msg.content });
    }
  }

  // Flush any remaining observations
  if (pendingObs.length > 0) {
    messages.push({ role: 'system', content: pendingObs.join('\n') });
  }

  return messages;
}

/** Estimate current token usage */
function estimateTokens() {
  return Math.ceil(estimateChars() / CHARS_PER_TOKEN);
}

/**
 * Get full history for the chat window UI.
 * @returns {Array} [{role, content, ts, type?}]
 */
function getHistory() {
  if (!_loaded) load();
  return {
    summary: _summary ? _summary.text : null,
    messages: _messages,
  };
}

// ---------------------------------------------------------------------------
// Compaction — summarize old messages to stay within token limit
// ---------------------------------------------------------------------------

/** Estimate character count of all messages */
function estimateChars() {
  let total = 0;
  if (_summary) total += (_summary.text || '').length;
  for (const msg of _messages) {
    total += (msg.content || '').length;
  }
  return total;
}

/** Check if compaction is needed */
/**
 * Check if compaction is needed.
 * Uses real token count from last API call if available, falls back to char estimate.
 * @param {number} [lastPromptTokens] - actual prompt_tokens from last API response
 */
function needsCompaction(lastPromptTokens) {
  // If we have real token count from the API, use it
  if (lastPromptTokens && lastPromptTokens > TOKEN_LIMIT * 0.8) {
    return true; // compact at 80% of limit to leave headroom
  }
  // Fallback to character estimate
  return estimateChars() > COMPACT_THRESHOLD_CHARS;
}

/**
 * Flush important facts from messages to durable memory before compaction.
 * Extracts personal info, preferences, promises, and relationship moments.
 * Errors are swallowed — memory flush must never block compaction.
 */
async function flushToMemory(messages) {
  // Only flush if we have meaningful messages to extract from
  const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (chatMessages.length < 4) return; // too few to extract from

  const cfg = config.get();
  const isZh = cfg.language === 'zh';

  const text = chatMessages
    .map(m => m.role === 'user' ? `用户: ${m.content}` : `宠物: ${m.content}`)
    .join('\n');

  const prompt = isZh
    ? '从这段对话中提取最重要的事实，每行一条。重点关注：1) 用户分享的个人信息（名字、喜好、工作）2) 用户的情绪和感受 3) 重要的承诺或约定。最多5条，简洁。'
    : 'Extract the most important facts from this conversation, one per line. Focus on: 1) Personal info the user shared (name, preferences, work) 2) User emotions and feelings 3) Important promises or commitments. Max 5 items, concise.';

  const result = await provider.chat([
    { role: 'system', content: prompt },
    { role: 'user', content: text },
  ], { purpose: 'reason', maxTokens: 300, temperature: 0.2 });

  const facts = result.split('\n').filter(f => f.trim().length > 5);
  for (const fact of facts.slice(0, 5)) {
    await memory.addEpisode({
      type: 'memory-flush',
      summary: fact.replace(/^[-•*\d.]\s*/, '').trim(),
      mood: soul.get().mood,
    });
  }
}

/**
 * Compact the conversation — summarize older messages, keep recent ones.
 * Called automatically when approaching token limit.
 */
async function compact() {
  if (_messages.length <= KEEP_RECENT_MESSAGES) return;

  const toSummarize = _messages.slice(0, -KEEP_RECENT_MESSAGES);
  const toKeep = _messages.slice(-KEEP_RECENT_MESSAGES);

  // Flush important facts to durable memory before compacting
  try {
    await flushToMemory(toSummarize);
  } catch (err) {
    console.error('[chat-session] memory flush failed (continuing with compaction):', err.message);
  }

  // Build text of messages to summarize
  const existingSummary = _summary ? `之前的总结：${_summary.text}\n\n` : '';
  const conversationText = toSummarize
    .map((m) => {
      if (m.role === 'user') return `用户: ${m.content}`;
      if (m.role === 'assistant') return `宠物: ${m.content}`;
      return `[${m.type || '系统'}] ${m.content}`;
    })
    .join('\n');

  const cfg = config.get();
  const isZh = cfg.language === 'zh';

  try {
    const summaryText = await provider.chat([
      {
        role: 'system',
        content: isZh
          ? '你是一个对话总结助手。请将以下对话总结为一段简洁的中文摘要，保留：1) 用户分享的个人信息和偏好 2) 重要的对话话题 3) 宠物和用户之间的关系进展 4) 任何承诺或后续话题。保留所有名字、文件路径、URL、日期和具体数字，不要改写专有名词或技术术语。保留对话的情感基调——记录什么让用户开心、沮丧或兴奋。不超过500字。'
          : 'Summarize this conversation concisely. Preserve: 1) Personal info the user shared 2) Key conversation topics 3) Relationship development 4) Any promises or follow-ups. Preserve all names, file paths, URLs, dates, and specific numbers exactly as written. Do not paraphrase proper nouns or technical terms. Preserve the emotional tone of the conversations — note what made the user happy, frustrated, or excited. Under 500 words.',
      },
      {
        role: 'user',
        content: `${existingSummary}${conversationText}`,
      },
    ], { purpose: 'reason', maxTokens: 800, temperature: 0.3 });

    // Save summary
    _summary = {
      text: summaryText,
      compactedAt: new Date().toISOString(),
      messageCount: toSummarize.length,
    };
    fs.writeFileSync(SUMMARY_FILE(), JSON.stringify(_summary, null, 2), 'utf8');

    // Replace messages with only the recent ones
    _messages = toKeep;

    // Rewrite JSONL with only kept messages
    const lines = _messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(HISTORY_FILE(), lines, 'utf8');

    console.log(`[chat-session] compacted ${toSummarize.length} messages into summary, kept ${toKeep.length}`);
  } catch (err) {
    console.error('[chat-session] compaction failed:', err.message);
  }
}

/** Clear all history (start fresh) */
function clear() {
  _messages = [];
  _summary = null;
  try { fs.unlinkSync(HISTORY_FILE()); } catch {}
  try { fs.unlinkSync(SUMMARY_FILE()); } catch {}
}

/**
 * Get the last N assistant messages (for anti-repetition in prompt-engine).
 * @param {number} [limit=3] - number of recent assistant messages to return
 * @returns {string[]} array of assistant message content strings
 */
function getRecentAssistantMessages(limit = 3) {
  if (!_loaded) load();
  return _messages
    .filter(m => m.role === 'assistant')
    .slice(-limit)
    .map(m => m.content);
}

/**
 * Get the last N observation summaries (for prompt-engine context).
 * @param {number} [limit=5] - number of recent observations to return
 * @returns {string[]} array of observation summary strings (without [观察] prefix)
 */
function getRecentObservationSummaries(limit = 5) {
  if (!_loaded) load();
  return _messages
    .filter(m => m.type === 'observation')
    .slice(-limit)
    .map(m => m.content.replace(/^\[观察\]\s*/, ''));
}

export default {
  load, append, addUser, addAssistant, addObservation, addEvent,
  getMessagesForAI, getHistory,
  needsCompaction, compact, estimateChars, estimateTokens, clear,
  getRecentAssistantMessages, getRecentObservationSummaries,
  TOKEN_LIMIT,
};
