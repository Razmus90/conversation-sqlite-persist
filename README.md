<div align="center">

# conversation-sqlite-persist

**Zero-miss conversation persistence for Claude Code**

Never lose a conversation again. Every message. Every session. Forever searchable.

[![npm version](https://img.shields.io/npm/v/conversation-sqlite-persist)](https://www.npmjs.com/package/conversation-sqlite-persist)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-orange)](https://docs.anthropic.com/claude-code)

</div>

---

## The Problem

You're deep in a debugging session. Context window fills up. Claude compacts. **Your conversation is gone.**

Or worse — you type `/clear` by accident. Weeks of context, vanished.

## The Solution

`conversation-sqlite-persist` intercepts every message at the hook level and saves it to SQLite. When `/clear` fires, it backs up first. When compaction kicks in, it backs up first. When the session ends, it saves everything.

**Zero data loss. Guaranteed.**

```
User types message ──► Saved to SQLite instantly
/clear detected     ──► Backup → then clear
Context full        ──► Backup → then compact
Session ends        ──► Final save → cleanup
90 days pass        ──► Auto-archive to separate DB
```

---

## Install

```bash
npx conversation-sqlite-persist@latest
```

Restart Claude Code. That's it. Conversations now auto-save.

---

## How It Works

### 4-Layer Hook Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CLAUDE CODE SESSION                      │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ beforeSubmit     │───►│ Layer 1: Real-Time Capture    │   │
│  │ Prompt           │    │ → Buffer + SQLite              │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ /clear command   │───►│ Layer 2: Pre-Clear Backup     │   │
│  │                  │    │ → Full transcript → JSON       │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ Context full     │───►│ Layer 3: Pre-Compact Backup   │   │
│  │                  │    │ → Full transcript → JSON       │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ Session ends     │───►│ Layer 4: Final Save           │   │
│  │                  │    │ → Final backup + cleanup       │   │
│  └──────────────────┘    └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Storage

| File | Purpose |
|------|---------|
| `~/.claude/conversations.db` | Active sessions (< 90 days) |
| `~/.claude/conversations-archive.db` | Archived sessions (> 90 days) |
| `~/.claude/backups/` | Event-specific JSON backups |
| `~/.claude/buffer/` | Real-time message buffers |

---

## CLI Reference

```bash
conv-persist <command> [options]
```

### `status` — Overview

```bash
conv-persist status
```

```
  Active Database (conversations.db):
    Sessions:  47
    Messages:  2,341
    Size:      1.23 MB

  Archive Database (conversations-archive.db):
    Sessions:  128
    Messages:  8,729
    Size:      4.56 MB
```

### `list` — Browse Sessions

```bash
conv-persist list                    # active sessions
conv-persist list --archived         # archived sessions
conv-persist list --limit 10         # pagination
```

### `query` — Search Everything

```bash
# Search active conversations
conv-persist query "SELECT * FROM messages WHERE content LIKE '%authentication%'"

# Search archived conversations
conv-persist query "SELECT * FROM messages WHERE content LIKE '%authentication%'" --archived
```

### `restore` — Bring Back Old Conversations

```bash
conv-persist restore abc123          # restore one session
conv-persist restore --all           # restore everything
```

### `export` — Save to File

```bash
conv-persist export abc123 --format json      # JSON
conv-persist export abc123 --format markdown  # Markdown
conv-persist export abc123 --format csv       # CSV
conv-persist export abc123 --format markdown -o conversation.md
```

### `archive` — Manual Archive

```bash
conv-persist archive                 # archive sessions > 90 days
conv-persist archive --days 60       # custom threshold
```

### `cleanup` — Maintenance

```bash
conv-persist cleanup                                    # VACUUM + clear buffers
conv-persist cleanup --delete-archived-older-than 365   # delete archive > 1 year
```

---

## Archive System

Old conversations don't get deleted. They get archived.

```
conversations.db (< 90 days)  ──►  conversations-archive.db (> 90 days)
         │                                      │
         │    restore <session-id> ◄────────────┘
         │                                      │
         └──► query "..." --archived ───────────┘
```

**"I didn't open Claude for 4 months. Are my conversations gone?"**

No. They're in `conversations-archive.db`. Use `conv-persist list --archived` to find them, `conv-persist restore <id>` to bring them back, or `conv-persist query "..." --archived` to search directly.

---

## Direct SQLite Access

```sql
-- Recent sessions
SELECT id, project_path, ended_at, total_messages
FROM sessions ORDER BY ended_at DESC LIMIT 20;

-- Full-text search
SELECT s.project_path, m.role, m.content, m.timestamp
FROM messages m
JOIN sessions s ON m.session_id = s.id
WHERE m.content LIKE '%bug%'
ORDER BY m.timestamp DESC;

-- Storage stats
SELECT
  (SELECT COUNT(*) FROM sessions) as sessions,
  (SELECT COUNT(*) FROM messages) as messages;
```

---

## Directory Structure

```
~/.claude/
├── hooks/
│   ├── db-utils.js                  # SQLite utilities (active + archive)
│   ├── capture-user-message.js      # Real-time capture
│   ├── detect-clear.js              # /clear detection
│   ├── pre-compact-backup.js        # Pre-compaction backup
│   ├── final-save.js                # Session-end save
│   └── archive-manager.js           # Auto-archive engine
├── bin/
│   ├── conv-persist.js              # CLI
│   └── conv-persist.bat             # Windows wrapper
├── skills/conversation-sqlite-persist/
│   └── SKILL.md                     # Skill definition
├── conversations.db                 # Active DB
├── conversations-archive.db         # Archive DB
├── backups/                         # JSON backups
└── buffer/                          # Real-time buffers
```

---

## Privacy & Security

| Concern | Answer |
|---------|--------|
| Where is data stored? | `~/.claude/` on your machine only |
| Does it sync to cloud? | No |
| Does it call external APIs? | No |
| Can I encrypt the database? | Yes — use SQLite encryption extensions |
| GDPR compliance? | `conv-persist cleanup --delete-archived-older-than 0` deletes everything |

---

## Performance

- **< 10ms** overhead per message
- SQLite in **WAL mode** for concurrent access
- Buffer files **auto-rotate at 10MB**
- Archive runs **once per session** (throttled)

---

## Uninstall

```bash
# Remove hooks from settings.json
# Then delete:
rm -rf ~/.claude/hooks/{db-utils,capture-user-message,detect-clear,pre-compact-backup,final-save,archive-manager}.js
rm -rf ~/.claude/bin/conv-persist*
rm -rf ~/.claude/skills/conversation-sqlite-persist
rm -rf ~/.claude/buffer
rm -rf ~/.claude/backups
# Keep or delete ~/.claude/conversations.db and conversations-archive.db
```

---

## License

MIT — Use it, fork it, ship it.
