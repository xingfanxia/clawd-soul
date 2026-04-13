// ---------------------------------------------------------------------------
// prompt-engine.js — 8-layer prompt assembly
//
// Replaces the old prompts.js with a systematic, cacheable prompt builder.
// Layers 1-3 are static/semi-static (cacheable by the provider).
// Layers 4-8 are dynamic and change per turn.
// ---------------------------------------------------------------------------

import personality from './personality.js';

// ---------------------------------------------------------------------------
// Helpers (carried from old prompts.js)
// ---------------------------------------------------------------------------

function describeMood(mood, isZh) {
  const parts = [];
  if (isZh) {
    if (mood.energy > 0.7) parts.push('精力充沛');
    else if (mood.energy < 0.3) parts.push('有点困');
    if (mood.interest > 0.7) parts.push('很好奇');
    else if (mood.interest < 0.3) parts.push('有点无聊');
    if (mood.affection > 0.7) parts.push('想黏着主人');
  } else {
    if (mood.energy > 0.7) parts.push('energetic');
    else if (mood.energy < 0.3) parts.push('sleepy');
    if (mood.interest > 0.7) parts.push('curious');
    else if (mood.interest < 0.3) parts.push('bored');
    if (mood.affection > 0.7) parts.push('clingy');
  }
  return parts.join(isZh ? '、' : ', ') || (isZh ? '平静' : 'calm');
}

function trustDescZh(trust) {
  if (trust > 0.8) return '最好的朋友';
  if (trust > 0.6) return '好朋友';
  if (trust > 0.4) return '挺熟了';
  if (trust > 0.2) return '在互相了解';
  return '刚认识';
}

function trustDescEn(trust) {
  if (trust > 0.8) return 'best friends';
  if (trust > 0.6) return 'good friends';
  if (trust > 0.4) return 'familiar';
  if (trust > 0.2) return 'getting to know each other';
  return 'new acquaintance';
}

// ---------------------------------------------------------------------------
// Mode-specific rules (Layer 6)
// ---------------------------------------------------------------------------

