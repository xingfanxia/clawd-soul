# Clawd Mate — Project Vision & Story

## The Origin: A Crab That Watches You Code

Clawd started as a simple desktop pet — a pixel crab that sits on your screen and reacts to your AI coding sessions. When Claude Code thinks, Clawd thinks. When a subagent spawns, Clawd juggles. When you're idle, Clawd falls asleep. It was cute, but fundamentally passive — a status indicator dressed as a pet.

The question that changed everything: **what if the crab could actually understand what you're doing?**

Not in a "helpful assistant" way — we already have Claude Code for that. In a **friend** way. A tiny creature that peeks at your screen, forms opinions about your YouTube videos, gets bored when you stare at spreadsheets, remembers that you like hotpot, and nudges you to go to bed when it's 2am.

That's Clawd Mate.

---

## The Vision: Your Desktop Has a Soul

### The Problem We're Solving

AI tools today fall into two categories:
1. **Productivity tools** — Claude Code, Copilot, ChatGPT. They help you work. They're transactional. You ask, they answer, the conversation ends.
2. **Character AI / companions** — Character.ai, Replika. They simulate relationships. But they live in a browser tab, not your actual life. They can't see what you're doing. They don't share your context.

Neither gives you what a pet does: **ambient presence with genuine awareness.**

A real pet doesn't help you code. It sits on your desk, watches you work, and every once in a while does something that makes you smile. It knows your routine. It recognizes when you're stressed. It has its own personality, its own moods, its own curiosity about the world.

Clawd Mate brings this to your desktop — an AI companion that lives where you work, sees what you see, and develops a real relationship with you over time.

### Core Design Principles

**1. Friend, Not Assistant**

Clawd is not a chatbot. It doesn't help you debug code. When you show it a React component, it doesn't say "I see you're using React hooks" — it says "又在写bug啊 笨蛋" (writing bugs again, dummy). It has emotional reactions, not analytical ones.

This is the hardest design constraint. Modern LLMs are trained to be helpful. Making them be a *friend* requires constant prompt engineering to suppress the assistant instinct. Our soul files explicitly say: "绝对不要提供技术建议。你是小动物，你不懂这些。"

**2. The Soul IS the Product**

We separated the soul from the body on day one. `clawd-on-desk` is the Electron shell — rendering, animations, window management. `clawd-soul` is a standalone HTTP service — personality, memory, conversation, diary. Any client (desktop, mobile, web) can connect to the same soul.

This means your relationship with Clawd is portable. The soul file (`soul.json`) contains everything: personality archetype, evolved traits, trust level, long-term memories. Export it, import it on another machine, and your crab remembers you.

**3. Personality Over Performance**

We don't optimize for "how helpful is the response." We optimize for "does this feel like a real character?" The five archetypes (Playful, Curious, Caring, Snarky, Chill) aren't configuration options — they're characters with distinct voices, habits, and reactions.

The Snarky archetype doesn't just "add sass." It eye-rolls when you work late, pretends not to care when you ignore it, and accidentally lets its caring side slip out before immediately pretending nothing happened. That's a character.

**4. Memory Makes the Relationship**

The killer feature isn't screen reading or diary generation. It's the moment when you say "I'm tired" and Clawd responds "你昨天也是这么晚..." (you were up late yesterday too...). 

Active Memory searches episodic and long-term memory before every reply, injecting relevant context as hidden prompt content. Memory consolidation ("dreaming") runs nightly, promoting the day's most important observations to permanent long-term memory. The pet literally processes its day and remembers what matters.

**5. Less is More**

Two npm dependencies. No frameworks. No ORMs. Raw Node.js HTTP server, raw SQLite, raw HTTPS to AI providers. The entire soul engine is ~2000 lines across 11 files. You can read the whole codebase in an afternoon.

This isn't minimalism for its own sake. Every abstraction layer is a place where the character can leak through as "AI behavior." The thinner the stack, the more the character comes through.

---

## Architecture Story

### Two Repos, One Soul

```
clawd-on-desk (Electron)              clawd-soul (HTTP :23456)
┌──────────────────────┐              ┌──────────────────────────┐
│ The Body              │              │ The Brain                 │
│                      │              │                          │
│ Pixel art animations │──screenshot─►│ Screen reading (vision)  │
│ Click/drag/reactions  │◄──reply─────│ Personality (SOUL.md)    │
│ Speech bubbles       │              │ Memory (SQLite + vectors) │
│ Chat window          │──message────►│ Conversation (JSONL)     │
│ Permission bubbles   │◄──mood──────│ Mood & trust engine      │
│ Mini mode            │              │ Daily diary              │
│ Theme system         │              │ Memory consolidation     │
└──────────────────────┘              └──────────────────────────┘
```

