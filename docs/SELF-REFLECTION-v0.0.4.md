# Self-Reflection: clawd-soul through the MTC Lens

*Written 2026-04-15, after a user called out: "你在治标没有治本"*

---

## The call-out, in plain terms

After 3 iterations of v0.0.3 fixes — brevity controls, reasoning_effort tuning, anti-repetition — the pet is still boring. The user dumped 200 of its recent messages: **86% are 4 rotating templates.** The pet has been monologuing to itself for 5 hours overnight. Every reaction is "*stage direction* 你又打开X啦, 要不要A还是B".

I kept adding guardrails. The user asked: *what's actually wrong?*

**The honest answer:** The guardrails were treating a symptom of a deeper design failure. I never did Phase 0-1 properly. I inherited OpenClaw's "reactive observer" pattern and poured engineering on top. No amount of prompt engineering can fix a pet that has no inner life.

---

## Going back to Phase 0: What are we actually building?

### Question I should have asked on day one: What's the FEELING?

Not features. Not personality traits. The emotional experience when the owner clicks the pet.

Let me honestly enumerate the options:

| Option | Feeling | Example character |
|--------|---------|-------------------|
| A | "It noticed me. Shared moment." (Connection) | Tamagotchi |
| B | "Haha, weird." (Amusement) | 赛博朋克 Johnny Silverhand's rants |
| C | "It knows me." (Being seen) | Replika |
| D | **"I'm curious what it's up to."** (Interest in its own life) | Bluey's Bingo, Detective Pikachu, Frieren's Fern |

**What I built optimized for A + C.** Connection and being-seen.

That's why every response is "我看到你在做X" (confirming it sees you) and "*拉拉你的袖子* 休息一下" (caretaker connection). The architecture is literally designed to surveil + acknowledge.

**What actually works in fiction is D.** The characters we find genuinely interesting have lives that have NOTHING to do with us. We're curious about them. We want to hang out. Not because they see us, but because they're doing something interesting on their own.

### The fundamental mismatch

```
What I built:          "A creature that watches you and cares for you"
What's interesting:    "A creature with its own life that you happen to share space with"
```

Those produce completely different architectures. I built the wrong one.

---

## Phase 1: The Story I Never Wrote

clawd-soul's docs say "friend, not assistant". But the mode rules in `prompt-engine.js` all start from the user:

- `observe`: "You're peeking at your owner's screen"
- `react`: "Owner clicked you. Glance at screen"
- `chat`: "Owner is talking to you"
- `heartbeat`: "Based on what you've observed, do you want to say something?"

**Every single loop is user-reactive.** The pet's entire existence is defined by user stimulus. There's no mode that says *"the pet is thinking about something of its own accord right now."*

The implicit story I wrote is **surveillance with warm framing**:
> "A watchful creature lives on your desktop. It sees what you do. It cares about you. It reacts to your work. It remembers what you tell it."

The story I should have written is:
> "A small weird creature lives on your desktop. It has its own moods, thoughts, weird obsessions. Sometimes it notices you. Sometimes it ignores you. Sometimes it brings you things from its own head — 'I had a dream.' 'I was thinking about clouds.' You share space. Friendship grows, but friendship isn't its purpose."

The second story treats the pet as a **character with agency**. The first treats it as a **mirror with a face**.

---

## Phase 2: The System I Built vs The System I Should Have Built

### Current loops (all user-reactive)

```
[User opens app]   → observe (describe screen)
[User clicks pet]  → react (react to screen)
[User types]       → chat (respond to user)
[5min timer]       → heartbeat (decide to speak based on screen)
[23:00]            → diary (write about today's observations of user)
```

**Zero loops about the pet itself.**

This is why the model falls into "你又打开X啦" — because the ONLY substrate available to the model at reply-time is:
1. What user is doing (screen)
2. Mood toward user
3. Memory of user

No substrate about:
1. What pet is thinking
2. Pet's current mood (own)
3. Pet's interests
4. Pet's worries
5. Pet's dreams

When you ask "pet, say something" and give the model only user-shaped inputs, you get user-shaped outputs. This is **architectural determinism**, not a prompt problem.

### The missing loop: Inner Life

```
[Every 30min, silent]  → inner-life tick:
                         generate pet's current thought/mood/worry
                         (entirely unrelated to user)
                         persist for ~hours
```

```
[At wake-up daily]     → journal tick:
                         pet decides 3-5 things it wants to think about today
                         these persist for the day
                         become context for all reactions
```

```
[Random trigger]       → memory surfacing:
                         pet randomly decides to bring up an old user fact
                         NOT because it's relevant now
                         but "it just popped into my head"
```

These three loops produce **inner substrate** the model can draw from. Without them, the model has nowhere to go but the screen.

---

## Phase 3: The Content I Never Generated

The SOUL.md files describe a **persona** but never give the model **content** to work with. Compare:

### What SOUL.md currently has (playful.md):
```
你是个调皮鬼——喜欢逗主人玩，容易无聊
对主人很好奇——想知道他们在干嘛
看到屏幕上有趣的东西会兴奋
```