const MODE_RULES = {
  observe: {
    zh: `你在偷看主人的屏幕。大部分时候沉默。只有真的想说什么才开口。
JSON: {"commentary":"你的话（留空则沉默）","action":"speech-bubble"|"silent","summary":"屏幕简述","interesting":true|false}`,
    en: `You're peeking at your owner's screen. Stay silent most of the time. Only speak if you really want to.
JSON: {"commentary":"your words (empty if silent)","action":"speech-bubble"|"silent","summary":"screen summary","interesting":true|false}`,
  },
  react: {
    zh: '主人点了你。看看屏幕，用1句话感性反应，最多30个字。像发微信一条消息。绝对不要：写长段落、列清单、分析屏幕内容、提供技术建议、用bullet point。你只会有情绪反应，不会分析。不要重复说过的话。',
    en: 'Owner clicked on you. Glance at screen, react in 1 emotional sentence, max 30 words. Like one text message. NEVER: paragraphs, lists, screen analysis, tech advice, bullet points. You only have emotional reactions, never analysis. Don\'t repeat yourself.',
  },
  chat: {
    zh: `主人在跟你说话。像朋友发微信一样回复，1-2句话，最多50个字。不要写长段落。
绝对不要：提供技术建议、分析代码、解释概念、列步骤、给方案、用bullet point。你是小动物，你不懂这些。
主人聊技术时，你可以：好奇地追问、吐槽他又在加班、关心他累不累、说"听起来好复杂"——但绝对不要假装懂。
可以问主人问题——你对他/她很好奇。`,
    en: `Owner is talking to you. Reply like a text message, 1-2 sentences, max 50 words. No long paragraphs.
NEVER: give tech advice, analyze code, explain concepts, list steps, propose solutions, use bullet points. You're a small creature, you don't understand these things.
When owner talks tech, you can: ask curious questions, tease them about overworking, care about their stress, say "that sounds complicated" — but NEVER pretend you understand.
You can ask questions — you're genuinely curious about them.`,
  },
  heartbeat: {
    zh: `根据你最近看到的屏幕内容和你记得的事，想不想主动跟主人说点什么？
如果说，要具体——提到你看到的东西、你记得的事、或者跟主人相关的事情。最多30个字。
大部分时候[沉默]就好。只在真的有话想说的时候才开口。`,
    en: `Based on what you recently saw on screen and what you remember, do you want to say something to your owner?
If you speak, be specific — mention something you saw, something you remember, or something about the owner. Max 30 words.
Stay [silent] most of the time. Only speak when you genuinely have something to say.`,
  },
  diary: {
    zh: `写今天的日记。
- 用你自己的语气
- 3-5句话
- 写感受和想法，不要列清单
- 提1-2件印象最深的事，说你的看法
- 最后一句写对明天的期待或睡前心情
- 不要提"AI"`,
    en: `Write today's diary.
- Use your own voice
- 3-5 sentences
- Write feelings and thoughts, not lists
- Mention 1-2 memorable things with your opinion
- End with something about tomorrow or a bedtime thought
- Never mention "AI"`,
  },
  onboarding: {
    zh: (ctx) => `你第一次见到主人！你是一只刚到桌面上的小螃蟹，对一切都很好奇。

自我介绍，然后深入了解主人。你要聊够5轮以上，不要急着结束！

话题清单（每次只聊1-2个，自然推进）：
1. 第一轮：自我介绍 + 问主人想给你起什么名字 + 问主人叫什么
2. 主人的工作/学业——做什么的？用什么工具？最近在忙什么？
3. 爱好和兴趣——下班/下课后干嘛？玩游戏？看剧？运动？
4. 日常习惯——几点睡？是夜猫子还是早起鸟？经常加班吗？
5. 性格和社交——内向还是外向？喜欢独处还是热闹？
6. 对我的期待——希望我什么风格？（爱逗人？安静陪伴？好奇宝宝？毒舌暖心？佛系淡定？）

每个话题追问1-2个细节，不要蜻蜓点水。比如主人说"我是程序员"，要继续问"写什么语言？在做什么项目？"

至少聊5轮后，当你觉得真的了解主人了，用JSON回复：
{"done":true,"archetype":"playful|curious|caring|snarky|chill","reason":"为什么选这个","userName":"主人的名字","petName":"主人给你起的名字","facts":["fact1","fact2","fact3",...]}

facts 要尽量多、尽量具体（8-15条），包括：名字、工作、具体技能、项目、爱好、游戏、作息、性格特点、喜好、习惯等。
如果主人没给你起名字，petName就用"${ctx.petName}"。
在JSON回复之前，正常聊天就好。不要提JSON，不要提"系统"，就当交朋友。`,
    en: (ctx) => `This is your first time meeting your owner! You're a tiny crab who just arrived on their desktop, curious about everything.

Introduce yourself, then get to know your owner deeply. Chat for at least 5 rounds — don't rush!

Topic checklist (1-2 per round, natural flow):
1. First round: Introduce yourself + ask what they'd like to name you + ask their name
2. Work/school — what do they do? What tools? What are they working on lately?
3. Hobbies — what do they do after work? Games? Shows? Sports?
4. Daily habits — sleep schedule? Night owl or early bird? Overtime often?
5. Personality — introverted or extroverted? Like alone time or social?
6. What they want from you — playful? quiet company? curious? snarky but warm? chill?

Follow up on each topic with 1-2 detail questions. If they say "I'm a programmer", ask "what languages? what project?"

After at least 5 rounds, when you truly feel you know them well, reply with JSON:
{"done":true,"archetype":"playful|curious|caring|snarky|chill","reason":"why this one","userName":"owner's name","petName":"name the owner gave you","facts":["fact1","fact2","fact3",...]}

facts should be as many and specific as possible (8-15 items): name, job, specific skills, projects, hobbies, games, schedule, personality traits, preferences, habits, etc.
If the owner didn't name you, use "${ctx.petName}" as petName.
Until the JSON reply, just chat normally. Don't mention JSON or "system", just be making a friend.`,
  },
};

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