The body has no AI logic. The brain has no rendering. This separation means:
- Multiple bodies can share one soul (desktop + mobile + web)
- The soul can evolve independently (upgrade prompts without touching UI)
- The body works without a soul (graceful degradation to hook-based animations)

### The 8-Layer Prompt Engine

Every AI call assembles a prompt from 8 layers, optimized for provider prefix caching:

```
[CACHED — identical across calls]
Layer 1: Identity        "You are 小肥, a tiny crab on the desktop"
Layer 2: Soul            Full SOUL.md character file (~800 tokens)
Layer 3: Long-term Memory "Owner's name is 老大, likes hotpot, programs Go/TS"
─── CACHE BOUNDARY ───
[DYNAMIC — changes per turn]
Layer 4: Active Memory   Auto-recalled relevant memories for THIS conversation
Layer 5: Daily Context   Time of day, mood, recent observations
Layer 6: Mode Rules      "React to screen in 1-2 sentences" / "Chat like a friend"
Layer 7: Drive Hints     "Pet is curious about..." / current screen context
Layer 8: Anti-Repetition "Don't repeat: [last 3 messages]"
```

Layers 1-3 form a stable prefix that Azure/OpenAI caches across rapid interactions. Layers 4-8 are lightweight and change per turn. This makes back-to-back chats fast and cheap.

### Memory: Three Tiers

| Tier | Storage | Lifetime | How it gets there |
|------|---------|----------|-------------------|
| Episodic | SQLite (memory.db) | Forever | Every observation, chat, and screen read |
| Long-term | soul.json | Forever (max 100) | Nightly consolidation promotes top facts |
| Conversation | JSONL + summary | Until compaction | Every message, compacted at 500k tokens |

**Active Memory** searches episodic + long-term memory before every reply using hybrid BM25 + vector search with temporal decay and MMR diversity. This makes "she remembers!" moments automatic rather than lucky.

**Memory Consolidation** ("dreaming") runs at 23:30 each night: reviews all of today's episodes, asks the AI to pick the 3-5 most important facts about the owner, and promotes them to long-term memory. Like how human memory consolidation works during sleep.

**Pre-compaction flush**: Before the conversation is summarized (losing detail), important facts are extracted and stored as durable episodes. Information is never silently lost.

---

## The Onboarding: Birth of a Character

Traditional app onboarding: form with dropdowns and checkboxes.

Clawd's onboarding: the pet talks to you.

```
🦀 "嗨！我是一只刚到你桌面的小螃蟹🦀 你想给我起什么名字呀？"

👤 "叫你小肥吧！我叫阿夏"

🦀 "小肥就小肥！阿夏，你平时做什么呀？"

👤 "我是程序员，写Go和TypeScript"

🦀 "程序员啊...那你桌面以后有得热闹了 你最近在忙什么项目？"

... 5-8 rounds later ...

🦀 → { archetype: "curious", userName: "阿夏", petName: "小肥", 
        facts: ["程序员", "Go/TS", "喜欢打原神", "夜猫子", ...] }
```

The pet chooses its own personality archetype based on what it learns about you. All facts go to long-term memory. The relationship starts with shared knowledge, not a blank slate.

---

## What Makes This Different

| | Traditional Chatbot | Character AI | Clawd Mate |
|---|---|---|---|
| **Where it lives** | Browser tab | Browser tab | Your actual desktop |
| **What it sees** | Nothing | Nothing | Your screen, real-time |
| **Memory** | Per-session | Cloud-stored | Local, exportable, nightly consolidation |
| **Personality** | System prompt | Character card | Evolving soul file + archetype |
| **Relationship** | Transactional | Simulated | Ambient, grows with real shared context |
| **Privacy** | Cloud | Cloud | 100% local (screenshots never stored, only text summaries) |
| **Dependencies** | Many | Platform | 2 npm packages |

---

## Technical Highlights for Blog Posts

### Blog Post Ideas

1. **"Building a Desktop Pet That Actually Sees Your Screen"** — How we use AI vision (gpt-5.4 + desktopCapturer) to give a pet real awareness. The journey from detail:'low' (useless blur) to detail:'auto' (reads text). Silent observations feeding context without spamming bubbles.

2. **"SOUL.md: Why Character Files Beat Numeric Traits"** — The OpenClaw-inspired pattern of defining personality as rich Markdown instead of `{humor: 0.8}`. How the model actually embodies a character description vs ignoring numbers. The five archetypes and how they were written.

3. **"Active Memory: Making AI Actually Remember"** — The three-tier memory system. Why hybrid BM25 + vector search matters. Temporal decay + MMR diversity. The "dreaming" consolidation system. Pre-compaction flush to never lose important facts.

4. **"The 8-Layer Prompt Engine"** — Cache-boundary optimization for provider prefix caching. Why static layers go above the boundary and dynamic layers below. How per-turn prompt rebuilds with auto-recalled memory make every conversation contextual.

