# clawd-soul

Standalone AI soul engine for the [Clawd](https://github.com/xingfanxia/clawd-on-desk) desktop pet.

## What is this?

The brain behind the crab. `clawd-soul` is a Node.js HTTP service that gives Clawd personality, memory, and the ability to see your screen.

**clawd-on-desk** (Electron) handles the pet UI. **clawd-soul** handles everything that makes it feel alive:
- Screen reading via AI vision
- Persistent conversation (JSONL + compaction at 500k tokens)
- 5 personality archetypes (playful, curious, caring, snarky, chill)
- Personality evolution based on interactions
- Hybrid memory search (SQLite FTS5 + vector embeddings)
- Daily diary generation
- Multi-device sharing (LAN mode with pairing auth)

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
| GET | /proactive | Heartbeat — pet decides to speak |
| GET | /health | Status, token usage, mood, trust |
| GET | /chat/history | Full conversation history (JSONL) |
| POST | /diary/generate | Generate diary entry |
| GET | /diary?date=YYYY-MM-DD | Read diary |
| GET | /soul | Export soul file |
| PUT | /soul/archetype | Set personality archetype |
| PUT | /config | Update config |
| POST | /pair/generate | Generate pairing code (LAN mode) |

## Architecture

```
~/.clawd/
  config.json           API keys, provider, pet name, settings
  soul.json             Personality, mood, trust, archetype, evolved traits
  memory.db             Episodic memories (SQLite + FTS5 + sqlite-vec)
  chat-history.jsonl    Persistent conversation
  chat-summary.json     Compacted summary of older messages
  soul-runtime.json     Running server port + PID (ephemeral)
```

## Providers

Supports 4 AI providers via `node:https` (no SDK dependencies):
- Azure OpenAI (recommended — gpt-5.4-mini for vision + chat)
- OpenAI
- Google Gemini
- Anthropic Claude

Embeddings always use Gemini (`gemini-embedding-001`, 768-dim).

## Dependencies

Just 2: `better-sqlite3` + `sqlite-vec`. Everything else is Node built-ins.

## License

MIT