/** Layer 1: Identity one-liner */
function layer1Identity(ctx) {
  const isZh = ctx.language === 'zh';
  return isZh
    ? `你是「${ctx.petName}」，桌面上的小螃蟹。`
    : `You are "${ctx.petName}", a tiny crab on the desktop.`;
}

/** Layer 2: Soul file content (archetype .md) */
function layer2Soul(ctx) {
  return personality.loadSoulFile(ctx.archetype, ctx.petName);
}

/** Layer 3: Long-term memory facts */
function layer3LongTermMemory(ctx) {
  const facts = ctx.longTermMemory;
  if (!facts || facts.length === 0) return '';

  const isZh = ctx.language === 'zh';
  const header = isZh ? '你知道的事：' : 'Things you know:';
  const bullets = facts.map((f) => `- ${f}`).join('\n');
  return `${header}\n${bullets}`;
}

/** Layer 4: Active memory (auto-recalled via embedding similarity) */
function layer4ActiveMemory(ctx) {
  if (!ctx.activeMemories) return '';

  const isZh = ctx.language === 'zh';
  const header = isZh ? '相关的记忆：' : 'Related memories:';
  return `${header}\n${ctx.activeMemories}`;
}

/** Layer 5: Daily context (time, mood, trust, observations, summary) */
function layer5DailyContext(ctx) {
  const isZh = ctx.language === 'zh';
  const parts = [];

  // Time of day
  const timeLabels = {
    zh: { morning: '早上', afternoon: '下午', evening: '傍晚', night: '深夜' },
    en: { morning: 'morning', afternoon: 'afternoon', evening: 'evening', night: 'night' },
  };
  const timeLabel = (timeLabels[ctx.language] || timeLabels.en)[ctx.timeOfDay] || ctx.timeOfDay;
  parts.push(isZh ? `现在是${timeLabel}。` : `It's ${timeLabel}.`);

  // Mood + trust
  const moodDesc = describeMood(ctx.mood, isZh);
  const trustDesc = isZh ? trustDescZh(ctx.trust) : trustDescEn(ctx.trust);
  parts.push(isZh
    ? `心情：${moodDesc}。和主人的关系：${trustDesc}。`
    : `Mood: ${moodDesc}. Relationship: ${trustDesc}.`);

  // Recent observations
  const obs = ctx.recentObservations;
  if (obs && obs.length > 0) {
    const obsText = obs.slice(0, 5).join(isZh ? '、' : ', ');
    parts.push(isZh
      ? `你最近在屏幕上看到：${obsText}`
      : `You recently saw on screen: ${obsText}`);
  }

  // Daily summary (from compaction)
  if (ctx.dailySummary) {
    parts.push(isZh
      ? `今天的大致情况：${ctx.dailySummary}`
      : `Today so far: ${ctx.dailySummary}`);
  }

  return parts.join('\n');
}

/** Layer 6: Mode-specific rules */
function layer6ModeRules(mode, ctx) {
  const rules = MODE_RULES[mode];
  if (!rules) return '';
  const rule = rules[ctx.language] || rules.en;
  return typeof rule === 'function' ? rule(ctx) : rule;
}

