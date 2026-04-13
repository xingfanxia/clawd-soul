# clawd-soul

The brain behind the crab. A standalone AI soul engine for the [Clawd](https://github.com/xingfanxia/clawd-on-desk) desktop pet.

## What is this?

Clawd started as a desktop pet that reacts to your AI coding sessions. But a pet that only plays animations isn't really *alive*. `clawd-soul` is what makes it alive — personality, memory, screen awareness, and a genuine relationship with its owner.

**clawd-on-desk** (Electron) is the body. **clawd-soul** is the brain:

- **Screen reading** — AI vision analyzes your screen every 30s, building a running understanding of what you're doing
- **Personality** — 5 distinct archetypes defined as rich Markdown character files (SOUL.md), not numeric traits
- **Memory** — Hybrid search (SQLite FTS5 + vector embeddings), nightly consolidation ("dreaming"), auto-recall before every reply
- **Conversation** — Persistent JSONL chat with 500k token compaction, cache-optimized prompt ordering
- **Active Memory** — Searches episodic + long-term memory before every response, making "she remembers!" moments automatic
- **Diary** — Daily diary generation in the pet's own voice at 23:00
- **Conversational onboarding** — The pet interviews you to learn your name, interests, and pick its own personality
- **Multi-device** — LAN mode with pairing codes, one soul across multiple surfaces

## The Philosophy

Clawd is a **friend**, not an assistant. When it sees you writing code, it doesn't say "I see you're using React hooks" — it says "又在写bug啊 笨蛋" (writing bugs again, dummy). It has emotional reactions, not analytical ones.

The soul IS the product. Export `soul.json` and you take the entire relationship with you — personality, memories, trust, everything.

See [PROJECT-VISION.md](docs/PROJECT-VISION.md) for the full story, architecture deep-dive, and blog post ideas.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your API keys
npm start              # starts on :23456
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| POST | /react | Screen read + friend-like reaction (with screenshot) |
| POST | /chat | Talk to the pet (continuous conversation) |
| POST | /observe | Silent screen observation (feeds context) |
| POST | /onboarding/chat | Conversational onboarding (pet learns about user) |
| GET | /proactive | Heartbeat — pet decides to speak |
| GET | /health | Status, token usage, mood, trust |
| GET | /chat/history | Full conversation history |
| POST | /memory/consolidate | Trigger memory consolidation ("dreaming") |
| POST | /diary/generate | Generate diary entry |
| GET | /diary?date=YYYY-MM-DD | Read diary |
| GET | /soul | Export soul file |
| PUT | /soul/archetype | Set personality archetype |
| PUT | /config | Update config |
| POST | /pair/generate | Generate pairing code (LAN mode) |

## Architecture

```
src/
  server.js           HTTP server, routing, lifecycle
  prompt-engine.js    8-layer prompt assembly with cache boundary
  active-memory.js    Auto-recall: search memory before every reply
  observer.js         Orchestrator: screen read, chat, heartbeat
  chat-session.js     Persistent JSONL + 500k token compaction
  memory.js           SQLite + FTS5 + sqlite-vec, hybrid search, MMR
  personality.js      Load SOUL.md files, trait evolution, drives
  engine.js           Mood, trust, proactiveness, memory consolidation
  soul-file.js        Soul state persistence (v3 schema)
  provider.js         4 AI providers via node:https
  diary.js            Daily diary generation
  config.js           Config management

  souls/
    playful.md        小淘气 — mischievous, teasing, secretly caring
    curious.md        学霸 — endlessly curious, nerdy, asks "why?"
    caring.md         暖宝宝 — warm, observant, quietly supportive
    snarky.md         毒舌 — sharp tongue, tsundere, blunt but caring
    chill.md          佛系 — calm, philosophical, unhurried
```

```
~/.clawd/
  config.json         API keys, provider, pet name, settings
  soul.json           Personality, mood, trust, long-term memory (v3)
  memory.db           Episodic memories (SQLite + FTS5 + sqlite-vec)
  chat-history.jsonl  Persistent conversation
  chat-summary.json   Compacted summary of older messages
```

## Providers

4 AI providers via `node:https` (no SDK dependencies):
- Azure OpenAI (recommended — gpt-5.4 for vision + chat)
- OpenAI
- Google Gemini
- Anthropic Claude

Embeddings: Gemini `gemini-embedding-001` (768-dim).

## Dependencies

Just 2: `better-sqlite3` + `sqlite-vec`. Everything else is Node built-ins.

## Docs

- [PROJECT-VISION.md](docs/PROJECT-VISION.md) — Full story, architecture, blog post ideas
- [v0.0.2 Plan](docs/v0.0.2-soul-engine-rewrite.md) — Soul engine rewrite design doc
- [API Reference](docs/api-reference.md) — All endpoints with request/response examples
- [Architecture](docs/architecture.md) — Data flow, prompt system, personality engine

## License

MIT
