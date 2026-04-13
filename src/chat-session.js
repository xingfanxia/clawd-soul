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

const HISTORY_FILE = () => path.join(config.DATA_DIR, 'chat-history.jsonl');
const SUMMARY_FILE = () => path.join(config.DATA_DIR, 'chat-summary.json');

// Token budget — gpt-5.4-mini has large context, compact at ~100k chars (~50k tokens)
// to leave room for system prompt + response
const COMPACT_THRESHOLD_CHARS = 100000;
const KEEP_RECENT_MESSAGES = 30;  // keep last 30 messages intact after compaction

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
function getMessagesForAI(systemPrompt) {
  if (!_loaded) load();

  const messages = [{ role: 'system', content: systemPrompt }];

  // Add compacted summary as context
  if (_summary && _summary.text) {
    messages.push({
      role: 'system',
      content: `[之前的对话总结 / Previous conversation summary]\n${_summary.text}`,
    });
  }

  // Add conversation history (user + assistant only, skip system/observations for AI)
  // But include recent observations as context
  for (const msg of _messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (msg.type === 'observation') {
      // Include recent observations as system context
      messages.push({ role: 'system', content: msg.content });
    }
  }

  return messages;
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
function needsCompaction() {
  return estimateChars() > COMPACT_THRESHOLD_CHARS;
}

/**
 * Compact the conversation — summarize older messages, keep recent ones.
 * Called automatically when approaching token limit.
 */
async function compact() {
  if (_messages.length <= KEEP_RECENT_MESSAGES) return;

  const toSummarize = _messages.slice(0, -KEEP_RECENT_MESSAGES);
  const toKeep = _messages.slice(-KEEP_RECENT_MESSAGES);

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
          ? '你是一个对话总结助手。请将以下对话总结为一段简洁的中文摘要，保留：1) 用户分享的个人信息和偏好 2) 重要的对话话题 3) 宠物和用户之间的关系进展 4) 任何承诺或后续话题。不超过500字。'
          : 'Summarize this conversation concisely. Preserve: 1) Personal info the user shared 2) Key conversation topics 3) Relationship development 4) Any promises or follow-ups. Under 500 words.',
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

export default {
  load, append, addUser, addAssistant, addObservation, addEvent,
  getMessagesForAI, getHistory,
  needsCompaction, compact, estimateChars, clear,
};
