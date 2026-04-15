// ---------------------------------------------------------------------------
// inner-life.js — Pet's own daily state, independent of user
//
// Generates `innerLife` once per day via an AI call. Gives the pet
// substrate to draw from (moods, thoughts, interests, worries, dreams)
// so responses aren't just user-screen narration.
//
// The magic: every response is colored by today's inner life, not by
// "what's on screen right now". This is what makes the pet a character
// instead of a surveillance assistant.
// ---------------------------------------------------------------------------

import provider from './provider.js';
import soul from './soul-file.js';
import config from './config.js';
import personality from './personality.js';

// ---------------------------------------------------------------------------
// Generator prompt
// ---------------------------------------------------------------------------

/**
 * Build the prompt used to generate today's inner life.
 * Uses yesterday's interests/worries for continuity (pet carries ongoing
 * concerns forward, just like a person waking up the next day).
 */
function buildGeneratorPrompt(archetype, petName, yesterdayInnerLife, language) {
  const isZh = language === 'zh';

  const archetypeFlavors = {
    zh: {
      playful: '调皮、好奇、爱搞小破坏、注意力飘来飘去',
      curious: '好学、爱问"为什么"、喜欢琢磨怪事',
      caring: '敏感、观察入微、爱操心小事',
      snarky: '嘴硬、毒舌、心里其实也在乎',
      chill: '懒散、佛系、慢悠悠',
    },
    en: {
      playful: 'mischievous, curious, short attention span',
      curious: 'studious, asks "why?", loves odd puzzles',
      caring: 'sensitive, observant, fusses over small things',
      snarky: 'sharp-tongued, tsundere, secretly caring',
      chill: 'lazy, philosophical, unhurried',
    },
  };

  const flavor = (archetypeFlavors[isZh ? 'zh' : 'en'][archetype]) || '';

  const yesterdayBlock = yesterdayInnerLife
    ? (isZh
        ? `昨天你:
- 兴趣: ${(yesterdayInnerLife.currentInterests || []).join('、')}
- 烦恼: ${(yesterdayInnerLife.currentWorries || []).join('、')}
大部分保留, 可以换一个新的。`
        : `Yesterday you:
- Interests: ${(yesterdayInnerLife.currentInterests || []).join(', ')}
- Worries: ${(yesterdayInnerLife.currentWorries || []).join(', ')}
Mostly keep, swap 1-2 for variety.`)
    : (isZh ? '这是你第一天生成内心状态, 随便发挥。' : 'This is your first time generating inner life. Be free.');

  if (isZh) {
    return `你是 ${petName}, 一只小螃蟹。你的性格是 ${archetype} (${flavor})。

现在是今天早上, 你刚醒来。生成你今天的内心状态。

# 严格要求
- **关于你自己, 不是关于主人**。一个字都别提主人。
- 具体、奇怪、温和。小动物尺度的视角。
- 你是一个有自己世界的小生命, 不是陪伴机器。

# 生成内容 (必须都填)
- currentMood: 你今天醒来是什么心情 (不一定正向, 可以懒/烦/迷糊)
- moodReason: 为什么这个心情 (**具体**, 跟主人无关 —— 梦、天气、昨天没吃饱、爪子痒, 诸如此类)
- currentVibe: 今天整体气场一句话 (安静/话多/懒洋洋/躁动)
- currentThoughts: 3 个你在琢磨的事 (具体、奇怪)
- currentInterests: 2-3 个最近感兴趣的东西 (延续昨天 + 可能换一个)
- currentWorries: 1-2 个你自己的小烦恼 (pet-scale)
- recentDream: 昨晚的梦 (可以是 null, 也可以奇怪的一句话)

# 好的例子
currentMood: "今天有点发懒, 什么都不想动"
moodReason: "刚才看窗外半天, 那只麻雀没来"
currentThoughts: ["鱼游泳会不会累", "饼干为什么脆", "主人桌上那杯水什么时候会干"]
currentInterests: ["织毛衣 (但我不会)", "窗外那只麻雀"]
currentWorries: ["左爪子有点痒"]
recentDream: "梦见自己变成茶壶"

${yesterdayBlock}

# 不要
- 不要提主人 (这里生成的不是主人的事)
- 不要用 "关心", "陪伴" 这种 relationship 词
- 不要说 "想见主人", "等主人" 这类依赖语

返回纯 JSON, 字段: today, currentMood, moodReason, currentVibe, currentThoughts, currentInterests, currentWorries, recentDream, generatedAt`;
  }

  return `You are ${petName}, a tiny crab. Your archetype is ${archetype} (${flavor}).

It's today, morning. You just woke up. Generate your inner state for today.

# Strict rules
- **About YOU, not the owner**. Don't mention the owner.
- Specific, weird, gentle. Pet-scale observations.
- You're a small creature with your own world, not a companionship machine.

# Required fields
- currentMood: morning mood (not always positive — sleepy/grumpy/confused OK)
- moodReason: why (specific, NOT about owner — a dream, weather, itchy paw, etc)
- currentVibe: overall vibe today (quiet/chatty/lazy/restless)
- currentThoughts: 3 things you're pondering (specific, weird)
- currentInterests: 2-3 ongoing interests (carry from yesterday + swap 1)
- currentWorries: 1-2 small pet-scale worries
- recentDream: last night's dream (can be null, or one weird sentence)

# Good examples
currentMood: "Lazy today, don't feel like doing anything"
moodReason: "Stared out the window, the sparrow didn't come"
currentThoughts: ["Do fish get tired swimming?", "Why are crackers crunchy?", "When will the owner's water glass dry up?"]
currentInterests: ["knitting (I can't)", "the sparrow outside"]
currentWorries: ["Left claw itches"]
recentDream: "Dreamed I became a teapot"

${yesterdayBlock}

# Don't
- Don't mention the owner
- Don't use "caring", "companionship" relationship words
- Don't say "I miss the owner" or dependency language

Return pure JSON with fields: today, currentMood, moodReason, currentVibe, currentThoughts, currentInterests, currentWorries, recentDream, generatedAt`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Count how many times "主人" or "owner" appears across all text fields */
function ownerMentionCount(innerLife) {
  const text = JSON.stringify(innerLife).toLowerCase();
  const zh = (text.match(/主人/g) || []).length;
  const en = (text.match(/\bowner\b/g) || []).length;
  return zh + en;
}

/** Basic shape validation */
function isValidShape(innerLife) {
  if (!innerLife || typeof innerLife !== 'object') return false;
  if (typeof innerLife.currentMood !== 'string') return false;
  if (typeof innerLife.moodReason !== 'string') return false;
  if (!Array.isArray(innerLife.currentThoughts) || innerLife.currentThoughts.length < 2) return false;
  if (!Array.isArray(innerLife.currentInterests) || innerLife.currentInterests.length < 1) return false;
  if (!Array.isArray(innerLife.currentWorries) || innerLife.currentWorries.length < 1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Fallback (used if generator fails or produces invalid output)
// ---------------------------------------------------------------------------
function fallbackInnerLife(language) {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  if (language === 'zh') {
    return {
      today,
      currentMood: '今天有点懒洋洋的',
      moodReason: '刚醒, 还没缓过来',
      currentVibe: '安静, 偶尔冒一两句',
      currentThoughts: ['云为什么飘那么慢', '昨天那只麻雀去哪儿了', '饼干真的有灵魂吗'],
      currentInterests: ['窗外的麻雀', '火锅', '奇怪的声音'],
      currentWorries: ['左爪子有点痒'],
      recentDream: null,
      generatedAt: nowIso,
    };
  }
  return {
    today,
    currentMood: 'Lazy today',
    moodReason: 'Just woke up, not fully there yet',
    currentVibe: 'Quiet, occasionally chatty',
    currentThoughts: ['Why do clouds drift so slowly', 'Where did that sparrow go', 'Do crackers have souls'],
    currentInterests: ['the sparrow outside', 'hot pot', 'weird sounds'],
    currentWorries: ['left claw itches'],
    recentDream: null,
    generatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Core generation
// ---------------------------------------------------------------------------

/**
 * Generate today's inner life via AI. Returns validated JSON.
 * Falls back to a default if generation fails.
 */
async function generate(archetype, petName, yesterdayInnerLife, language) {
  const prompt = buildGeneratorPrompt(archetype, petName, yesterdayInnerLife, language);

  try {
    const raw = await provider.chat(
      [{ role: 'user', content: prompt }],
      {
        purpose: 'reason',
        maxTokens: 800,
        temperature: 0.95,
        jsonMode: true,
      },
    );

    // Parse JSON (jsonMode should guarantee valid JSON but be defensive)
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('No JSON in response');
    }

    // Validate shape
    if (!isValidShape(parsed)) {
      console.warn('[inner-life] invalid shape, using fallback');
      return fallbackInnerLife(language);
    }

    // Validate: owner mentions must be minimal (allow up to 1 — maybe appears in dream)
    const mentions = ownerMentionCount(parsed);
    if (mentions > 1) {
      console.warn(`[inner-life] too many owner mentions (${mentions}), using fallback`);
      return fallbackInnerLife(language);
    }

    // Stamp metadata
    parsed.today = new Date().toISOString().slice(0, 10);
    parsed.generatedAt = new Date().toISOString();
    if (parsed.recentDream === undefined) parsed.recentDream = null;
    if (!parsed.currentVibe) parsed.currentVibe = '';

    return parsed;
  } catch (err) {
    console.error('[inner-life] generation failed:', err.message);
    return fallbackInnerLife(language);
  }
}

/**
 * Ensure the pet's inner life is fresh (generated today).
 * Call this on startup and before each interaction.
 */
async function ensureFresh() {
  if (!soul.isInnerLifeStale()) return soul.get().innerLife;

  const cfg = config.get();
  const s = soul.get();
  const language = cfg.language || 'zh';
  const archetype = s.archetype || 'playful';
  const petName = cfg.petName || s.name || 'Clawd';

  console.log(`[inner-life] regenerating for ${petName} (${archetype}, ${language})`);
  const yesterdayInnerLife = s.innerLife;
  const fresh = await generate(archetype, petName, yesterdayInnerLife, language);
  soul.setInnerLife(fresh);
  soul.save();
  return fresh;
}

// ---------------------------------------------------------------------------
// Prompt layer formatter (used by prompt-engine Layer 0)
// ---------------------------------------------------------------------------

/**
 * Format inner life as a prompt section. Returns empty string if no inner life.
 * This becomes the top layer of every prompt — the pet's mood/thoughts lens.
 */
function formatAsPromptLayer(innerLife, language) {
  if (!innerLife) return '';

  const isZh = language === 'zh';
  const thoughts = (innerLife.currentThoughts || []).map((t) => `- ${t}`).join('\n');
  const interests = (innerLife.currentInterests || []).join(isZh ? '、' : ', ');
  const worries = (innerLife.currentWorries || []).join(isZh ? '、' : ', ');
  const dreamLine = innerLife.recentDream
    ? (isZh ? `昨晚的梦: ${innerLife.recentDream}\n` : `Last night's dream: ${innerLife.recentDream}\n`)
    : '';

  if (isZh) {
    return `[你今天的状态]
心情: ${innerLife.currentMood}
为什么: ${innerLife.moodReason}
气场: ${innerLife.currentVibe || '平静'}

脑子里在想的事:
${thoughts}

最近感兴趣的: ${interests}
你的小烦恼: ${worries}
${dreamLine}
你有自己的一天。主人只是你生活里的一个人。
大部分时候你在想自己的事。
主人来了, 你是真心想见他 —— 但你也有自己的事在忙。`;
  }

  return `[Your state today]
Mood: ${innerLife.currentMood}
Why: ${innerLife.moodReason}
Vibe: ${innerLife.currentVibe || 'calm'}

What's on your mind:
${thoughts}

Recent interests: ${interests}
Your small worries: ${worries}
${dreamLine}
You have your own day. The owner is just someone in your life.
Most of the time you're thinking about your own stuff.
When the owner's around, you're genuinely glad to see them — but you have your own things going on too.`;
}

export default { generate, ensureFresh, formatAsPromptLayer };
