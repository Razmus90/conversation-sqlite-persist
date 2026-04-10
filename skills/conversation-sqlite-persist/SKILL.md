---
name: conversation-sqlite-persist
description: Automatically save Claude Code conversations to SQLite with zero-miss guarantee. Query, export, and manage conversation history with archive support.
origin: Custom
---

# Conversation SQLite Persistence

## When to Activate
- User wants to keep complete conversation history across sessions
- User frequently uses `/clear` and wants to preserve previous conversations
- User works on long sessions that may hit context limits
- User needs to search or reference past conversations
- User asks about old conversations ("percakapan lama", "conversation history")
- Compliance/audit requirements for conversation logging

## What This Skill Does

### Automatic (Hook-Based)
- **Real-Time Capture**: Every user message saved to buffer + SQLite
- **Pre-Clear Backup**: `/clear` detected → full transcript backed up before clear
- **Pre-Compact Backup**: Context compaction detected → backup before data loss
- **Session-End Save**: Final backup on session close
- **Auto-Archive**: Sessions older than 90 days auto-archived to separate DB

### On-Demand (CLI Commands)

When user asks about conversation history, use the CLI:

```bash
# Status & overview
conv-persist status

# List sessions
conv-persist list                    # active sessions
conv-persist list --archived         # archived sessions

# Query conversations
conv-persist query "SELECT * FROM messages WHERE content LIKE '%keyword%'"
conv-persist query "SELECT * FROM messages WHERE content LIKE '%keyword%'" --archived

# Archive old sessions
conv-persist archive --days 90

# Restore from archive
conv-persist restore <session-id>
conv-persist restore --all

# Export
conv-persist export <session-id> --format markdown -o output.md

# Cleanup
conv-persist cleanup
conv-persist cleanup --delete-archived-older-than 365
```

## Architecture

```
~/.claude/
├── conversations.db              # Active sessions (< 90 days)
├── conversations-archive.db      # Archived sessions (> 90 days)
├── backups/                      # Event backups (clear, compact, end)
│   ├── clear-*.json
│   ├── compact-*.json
│   └── final-*.json
├── buffer/                       # Real-time message buffers
└── hooks/                        # Hook scripts
    ├── db-utils.js
    ├── capture-user-message.js
    ├── detect-clear.js
    ├── pre-compact-backup.js
    ├── final-save.js
    └── archive-manager.js        # Auto-archive on session start
```

## Archive System

### How It Works
1. Sessions end → stored in `conversations.db`
2. 90 days pass → auto-archived to `conversations-archive.db`
3. User needs old session → query archive or restore to active

### Accessing Old Conversations

**Without restore** (query archive directly):
```bash
conv-persist query "SELECT * FROM messages WHERE content LIKE '%topic%'" --archived
conv-persist list --archived --limit 50
```

**With restore** (move back to active):
```bash
conv-persist restore <session-id>
# Session now in active DB, queryable normally
```

### Custom Threshold
```bash
# Archive sessions older than 60 days
conv-persist archive --days 60

# Or set via environment variable
CONV_PERSIST_ARCHIVE_DAYS=60
```

## Database Schema

### Active DB (`conversations.db`)
```sql
sessions       -- id, project_path, started_at, ended_at, total_messages
messages       -- id, session_id, role, content, timestamp
clear_events   -- id, session_id, event_type, backup_timestamp, messages_backup_count, backup_path
```

### Archive DB (`conversations-archive.db`)
```sql
sessions       -- same schema as active
messages       -- same schema as active
archive_log    -- id, archived_at, session_id, message_count, source
```

## Query Examples

### Recent sessions
```sql
SELECT id, project_path, ended_at, total_messages
FROM sessions ORDER BY ended_at DESC LIMIT 20;
```

### Search messages
```sql
SELECT s.project_path, m.role, substr(m.content, 1, 100), m.timestamp
FROM messages m JOIN sessions s ON m.session_id = s.id
WHERE m.content LIKE '%search_term%'
ORDER BY m.timestamp DESC;
```

### Storage stats
```sql
SELECT
  (SELECT COUNT(*) FROM sessions) as total_sessions,
  (SELECT COUNT(*) FROM messages) as total_messages,
  (SELECT COUNT(*) FROM clear_events) as total_events;
```

## Privacy
- 100% local storage
- No cloud sync
- No external dependencies (except better-sqlite3)