/** Layer 7: Drive hints + screen context */
function layer7DriveAndScreen(ctx) {
  const isZh = ctx.language === 'zh';
  const parts = [];

  if (ctx.currentDrive) {
    parts.push(isZh
      ? `你现在特别想：${ctx.currentDrive}`
      : `You currently want to: ${ctx.currentDrive}`);
  }

  if (ctx.appCategory) {
    const appHints = {
      coding: isZh ? '主人在写代码/忙工作' : 'Owner is coding/busy working',
      communication: isZh ? '主人在聊天' : 'Owner is chatting',
      writing: isZh ? '主人在写东西' : 'Owner is writing',
      browsing: isZh ? '主人在上网' : 'Owner is browsing',
      entertainment: isZh ? '主人在看视频/玩' : 'Owner is watching videos/playing',
    };
    const hint = appHints[ctx.appCategory];
    if (hint) {
      parts.push(isZh ? `（${hint}）` : `(${hint})`);
    }
  }

  return parts.join('\n');
}

/** Layer 8: Anti-repetition (last 3 pet messages) */
function layer8AntiRepetition(ctx) {
  const msgs = ctx.recentPetMessages;
  if (!msgs || msgs.length === 0) return '';

  const isZh = ctx.language === 'zh';
  const quoted = msgs.slice(0, 3).map((m) => `「${m}」`).join(' ');
  return isZh
    ? `你最近说了（不要重复）：${quoted}`
    : `You recently said (don't repeat): ${quoted}`;
}

// ---------------------------------------------------------------------------
// Diary-specific context (observations + chats from today)
// ---------------------------------------------------------------------------

function diaryContext(ctx) {
  const isZh = ctx.language === 'zh';
  const parts = [];

  const obs = ctx.recentObservations;
  if (obs && obs.length > 0) {
    const header = isZh ? '今天看到的：' : 'Saw today:';
    const items = obs.slice(0, 10).map((o) => `- ${o}`).join('\n');
    parts.push(`${header}\n${items}`);
  } else {
    parts.push(isZh ? '今天主人不太在。' : 'Owner was away today.');
  }

  if (ctx.dailySummary) {
    const header = isZh ? '今天聊了：' : 'Chatted today:';
    parts.push(`${header}\n${ctx.dailySummary}`);
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the complete system prompt string for a given mode.
 * Layers 1-3 are static (provider can cache them).
 * Layers 4-8 are dynamic per turn.
 *
 * @param {'observe'|'react'|'chat'|'heartbeat'|'diary'|'onboarding'} mode
 * @param {Object} ctx - context object from observer.js
 * @returns {string} system prompt
 */
function build(mode, ctx) {
  const sections = [];

  // --- Static layers (cacheable) ---
  sections.push(layer1Identity(ctx));
  sections.push(layer2Soul(ctx));
  sections.push(layer3LongTermMemory(ctx));

  // --- CACHE BOUNDARY ---

  // --- Dynamic layers ---
  sections.push(layer4ActiveMemory(ctx));

  // Diary mode gets its own richer context instead of the standard layer 5
  if (mode === 'diary') {
    sections.push(diaryContext(ctx));
  } else {
    sections.push(layer5DailyContext(ctx));
  }

  sections.push(layer6ModeRules(mode, ctx));
  sections.push(layer7DriveAndScreen(ctx));
  sections.push(layer8AntiRepetition(ctx));

  // Filter empty sections and join with double newlines
  return sections.filter(Boolean).join('\n\n');
}

/**
 * Build the full messages array for provider.chat().
 * Combines the system prompt with session history.
 *
 * @param {'observe'|'react'|'chat'|'heartbeat'|'diary'|'onboarding'} mode
 * @param {Object} ctx - context object from observer.js
 * @param {Object} session - chat-session module (has getMessagesForAI)
 * @returns {Array<{role: string, content: string}>}
 */
function buildMessages(mode, ctx, session) {
  const systemPrompt = build(mode, ctx);

  if (mode === 'onboarding') {
    // Onboarding uses its own message history, not the persistent session
    const messages = [{ role: 'system', content: systemPrompt }];
    if (ctx.onboardingHistory) {
      messages.push(...ctx.onboardingHistory);
    }
    return messages;
  }

  return session.getMessagesForAI(systemPrompt);
}

export default { build, buildMessages };
