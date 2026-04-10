<div align="center">

# conversation-sqlite-persist

**Save every Claude Code conversation to SQLite. Never lose context again.**

[![npm version](https://img.shields.io/npm/v/conversation-sqlite-persist)](https://www.npmjs.com/package/conversation-sqlite-persist)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-orange)](https://docs.anthropic.com/claude-code)

[Install](#-install) · [How It Works](#-how-it-works) · [CLI](#-cli-reference) · [Menu](#-interactive-menu) · [FAQ](#-faq)

</div>

---

## The Problem

You're deep in a debugging session. Context fills up. `/clear` fires. **Your conversation is gone.**

No transcript. No history. Start from zero.

## The Solution

`conversation-sqlite-persist` hooks into Claude Code and auto-saves every conversation to a local SQLite database — with an interactive menu to retrieve, summarize, and resume any past session.

```
Every message  ──►  Saved to SQLite in real-time
/clear fires   ──►  Transcript backed up before clear
Session ends   ──►  Everything finalized to DB
Type /menu     ──►  Browse, search, resume any session
```

---

## Install

```bash
npx conversation-sqlite-persist@latest
```

Restart Claude Code. Done. Every conversation now auto-saves.

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLAUDE CODE                           │
│                                                         │
│   User Prompt ──► UserPromptSubmit Hook                 │
│                    ├── detect-conversation-persist.js    │
│                    │   └─ Detects /command, injects menu│
│                    └── auto-save.js (Stop hook)         │
│                        └─ Parses transcript → SQLite    │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  conversations  │
              │      .db        │
              │                 │
              │  sessions       │
              │  messages       │
              └─────────────────┘
```

### What Gets Saved

| Source | Method |
|--------|--------|
| Every user message | Real-time buffer write |
| Full conversation | Transcript parsing on Stop hook |
| Manual save | `/conversation-sqlite-persist` → generate/update |
| Before `/clear` | Detect hook backs up to JSON |

### Storage

```
~/.claude/
├── conversations.db                      # SQLite database
├── hooks/
│   ├── db-utils.js                       # DB layer (sqlite3)
│   ├── detect-conversation-persist.js    # Menu injection hook
│   └── auto-save.js                      # Auto-save on session stop
├── skills/conversation-sqlite-persist/
│   ├── SKILL.md                          # Skill definition
│   ├── menu.json                         # Interactive menu config
│   └── skill-actions.js                  # CLI: save, read, clear
└── backups/                              # JSON backups (clear events)
```

---

## Interactive Menu

Type `/conversation-sqlite-persist` in Claude Code to open the menu:

```
1. generate/update   — Save/update this session to SQLite
2. load              — Save → read → summarize → resume
3. cancel            — Do nothing
```

### generate/update
Saves the current conversation to the database. Safe to run anytime — uses `INSERT OR IGNORE` to prevent duplicates.

### load
The full workflow:

```
Save session → Read messages → Clear screen → Show summary
```

Generates a hybrid summary with:

```markdown
# Session Resume — {session-id}

## Konteks
- **Topik aktif**: What was being discussed
- **Status**: IN PROGRESS / BLOCKED / COMPLETED
- **Keputusan kritis**: Key decisions made
- **Files dimodifikasi**: Files changed

## Langkah Selanjutnya
- [ ] Next steps or open tasks

## Timeline Detail
| Waktu | Event | Keterangan |
|-------|-------|------------|
| 14:30 | feature | Started auth refactor |
| 14:45 | bugfix | Fixed token expiry edge case |
```

---

## CLI Reference

```bash
conv-persist <command> [options]
```

### status

```bash
conv-persist status
```

```
  Active Database (conversations.db):
    Sessions:  47
    Messages:  2,341
    Size:      1.23 MB
    Oldest:    2026-01-15T09:30:00Z
    Newest:    2026-04-10T18:00:00Z
```

### list

```bash
conv-persist list                    # last 20 sessions
conv-persist list --limit 50         # more sessions
```

### query

```bash
conv-persist query "SELECT * FROM messages WHERE content LIKE '%auth%'"
conv-persist query "SELECT session_id, COUNT(*) as msgs FROM messages GROUP BY session_id ORDER BY msgs DESC"
```

### save

```bash
conv-persist save <session-id>       # save from transcript to DB
```

### read

```bash
conv-persist read <session-id>       # read messages from DB
```

### cleanup

```bash
conv-persist cleanup                 # VACUUM database
```

---

## Database Schema

```sql
-- Sessions
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    total_messages INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages (deduped via unique index)
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_index INTEGER,
    role TEXT CHECK(role IN ('user', 'assistant', 'system', 'tool', 'unknown')),
    content TEXT,
    tool_calls TEXT,
    tool_results TEXT,
    timestamp TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

---

## Query Examples

### Find conversations about a topic

```sql
SELECT s.id, s.project_path, s.ended_at, s.total_messages
FROM messages m
JOIN sessions s ON m.session_id = s.id
WHERE m.content LIKE '%deploy%'
GROUP BY m.session_id
ORDER BY MAX(m.timestamp) DESC
LIMIT 10;
```

### Export a session as text

```sql
SELECT role || ' (' || timestamp || '):' || char(10) || content
FROM messages
WHERE session_id = 'abc123-def456'
ORDER BY message_index ASC;
```

### Storage overview

```sql
SELECT
  (SELECT COUNT(*) FROM sessions) as total_sessions,
  (SELECT COUNT(*) FROM messages) as total_messages,
  (SELECT COUNT(DISTINCT session_id) FROM messages) as sessions_with_data;
```

---

## FAQ

**Q: Does this slow down Claude Code?**
A: No. Hook overhead is < 10ms per message. The Stop hook runs after the response is complete.

**Q: Where is my data?**
A: `~/.claude/conversations.db` on your machine. No cloud sync. No external APIs.

**Q: Can I search old conversations?**
A: Yes. Use `conv-persist query "..."` or open the DB with any SQLite client.

**Q: What if I use `/clear`?**
A: The hook detects `/clear` and backs up the full transcript to `~/.claude/backups/` before clearing.

**Q: Can I uninstall it?**
A: Remove the hooks from `~/.claude/settings.json`, then:
```bash
rm -rf ~/.claude/hooks/{db-utils,detect-conversation-persist,auto-save}.js
rm -rf ~/.claude/skills/conversation-sqlite-persist
rm -rf ~/.claude/bin/conv-persist*
# conversations.db is yours to keep or delete
```

---

## License

MIT
