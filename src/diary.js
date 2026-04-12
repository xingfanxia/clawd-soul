import config from './config.js';
import provider from './provider.js';
import memory from './memory.js';
import engine from './engine.js';
import soul from './soul-file.js';
import prompts from './prompts.js';

// ---------------------------------------------------------------------------
// Diary timer
// ---------------------------------------------------------------------------
let _diaryTimer = null;

/** Start the diary timer — generates diary at ~23:00 local time */
function startTimer() {
  // Check every 30 minutes if it's diary time
  _diaryTimer = setInterval(() => {
    const hour = new Date().getHours();
    if (hour === 23) {
      const today = new Date().toISOString().slice(0, 10);
      const existing = memory.getDiary(today);
      if (!existing) {
        generate().catch((err) => {
          console.error('[diary] auto-generation failed:', err.message);
        });
      }
    }
  }, 30 * 60 * 1000);
}

/** Stop the diary timer */
function stopTimer() {
  if (_diaryTimer) {
    clearInterval(_diaryTimer);
    _diaryTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Diary generation
// ---------------------------------------------------------------------------

/**
 * Generate a diary entry for today (or a specific date).
 * @param {string} [date] - YYYY-MM-DD, defaults to today
 * @returns {Object} { ok, date, content }
 */
async function generate(date) {
  const targetDate = date || new Date().toISOString().slice(0, 10);

  if (!config.hasApiKey()) {
    return { ok: false, error: 'No API key configured' };
  }

  // Gather today's observations and chats
  const todayObservations = memory.getTodayEpisodes('observation')
    .map((e) => e.summary)
    .slice(0, 20); // cap at 20 to fit prompt

  const todayChats = memory.getTodayEpisodes('chat')
    .map((e) => e.summary)
    .slice(0, 10);

  const ctx = engine.getPersonalityContext();
  const s = soul.get();

  const systemPrompt = prompts.diary({
    ...ctx,
    todayObservations,
    todayChats,
  });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Write your diary entry for ${targetDate}. Today you had ${todayObservations.length} observations and ${todayChats.length} chats.` },
  ];

  try {
    const content = await provider.chat(messages, {
      purpose: 'diary',
      maxTokens: 500,
      temperature: 0.9,
    });

    // Save diary entry
    memory.saveDiary(targetDate, content, s.mood);

    // Update stats
    soul.recordInteraction('diary');
    engine.applyEvent('diary-written');
    soul.save();

    return { ok: true, date: targetDate, content };
  } catch (err) {
    console.error('[diary] generation failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export default { startTimer, stopTimer, generate };