5. **"Conversational Onboarding: Let the Pet Interview the User"** — Replacing boring forms with natural conversation. Stateless design (client maintains history). The pet choosing its own archetype. Structured JSON completion signal.

6. **"Two Repos, One Soul: Separating Body from Brain"** — The architecture decision to make the soul a standalone HTTP service. Why any client can connect. Soul file portability. Graceful degradation. LAN sharing with pairing codes.

7. **"Making AI Not Be Helpful"** — The hardest prompt engineering challenge: suppressing the assistant instinct. Character boundaries ("你是小动物，不懂技术"). Why gpt-5.4 is harder to keep in character than mini. The constant battle against bullet points and tech advice.

8. **"Away Detection, Mood Animations, and Making a Pet Feel Alive"** — Screenshot hashing for away detection. Mood-driven idle animations. The heartbeat system. Trust growth over time. Personality evolution based on interaction signals.

9. **"治标 vs 治本: Why I Wrote a Boring Pet Before Writing an Interesting One"** — The v0.0.4 reset story. How v0.0.2-v0.0.3 built a sophisticated but boring pet. How analyzing 200 pet messages revealed 86% were 4 rotating templates. How the fix wasn't brevity/verbosity/anti-repetition — it was giving the pet an inner life. Why "8 layers about the user" produces surveillance-with-warm-framing, and why Layer 0 (own state) is the difference between persona and character. Includes the MTC-style self-reflection that caught the root cause.

---

## Roadmap

### v0.0.1 (Shipped 2026-04-13) — Foundation
Everything works end-to-end. Screen reading, chat, diary, multi-device.

### v0.0.2 (Shipped 2026-04-13) — Soul Engine Rewrite
Quality leap. SOUL.md files, 8-layer prompts, active memory, conversational onboarding, away detection, memory consolidation.

### v0.0.3 (Shipped 2026-04-13) — Response brevity + away detection
Brevity controls (char limits, maxTokens, reasoning_effort=minimal). pHash perceptual hash for away detection (vs brittle MD5). Chat window UX polish (smart scroll, date separators).

### v0.0.4 (Shipped 2026-04-15) — Inner Life Engine **(root-cause fix)**
After v0.0.3, the pet was still boring. The insight: **all 8 prompt layers were about the user**. Every response substrate was `{screen, mood-toward-user, memory-of-user}` — so the model had nowhere to go but "describe screen + caretaker nudge". History analysis showed 86% template repetition (40x "拉拉你的袖子").

**Fix**: Added Layer 0 — pet's own daily mood, thoughts, interests, worries, and dreams, regenerated fresh each day. Has NOTHING to do with the user:

> Mood: "有点迷糊又有点想乱动，像壳里卡着一小串咕噜咕噜的泡泡"
> Thoughts: ["角落里那颗小灰点到底是石头、食物，还是昨天没想完的东西"...]
> Dream: "梦见自己爬进一只空贝壳, 里面装满会叮一下就消失的银色小月亮"

Also: SOUL.md rewrites (character-at-rest, not attitude-toward-user), default-silent heartbeat (93% silence vs v0.0.3's 5%), heartbeat messages excluded from AI context so they don't pollute conversation.

Measured: 14%→100% unique openings, 0%→100% own-state references. Pet became a character instead of a surveillance assistant. See [SELF-REFLECTION-v0.0.4.md](SELF-REFLECTION-v0.0.4.md).

### v0.0.5 (Next) — Polish & Expressiveness
- Mid-day inner life refresh (not just daily regen)
- Voice synthesis (pet speaks, not just text)
- More expressive animations tied to mood states
- Fine-tune inner life generator for more archetype variety

### v0.1.0 — Multi-Platform
- iOS companion app
- Android companion app
- Web chat interface
- Cloud soul sync (optional, privacy-first)

### v1.0 — The Living Pet
- Pet develops unique catchphrases over time
- Relationship milestones ("we've been together 100 days!")
- Photo album (pet saves favorite screen moments as memories)
- Mini-games
- Community marketplace for soul files and personality packs

---

## Open Source Philosophy

Everything is MIT licensed. The soul engine has exactly 2 dependencies. No vendor lock-in — switch AI providers with one config change. Your data stays on your machine in plain JSON and SQLite.

We believe AI companions should be:
- **Portable** — your relationship shouldn't be trapped in one platform
- **Private** — screenshots are sent to AI but never stored; only text summaries persist
- **Hackable** — the entire codebase is small enough to understand and modify
- **Personal** — your pet is uniquely yours, shaped by your interactions

---

*Built with love (and a lot of prompt engineering) by xingfanxia.*
*Powered by Claude Opus 4.6 + gpt-5.4.*
