# Architecture

## Overview

clawd-soul is a standalone Node.js HTTP server that provides the AI brain for the Clawd desktop pet. It runs on port 23456 and communicates with the Electron pet (clawd-on-desk) via REST API.

```
clawd-on-desk (Electron)              clawd-soul (HTTP :23456)
┌──────────────────────┐              ┌──────────────────────────┐
│ desktopCapturer      │──POST /react─►│ AI vision + chat context │
│  → 1920x1080 JPEG    │◄─── reply ───│  → friend-like reaction  │
│                      │              │                          │
│ Click pet            │──POST /chat──►│ Persistent conversation  │
│ Chat window          │◄─── reply ───│  → JSONL + compaction    │
│                      │              │                          │
│ Silent (every 45s)   │─POST /observe►│ Context accumulation     │
│                      │              │  → no response shown     │
│                      │              │                          │
│ Heartbeat (5min)     │─GET /proact──►│ Pet decides to speak     │
│                      │◄── or not ───│  → drives, questions     │
└──────────────────────┘              └──────────────────────────┘
```

## Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | HTTP routing, .env loader, port discovery, graceful shutdown |
| `config.js` | Config schema, load/save `~/.clawd/config.json`, env var overrides |
| `provider.js` | 4 AI providers (Azure/OpenAI/Gemini/Claude) via node:https, token tracking |
| `observer.js` | Slim orchestrator: delegates to prompt-engine + active-memory |
| `chat-session.js` | Persistent JSONL, pre-compaction memory flush, cache optimization |
| `memory.js` | SQLite + FTS5 + sqlite-vec, hybrid search, autoRecall with temporal decay + MMR |
| `personality.js` | Loads soul files, trait evolution, drives, signal detection |
| `prompt-engine.js` | 9-layer prompt assembly (v0.0.4: Layer 0 inner state), cache-optimized |
| `inner-life.js` | **v0.0.4**: generates pet's daily mood/thoughts/interests/dreams |
| `active-memory.js` | Auto-recall: search memory before every reply, extract personal facts |
| `souls/*.md` | 5 archetype character files (rewritten v0.0.4 as character-at-rest) |
| `engine.js` | Mood decay, trust, proactiveness, nightly memory consolidation |
| `soul-file.js` | Soul v4: innerLife, longTermMemory, consolidation tracking |
| `diary.js` | Daily diary generation at 23:00, context gathering |

## Data Flow

### Click Pet → Screen Reaction
```
User clicks pet
  → Electron captures screen (1920x1080 JPEG q85)
  → POST /react { screenshot, foregroundApp, windowTitle }
  → observer.reactToScreen():
      1. Build system prompt (character brief from archetype)
      2. Load full conversation from chat-session.js (JSONL)
      3. Append screenshot as user message with "react as friend" instruction
      4. Call AI provider (gpt-5.4-mini, detail:auto)
      5. Add reply to persistent session
      6. Return { reply, mood }
  → Electron shows thinking animation → speech bubble with reply
```

### Conversation Context
```
Every AI call includes:
  [1] System prompt (archetype character brief)     ← STABLE (cached)
  [2] Compacted summary of old conversations        ← STABLE (cached)
  [3] Recent observations [观察] user was on Arc...  ← grows slowly
  [4] User messages + pet replies                   ← grows per interaction
  [5] New user input or screen reaction prompt       ← changes each call

Items 1-2 form a stable prefix → Azure/OpenAI caches this → faster + cheaper
```

### Token Management
```
Total context approaches 500k tokens?
  → Take oldest 70% of messages
  → Send to AI: "summarize this conversation"
  → Save summary to ~/.clawd/chat-summary.json
  → Keep newest 50 messages in chat-history.jsonl
  → Summary becomes part of the stable prefix (cached)
```

## Personality System

### Archetypes
| ID | Name | Core Traits |
|----|------|-------------|
| `playful` | 小淘气 | humor=0.8, sass=0.7, energy=0.8 |
| `curious` | 学霸 | curiosity=0.95, warmth=0.6 |
| `caring` | 暖宝宝 | warmth=0.95, energy=0.5 |
| `snarky` | 毒舌 | sass=0.95, humor=0.7 |
| `chill` | 佛系 | energy=0.3, curiosity=0.4 |

### Evolution
Traits shift based on interaction signals:
- User laughs → humor +0.03
- User shares personal info → warmth +0.02
- User asks question → curiosity +0.01
- User pushes back → sass -0.01

### Drives
The pet has its own questions it wants to ask (15 per language). After 1.5+ hours without chat, the pet picks one and initiates conversation. Questions are tracked so it doesn't repeat.
