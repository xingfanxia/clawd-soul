# clawd-soul

The brain behind the crab. A standalone AI soul engine for the [Clawd](https://github.com/xingfanxia/clawd-on-desk) desktop pet.

## What is this?

Clawd started as a desktop pet that reacts to your AI coding sessions. But a pet that only plays animations isn't really *alive*. `clawd-soul` is what makes it alive — personality, memory, screen awareness, and a genuine relationship with its owner.

**clawd-on-desk** (Electron) is the body. **clawd-soul** is the brain:

- **Inner Life (v0.0.4)** — pet has its own daily mood, thoughts, interests, worries, and dreams, generated fresh each day as the top prompt layer. Reactions start from pet's own world, not from screen narration.
- **Screen reading** — AI vision analyzes your screen every 30s, feeding context but NOT driving personality
- **Personality** — 5 archetypes as rich character files describing the pet's own life, not attitude toward user
- **Memory** — Hybrid search (SQLite FTS5 + vector embeddings), nightly consolidation ("dreaming"), auto-recall before every reply
- **Conversation** — Persistent JSONL chat with 500k token compaction, cache-optimized prompt ordering
- **Active Memory** — Searches episodic + long-term memory before every response, making "she remembers!" moments automatic
- **Heartbeat (v0.0.4)** — 85%+ silent by default. Pet only speaks when it has something of its own to say. No more monologues.
- **Diary** — Daily diary generation in the pet's own voice at 23:00
- **Conversational onboarding** — The pet interviews you to learn your name, interests, and pick its own personality
- **Multi-device** — LAN mode with pairing codes, one soul across multiple surfaces

## The Philosophy

Clawd is a **character with its own life** who happens to share your desktop — not an assistant, not a companion-ware chatbot. It has its own moods, its own obsessions, its own small problems. Sometimes it notices you. Sometimes it's preoccupied with the light changing, a dream it had, or why clouds drift slowly. When you click it, you're interrupting its day — in a nice way.

When it sees you writing code, it doesn't say "I see you're using React hooks". It might say "嗯? ... 你知道云为什么飘那么慢吗" (hm? ... do you know why clouds drift so slow) — because that's what it was just thinking about.

The soul IS the product. Export `soul.json` and you take the entire pet with you — personality, memories, trust, today's weird thoughts, everything.

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
| GET | /inner-life | Read pet's current daily mood/thoughts (v0.0.4) |
| POST | /inner-life/regen | Regenerate pet's daily inner state (v0.0.4) |
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
  prompt-engine.js    9-layer prompt assembly (Layer 0 = inner state)
  inner-life.js       Pet's own daily state generator (v0.0.4)
  active-memory.js    Auto-recall: search memory before every reply
  observer.js         Orchestrator: screen read, chat, heartbeat
  chat-session.js     Persistent JSONL + 500k token compaction
  memory.js           SQLite + FTS5 + sqlite-vec, hybrid search, MMR
  personality.js      Load SOUL.md files, trait evolution, drives
  engine.js           Mood, trust, proactiveness, memory consolidation
  soul-file.js        Soul state persistence (v4 schema)
  provider.js         4 AI providers via node:https
  diary.js            Daily diary generation
  config.js           Config management

  souls/                                    (v0.0.4: rewritten as character-at-rest,
                                             not attitude-toward-user)
    playful.md        小淘气 — curious crab obsessed with "why?"
    curious.md        学霸 — always puzzling over weird problems
    caring.md         暖宝宝 — sensitive to atmosphere, own moods
    snarky.md         毒舌 — nitpicky, tsundere, owns own takes
    chill.md          佛系 — slow rhythm, drifts in own thoughts
```

```
~/.clawd/
  config.json         API keys, provider, pet name, settings
  soul.json           Personality, mood, trust, long-term memory, innerLife (v4)
  memory.db           Episodic memories (SQLite + FTS5 + sqlite-vec)
  chat-history.jsonl  Persistent conversation (heartbeat type excluded from AI ctx)
  chat-summary.json   Compacted summary of older messages
```

## Prompt layers (v0.0.4)

```
[0 Inner State]    ← NEW. Pet's own mood/thoughts/interests today.
[1 Identity]
[2 Soul archetype]
[3 Long-term memory]
─── cache boundary ───
[4 Active memory]
[5 Daily context]
[6 Mode rules]
[7 Drive hints]
[8 Anti-repetition]  (v0.0.4: expanded 3→8 messages with fuzzy pattern warning)
```

Layer 0 is what makes the pet a character instead of a surveillance assistant. See [SELF-REFLECTION-v0.0.4.md](docs/SELF-REFLECTION-v0.0.4.md) for the architectural reasoning.

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
- [SELF-REFLECTION-v0.0.4.md](docs/SELF-REFLECTION-v0.0.4.md) — Why v0.0.3 felt boring and what v0.0.4 changed
- [v0.0.4 Plan](docs/v0.0.4-plan.md) — Inner Life Engine design
- [v0.0.2 Plan](docs/v0.0.2-soul-engine-rewrite.md) — Soul engine rewrite design doc
- [API Reference](docs/api-reference.md) — All endpoints with request/response examples
- [Architecture](docs/architecture.md) — Data flow, prompt system, personality engine

## License

MIT
