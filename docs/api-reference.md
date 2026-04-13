# API Reference

Base URL: `http://127.0.0.1:23456` (or LAN IP when in LAN mode)

## Core

### POST /react
Screen read + friend-like reaction. Sends screenshot to AI with full conversation context.

```json
// Request
{
  "screenshot": "<base64 JPEG>",
  "foregroundApp": "Arc",
  "windowTitle": "YouTube - Tipping Culture"
}

// Response
{
  "ok": true,
  "reply": "哎呀这个小费话题...",
  "mood": { "energy": 0.8, "interest": 0.9, "affection": 0.7 }
}
```

### POST /chat
Talk to the pet. Uses full persistent conversation context (JSONL + compacted summary).

```json
// Request
{ "message": "小肥你好！" }

// Response
{
  "ok": true,
  "reply": "嗨呀主人～",
  "mood": { "energy": 0.8, "interest": 0.9, "affection": 0.7 }
}
```

### POST /observe
Silent screen observation. Feeds into conversation context but returns no commentary.

```json
// Request
{
  "screenshot": "<base64 JPEG>",
  "foregroundApp": "Arc",
  "windowTitle": "YouTube",
  "trigger": "periodic"
}

// Response
{ "ok": true, "action": "silent", "summary": "User watching YouTube video about..." }
```

### GET /proactive
Heartbeat — pet reviews accumulated context and decides if it wants to say something.

```json
// Response (has something to say)
{
  "ok": true,
  "commentary": "话说你最喜欢吃什么呀",
  "mood": { ... },
  "action": "speech-bubble",
  "duration": 10000
}

// Response (silent)
{ "ok": true, "commentary": "", "action": "none" }
```

## Chat History

### GET /chat/history
Full persistent conversation history.

```json
{
  "ok": true,
  "summary": "Earlier conversation summary text...",  // null if no compaction yet
  "messages": [
    { "role": "user", "content": "hello", "ts": "2026-04-13T..." },
    { "role": "assistant", "content": "hi!", "ts": "2026-04-13T..." },
    { "role": "system", "content": "[观察] user on YouTube", "ts": "...", "type": "observation" }
  ]
}
```

## Diary

### POST /diary/generate
Generate diary entry for today (or specified date).

### GET /diary?date=YYYY-MM-DD
Get diary entry for a specific date.

### GET /diary/list?limit=7
List recent diary entries.

## Soul

### GET /soul
Export the complete soul file (personality, mood, trust, memories, archetype, evolved traits).

### POST /soul/import
Import a soul file (multi-device transfer).

### PUT /soul/archetype
Set personality archetype. Valid: `playful`, `curious`, `caring`, `snarky`, `chill`.

```json
{ "archetype": "snarky" }
```

## Config

### GET /config
Get config (secrets masked as `••••`).

### PUT /config
Partial update. Only updates fields present in the request body.

### POST /config/test-key
Test an API key for a specific provider.

```json
{ "provider": "azure-openai", "key": "...", "endpoint": "...", "deployment": "..." }
```

## Mood

### GET /mood
Current mood, trust, proactiveness level.

### POST /mood/event
Report a lifecycle event. Events: `chat-received`, `pet-clicked`, `user-returned`, `morning`, `night`, etc.

## Multi-Device

### POST /pair/enable-lan
Switch to LAN mode (bind 0.0.0.0). Requires server restart.

### POST /pair/generate
Generate a 6-digit pairing code (5 min expiry).

### POST /pair/connect
Submit pairing code + device name → receive auth token.

### GET /pair/status
LAN addresses, paired devices, pending code status.

## Health

### GET /health
Service status, token usage, mood, trust, memory count, chat session stats.

```json
{
  "ok": true,
  "service": "clawd-soul",
  "version": "0.1.0",
  "uptime": 3600,
  "hasApiKey": true,
  "provider": "azure-openai",
  "memoryCount": 150,
  "chatSession": { "messages": 45, "hasSummary": false },
  "tokenUsage": {
    "totalPromptTokens": 25000,
    "totalCompletionTokens": 3000,
    "totalTokens": 28000,
    "lastPromptTokens": 1200,
    "requestCount": 30
  },
  "mood": { "energy": 0.8, "interest": 0.9, "affection": 0.7 },
  "trust": 0.65
}
```

## Authentication

Local requests (127.0.0.1) always bypass auth. Remote requests require `Authorization: Bearer <token>` header. Token obtained via pairing flow.

Public endpoints (no auth): `GET /health`, `POST /pair/connect`.