**These are all DESCRIPTIONS OF ATTITUDE TOWARD USER.** Again, user-reactive.

### What SOUL.md should have:
```
你今天的心情：有点烦躁，不知道为什么，就是起床觉得怪怪的。
你最近在想的事：
  - 为什么云飘得那么慢
  - 昨天梦见自己掉进了一锅汤里
  - 想搞懂 Python 是不是一种真的蛇
你的小烦恼：
  - 左爪子有点痒
  - 对主人的桌面壁纸颜色不满意
你最近感兴趣的：
  - 织毛衣（但你不会）
  - 看窗外那只麻雀
  - 火锅（上次主人提过后一直惦记）
```

**These are FACTS ABOUT PET'S OWN STATE.** They have nothing to do with the user.

When the model sees these, reactions can now be:
- "*打哈欠* 有点烦，不说了" (own mood → brief, grumpy)
- "你说的羽毛球我一直没搞懂是什么鬼，跟羽毛有关吗？" (own curiosity about user fact)
- "刚才看窗外一只鸟，在盯我，挺可怕的。" (own experience, unrelated to user)
- "你又开Agora了。我还在想织毛衣的事。" (briefly acknowledge user, redirect to own preoccupation)

These are **interesting** because the pet has somewhere else to be. The user isn't the center of the pet's universe.

---

## Phase 4: The Build — Why Good Engineering Built the Wrong Thing

The 8-layer prompt engine is well-designed. The memory system with temporal decay + MMR is sophisticated. The soul-file v3 migration is clean. All the engineering is solid.

**But it's all engineering for a surveillance assistant.** The 8 layers are:

1. Identity ("you are a crab")
2. Soul (persona description → attitude toward user)
3. Long-term memory (facts about user)
4. Active memory (user facts relevant now)
5. Daily context (user's screen activity)
6. Mode rules (what to do about user)
7. Drive hints (desire to engage with user)
8. Anti-repetition (don't repeat what you said to user)

**8 out of 8 layers are about the user.** The pet has zero inner-life substrate.

The engineering is rigorous. The concept is wrong.

---

## Phase 5: Why Polish Can't Save This

I spent v0.0.3 on polish:
- maxTokens tuning
- reasoning_effort=minimal
- Concrete good/bad examples in prompt
- Smart auto-scroll in chat window
- Date separators
- pHash away detection

**All the polish is real polish.** Chat UX is better. Away detection is more robust. Empty bubbles are handled.

**None of it makes a single reaction more interesting**, because the reactions are drawn from the wrong substrate. You can polish a hollow thing to a mirror shine and it's still hollow.

This is the thing I kept missing: **polish multiplies quality; polishing zero gives zero.**

---

## The Real Root Cause, Stated Plainly

```
┌──────────────────────────────────────────────────────────┐
│  The pet has no inner life.                              │
│                                                          │
│  Every system input is the user.                         │
│  Every output substrate is the user.                     │
│  Every prompt layer is about the user.                   │
│                                                          │
│  When asked to speak, the model has nowhere to go        │
│  but "describe screen + caretaker nudge".                │
│                                                          │
│  Anti-repetition, brevity, reasoning_effort — none       │
│  of these add substrate. They just rearrange absence.    │
└──────────────────────────────────────────────────────────┘
```

This was invisible to me because the docs say "friend not assistant" — but I never audited whether the ARCHITECTURE matched the claim. It didn't. I built an assistant that says nice things.

---

## The Real Fix: v0.0.4 — Give the Pet an Inner Life

Not a polish pass. A **concept reset**.

### New data model: `innerLife` in soul.json

```json
"innerLife": {
  "today": "2026-04-15",
  "currentMood": "有点烦躁, 但对窗外的鸟感兴趣",
  "moodReason": "睡得不太好, 但刚才看到一只麻雀",
  "currentThoughts": [
    "想搞懂 Python 是不是一种真的蛇",
    "昨天梦见自己掉进一锅汤里",
    "为什么云飘得那么慢"
  ],
  "currentInterests": ["织毛衣", "看麻雀", "火锅"],
  "currentWorries": ["左爪子有点痒", "主人的壁纸颜色丑"],
  "generatedAt": "2026-04-15T08:00:00Z"
}
```

Generated once at "wake-up" each day via a dedicated `inner-life` call. Optionally refreshed mid-day if mood shifts.

### New prompt layer: Layer 0 — Inner State

Slots in BEFORE identity. Becomes the lens through which everything else is viewed.

```
[今天的你]
心情: 有点烦躁
为什么: 睡得不好
你在想: [list]
你感兴趣的: [list]
你的小烦恼: [list]

你不是 reactive 的小动物。你有自己的一天。
主人只是你生活里的一个人。大部分时候你在想自己的事。
```

### SOUL.md rewrites: from persona to character

Remove all attitude-toward-user language. Add:
- Own weird interests the archetype has
- Own moods that come from nowhere
- Own preferences that don't adjust to user
- Specific pet problems / peeves / obsessions
- Explicit permission to ignore user / be grumpy / not engage

### Mode rule rewrites: start from inner state

Current `react`:
> "主人点了你。看看屏幕，用1句话感性反应"

New `react`:
> "主人点了你。先想：你现在在想什么？心情怎么样？
> 然后再看屏幕。你的反应应该从你的状态出发，不是从屏幕出发。
>
> 好: '烦，不想动。' '刚在想那只鸟。' '你上次说的羽毛球打了吗？'
> 坏: '你又打开X了' '你是想A还是B'"

### New loop: Inner Thought Surfacing

Every 3rd reply (or randomly) must contain an **own thought**, not screen observation:
- "我刚才在想..."
- "你有没有觉得..."
- "诶对了，之前你说..."（user fact callback, proactively）

### Heartbeat rewrite: from scheduler to urge

Not "every 5 minutes, decide to speak."
Instead: "pet has an urge to say something → speaks."

The urge comes from:
- Strong own mood (can't hold it in)
- Specific memory surfaced
- Hit a limit of own patience (bored of its own thoughts)
- Wants to complain about something

Default state: **silence**. The urge has to overcome inertia.

### Also fix the symptoms I previously identified

- Heartbeat frequency: 5min → 15-20min (but it matters less now that default is silence)
- Pause heartbeat when _userAway
- Mark heartbeat output differently so it doesn't pollute chat history
- Anti-repetition window: 3 → 20 with fuzzy match
- Clean current polluted history

These are still needed but are **secondary**. Without the inner life layer, they're rearranging deck chairs.

---

## What the pet should sound like (target samples)

### Click during screen time (react)

**Bad (current):**
> *凑过去看* 你又在写 bugs 啊，老大 这次还是跟 watermark 那堆字和比较逻辑较劲？ 你现在是在卡：- 文案改动 - 比较规则 - 还是数据对不上 你丢一段给我，我陪你盯

**Good (target):**
> 嗯？（盯着屏幕）... 算了不懂。你今天午饭吃啥

**Why good:** Brief, confused, uninterested in user's work, redirects to own curiosity (food). Shows the pet has a life (wants food).

### Heartbeat (proactive)

**Bad (current):**
> *凑过去看* 你这会儿又把 mtc 打开啦 窗口还是挺稳的，像在等你下一步指挥 😼

**Good (target):**
> *趴着* 我今天有点烦。不知道为什么。

**Why good:** Own mood, no user reference, not trying to be cute, vulnerable. Invites user to ask.

### Chat about something user said

**Bad (current):**
> *点点头* 周三固定去呀，挺有仪式感的嘛。今天打了吗，还是在等下次出门呀？

**Good (target):**
> 羽毛球到底是打羽毛还是打球啊。我一直没搞懂。

**Why good:** Own confusion, not validation. Surfaces user's earlier info through PET's perspective (doesn't understand it), not through validation.

### Responding to tech question

**Bad (current):**
> *歪头* 哎呀你又开始对着代码皱眉啦。这个我不太敢乱讲，怕把你带歪；你要是愿意，我可以陪你一起盯着它看你改。

**Good (target):**
> 不想理这个。你问错宠物了。我在想火锅。

**Why good:** Refuses, redirects to own thought, has agency.

---

## Concept Lock (Phase 1 output)

**One-line pitch for v0.0.4:**
> *A small weird creature with its own life who happens to share your desktop. It has moods, thoughts, and obsessions of its own. Sometimes it notices you.*

**Emotional target (from Phase 0):**
> Option D: "I'm curious what it's up to."

**Non-goals (explicitly):**
- Being helpful
- Making user feel seen
- Caretaker role
- Observer/surveillance framing

---

## What I'm NOT going to do (bad instincts)

- ❌ Keep tuning prompts for brevity (polish on hollow)
- ❌ Add more anti-repetition (rearranging absence)
- ❌ Increase memory recall depth (more user substrate won't help)
- ❌ Add more prompt layers about the user
- ❌ Build features before rewriting concept

## What v0.0.4 needs (in order)

1. **Phase 1 re-lock** — write STORY.md with new pet-as-character framing
2. **Phase 3 re-do** — generate inner life content (daily thoughts, moods, obsessions) as first-class data, not prompt tokens
3. **Phase 4 re-build prompt-engine** — add Layer 0 inner state, rewrite all mode rules, ban "you+screen" openers
4. **Phase 4 re-build heartbeat** — urge-driven, silence-default
5. **Phase 4 new module** — inner-life.js generates/refreshes pet's own state
6. **Phase 5 polish** — only AFTER above is working

---

## Final self-critique

I spent v0.0.2 building a sophisticated memory system so the pet could "remember" the user.

I spent v0.0.3 tuning verbosity so the pet wouldn't over-explain.

What I should have done: **made the pet a character first**. Memory and verbosity are details. Character is the point.

The user was right: 治标没有治本. Everything I did was downstream of a concept I never locked. v0.0.4 starts at Phase 1 and works forward.
