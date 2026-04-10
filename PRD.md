# PRD: conversation-sqlite-persist

**Purpose**: Deterministic blueprint for 1:1 rebuild of this Claude Code skill by any AI agent.
**Version**: 1.2.0
**Last Updated**: 2026-04-10

---

## 1. System Overview

`conversation-sqlite-persist` is a Claude Code custom skill that persists every conversation to a local SQLite database. It operates via two hook scripts and exposes an interactive menu through the `/conversation-sqlite-persist` slash command.

### Core Behavior

- **Auto-save**: Every time the AI finishes responding (Stop hook), parse the JSONL transcript and upsert all messages into SQLite.
- **Interactive menu**: When the user types `/conversation-sqlite-persist`, a UserPromptSubmit hook intercepts the prompt, reads `menu.json`, and injects structured context into the LLM so it renders an `AskUserQuestion` menu with 3 options.
- **Transcript-based**: All data extraction reads from Claude Code's native JSONL transcript files located at `~/.claude/projects/<project>/<session-id>.jsonl`.

---

## 2. File Tree (Target State)

```
~/.claude/
├── settings.json                          # Hook registration (see §7)
├── hooks/
│   ├── db-utils.js                        # §4 — SQLite database layer
│   ├── detect-conversation-persist.js     # §5 — UserPromptSubmit hook
│   └── auto-save.js                       # §6 — Stop hook
└── skills/
    └── conversation-sqlite-persist/
        ├── SKILL.md                       # §8 — Skill metadata
        ├── menu.json                      # §9 — Menu definition
        └── skill-actions.js               # §10 — CLI tool
```

---

## 3. Dependencies

| Package | Version | Used In |
|---------|---------|---------|
| `sqlite3` | `^5.1.0` | `db-utils.js` |

No other external dependencies. `fs`, `path`, `os` are Node.js built-ins.

---

## 4. File: `hooks/db-utils.js`

### 4.1 Imports

```js
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');
```

### 4.2 Constants

```js
const HOME = process.env.HOME || process.env.USERPROFILE;
const DB_PATH = path.join(HOME, '.claude', 'conversations.db');
```

### 4.3 Schema (executed via `db.serialize()`)

**Table `sessions`**:
```sql
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    total_messages INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Table `messages`**:
```sql
CREATE TABLE IF NOT EXISTS messages (
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

**Indexes**:
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique ON messages(session_id, message_index) WHERE message_index IS NOT NULL;
```

### 4.4 Exported Functions

#### `initDatabase() → Promise<void>`
- Opens `DB_PATH` with `new sqlite3.Database(DB_PATH)`
- Runs all `SCHEMA_SQL` statements in `db.serialize()` block
- Last statement uses callback to resolve/reject promise, then `db.close()`

#### `saveSession(session_id, project_path, total_messages=0) → Promise`
- `INSERT INTO sessions ... ON CONFLICT(id) DO UPDATE SET ended_at=CURRENT_TIMESTAMP, total_messages=MAX(total_messages, excluded.total_messages), updated_at=CURRENT_TIMESTAMP`
- Single connection, single statement, `db.close()` in callback

#### `saveMessage(message) → Promise`
- `INSERT OR IGNORE INTO messages (session_id, message_index, role, content, tool_calls, tool_results, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`
- `content`: if not string, `JSON.stringify(content || '')`
- `tool_calls`: `JSON.stringify(message.tool_calls || [])`
- `tool_results`: `JSON.stringify(message.tool_results || [])`
- `timestamp`: `message.timestamp || new Date().toISOString()`

#### `parseJsonlTranscript(transcript_path) → {messages: Array}|null`
- Reads file at `transcript_path`
- Splits by `\n`, filters empty lines
- Parses each line as JSON
- Only includes entries where `entry.type === 'user' OR 'assistant'`
- Extracts: `role` (from `msg.role || entry.type`), `content` (string or `JSON.stringify`), `tool_calls`, `tool_results`, `timestamp`
- Tracks `skipped` count for malformed lines, logs to `stderr` if > 0
- Returns `null` if no valid messages

#### `findTranscriptPath(session_id) → string|null`
- Scans `~/.claude/projects/` directory
- For each project subdirectory, checks if `<project>/<session_id>.jsonl` exists
- Returns first match, or `null`

#### `readTranscript(session_id, transcript_path) → {messages: Array}|null`
- If `transcript_path` provided, try `parseJsonlTranscript(transcript_path)` first
- Fallback to `findTranscriptPath(session_id)` then parse
- Returns `null` if neither yields results

#### `saveFullConversation(conversation_id, project_path, transcript_path) → Promise<{success: boolean, saved: number, error?: string}>`
- Calls `readTranscript(conversation_id, transcript_path)`
- If no messages, returns `{ success: false, saved: 0 }`
- Opens single `sqlite3.Database` connection
- Runs inside `db.serialize()`:
  1. `BEGIN TRANSACTION`
  2. Re-runs all `SCHEMA_SQL` (idempotent `CREATE IF NOT EXISTS`)
  3. Upserts session row
  4. `db.prepare()` batch inserts all messages with `INSERT OR IGNORE`
  5. `stmt.finalize()`
  6. `COMMIT` — on success: `{ success: true, saved: count }`, on error: `{ success: false, saved: 0, error: err.message }`

#### `getSessionMessages(session_id) → Promise<Array<{role, content, timestamp}>>`
- `SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY message_index ASC`
- Returns `rows || []`

#### `validateSession(session_id) → Promise<boolean>`
- `SELECT id, total_messages FROM sessions WHERE id = ?`
- Returns `!!row`

#### `module.exports`
```js
{
    DB_PATH,
    initDatabase,
    saveSession,
    saveMessage,
    parseJsonlTranscript,
    findTranscriptPath,
    readTranscript,
    saveFullConversation,
    getSessionMessages,
    validateSession
}
```

---

## 5. File: `hooks/detect-conversation-persist.js`

### Purpose
UserPromptSubmit hook. Detects the `/conversation-sqlite-persist` command, reads `menu.json`, and outputs structured `hookSpecificOutput` that injects context into the LLM.

### Execution Flow

1. Read stdin entirely: `fs.readFileSync(0, 'utf-8')`
2. Parse as JSON → `input`. If parse fails → `process.exit(0)` (silent pass-through)
3. Extract `userPrompt` from `input.prompt || ''`
4. If `<command-name>...</command-name>` XML wrapper present, extract inner text via regex: `/<command-name>(.*?)<\/command-name>/`
5. Match against `/^\/conversation-sqlite-persist$/i`. If no match → `process.exit(0)`
6. Read `~/.claude/skills/conversation-sqlite-persist/menu.json` → parse JSON. If file missing/invalid → `process.exit(0)`
7. Extract `sessionId = input.session_id || 'unknown'`
8. Build context string array:
   - `## {menu.title}`
   - Empty line
   - `Show this menu using AskUserQuestion:`
   - Empty line
   - For each option: `{i+1}. **{opt.label}** — {opt.description}`
   - Empty line
   - `After user selects, execute the matching action.`
   - Empty line
   - For each option with `action !== 'none'`:
     - If `opt.steps` exists: `**{opt.label}**: Execute these steps in order:` then numbered steps with `{session_id}` interpolated
     - If `opt.command` exists: `**{opt.label}**: Run \`{command with session_id interpolated}\``
   - If `menu.summaryFormat` exists: append with `{session_id}` interpolated
9. Output to stdout:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<joined lines>"
  }
}
```

### Key Constants
- `SKILL_DIR = path.join(HOME, '.claude', 'skills', 'conversation-sqlite-persist')`
- `MENU_PATH = path.join(SKILL_DIR, 'menu.json')`

---

## 6. File: `hooks/auto-save.js`

### Purpose
Stop hook. Runs every time the AI finishes generating a response. Parses the session transcript and saves to SQLite.

### Execution Flow

1. Read stdin entirely: `fs.readFileSync(0, 'utf-8')`
2. Parse as JSON → `input`. If parse fails → `process.exit(0)`
3. Extract: `session_id = input.session_id`, `transcript_path = input.transcript_path`, `project_path = input.cwd || process.cwd()`
4. If `!session_id || !transcript_path` → `process.exit(0)`
5. Call `db.saveFullConversation(session_id, project_path, transcript_path)`
6. On success: `console.error('[Auto-Save] {count} messages saved for {session_id}')`
7. On failure: `console.error('[Auto-Save] Failed for {session_id}: {error}')`
8. Always `process.exit(0)` (never block the session)

### Imports
```js
const fs = require('fs');
const db = require('./db-utils.js');
```

---

## 7. Hook Registration in `~/.claude/settings.json`

The `hooks` key in `settings.json` must contain:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/wahyu/.claude/hooks/detect-conversation-persist.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node C:/Users/wahyu/.claude/hooks/auto-save.js"
          }
        ]
      }
    ]
  }
}
```

**IMPORTANT**: `matcher` must be empty string `""` to match all prompts/events. `type` must be `"command"`. Path must use forward slashes or OS-appropriate separators.

---

## 8. File: `skills/conversation-sqlite-persist/SKILL.md`

Exact content (frontmatter only, 3 fields):

```markdown
---
name: conversation-sqlite-persist
description: Menu untuk save/load/summarize conversation dari SQLite database.
origin: Custom
---
```

No body content. Only frontmatter metadata. The `description` field is in Indonesian: "Menu untuk save/load/summarize conversation dari SQLite database."

---

## 9. File: `skills/conversation-sqlite-persist/menu.json`

### Schema

```jsonc
{
    "title": "conversation sqlite persist",           // string — displayed in menu header
    "options": [                                       // array — 3 options exactly
        {
            "label": "generate/update",                // string — displayed label
            "description": "...",                       // string — Indonesian description
            "action": "save",                           // string — action type identifier
            "command": "node ~/.claude/skills/..."      // string — single shell command with {session_id} placeholder
        },
        {
            "label": "load",
            "description": "...",
            "action": "read",
            "steps": [                                  // array of strings — sequential commands/steps
                "node ~/.claude/skills/... save --session-id {session_id}",
                "node ~/.claude/skills/... read --session-id {session_id}",
                "node ~/.claude/skills/... clear",
                "Generate hybrid summary from the returned messages (see format below)",
                "Display the generated summary to the user"
            ]
        },
        {
            "label": "cancel",
            "description": "Tidak melakukan apa-apa",
            "action": "none"                            // no command or steps — exit
        }
    ],
    "summaryFormat": "..."                              // string — markdown template for load summary
}
```

### Exact Values

**Option 1 — generate/update**:
- `label`: `"generate/update"`
- `description`: `"Simpan/update conversation session ini ke SQLite"`
- `action`: `"save"`
- `command`: `"node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js save --session-id {session_id}"`

**Option 2 — load**:
- `label`: `"load"`
- `description`: `"Simpan ke DB, baca messages, buat summary, clear screen, tampilkan summary"`
- `action`: `"read"`
- `steps`: array of 5 strings:
  1. `"node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js save --session-id {session_id}"`
  2. `"node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js read --session-id {session_id}"`
  3. `"node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js clear"`
  4. `"Generate hybrid summary from the returned messages (see format below)"`
  5. `"Display the generated summary to the user"`

**Option 3 — cancel**:
- `label`: `"cancel"`
- `description`: `"Tidak melakukan apa-apa"`
- `action`: `"none"`

**summaryFormat**: Full markdown string containing:
- Header `## Summary Format (Hybrid)`
- Blank line
- `Generate summary in this format:`
- Code block with template:
  ```
  # Session Resume — {session_id}

  ## Konteks
  - **Topik aktif**: [apa yang sedang dibahas]
  - **Status**: [IN PROGRESS / BLOCKED / COMPLETED]
  - **Keputusan kritis**: [keputusan yang sudah dibuat]
  - **Files dimodifikasi**: [file yang diubah/dibuat]

  ## Langkah Selanjutnya
  - [ ] [task yang belum selesai atau next step]

  ## Timeline Detail
  | Waktu | Event | Keterangan |
  |-------|-------|------------|
  | HH:MM | [tipe] | [deskripsi] |
  ```
- Rules section:
  - Focus pada informasi yang AI butuhkan untuk MELANJUTKAN percakapan
  - Jangan summarize hal obvious — highlight decisions, blockers, open questions
  - Timeline hanya event kritis, bukan setiap message

---

## 10. File: `skills/conversation-sqlite-persist/skill-actions.js`

### Purpose
CLI tool invoked by the menu. Has 3 commands: `save`, `read`, `clear`.

### Imports
```js
const path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const db = require(path.join(HOME, '.claude', 'hooks', 'db-utils.js'));
```

### CLI Interface
```
node skill-actions.js <save|read|clear> --session-id <id>
```

### Argument Parsing
- `command = args[0]`
- Scan for `--session-id` flag, take next arg as value

### `cmdSave(sessionId)`
1. If no sessionId → `{ status: 'error', message: 'Missing --session-id' }` + exit 1
2. `db.findTranscriptPath(sessionId)` — if null → `{ status: 'no_transcript', ... }` + return
3. `db.saveFullConversation(sessionId, '', transcriptPath)`
4. On success → `{ status: 'success', session_id, messages_saved: result.saved, transcript_path }`
5. On failure → `{ status: 'error', session_id, error: result.error || 'No messages found' }`

### `cmdRead(sessionId)`
1. If no sessionId → error + exit 1
2. `await db.initDatabase()`
3. `db.validateSession(sessionId)` — if false → `{ status: 'no_session', ... 'Session not found in DB. Run save first.' }` + return
4. `db.getSessionMessages(sessionId)` — if empty → `{ status: 'no_messages', session_id }`
5. Post-process each message:
   - Try `JSON.parse(content)` — if array, filter `type === 'text'` blocks, join `content || text` fields
   - If parse fails, use content as-is (plain text)
   - Truncate to 2000 chars: `content.substring(0, 2000)`
6. Output: `{ status: 'success', session_id, message_count, messages: [{role, content, timestamp}] }`

### `cmdClear()`
1. `process.stdout.write('\x1b[2J\x1b[H')` — ANSI escape to clear terminal
2. Output: `{ status: 'cleared' }`

### Error Handling
- `main()` catches errors → `{ status: 'fatal_error', error: err.message }` + exit 1
- All output is JSON to stdout
- All errors go to `stderr` via `console.error`

---

## 11. Installer: `bin/install.js`

### Purpose
Run via `npx conversation-sqlite-persist@latest`. Copies files to `~/.claude/` and registers hooks.

### Steps (sequential)

**Step 1**: Create directories:
- `~/.claude/` (if not exists)
- `~/.claude/hooks/`
- `~/.claude/logs/`
- `~/.claude/skills/conversation-sqlite-persist/`

**Step 2**: Copy hook files (from `../hooks/` relative to `bin/`):
- `db-utils.js` → `~/.claude/hooks/db-utils.js`
- `detect-conversation-persist.js` → `~/.claude/hooks/detect-conversation-persist.js`
- `auto-save.js` → `~/.claude/hooks/auto-save.js`

**Step 3**: Copy skill files (from `../skills/conversation-sqlite-persist/`):
- `SKILL.md` → `~/.claude/skills/conversation-sqlite-persist/SKILL.md`
- `menu.json` → `~/.claude/skills/conversation-sqlite-persist/menu.json`
- `skill-actions.js` → `~/.claude/skills/conversation-sqlite-persist/skill-actions.js`

**Step 4**: Merge hook config into `~/.claude/settings.json`:
- Read existing `settings.json` (or create empty object)
- Initialize `settings.hooks = {}` if missing
- For `UserPromptSubmit`: add entry with `id: 'conv-persist-detect'`, `command: 'node {HOOKS_DIR}/detect-conversation-persist.js'`
- For `Stop`: add entry with `id: 'conv-persist-auto-save'`, `command: 'node {HOOKS_DIR}/auto-save.js'`
- If entry with same `id` exists, update `command` path only (idempotent merge)
- Write back `settings.json` with 2-space indent

**Step 5**: Initialize database:
- Require `db-utils.js`, call `initDatabase()` (async, non-blocking)

### Hook Config Format (installer writes this)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "node ~/.claude/hooks/detect-conversation-persist.js",
        "description": "Detect /conversation-sqlite-persist and inject menu context",
        "id": "conv-persist-detect"
      }
    ],
    "Stop": [
      {
        "command": "node ~/.claude/hooks/auto-save.js",
        "description": "Auto-save conversation to SQLite on AI response complete",
        "id": "conv-persist-auto-save"
      }
    ]
  }
}
```

**NOTE**: The installer writes a flat format. Claude Code may internally restructure this into `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` format. Both are valid.

---

## 12. CLI: `bin/cli.js`

### Purpose
Standalone CLI for querying the database outside of Claude Code.

### Commands

| Command | Args | Action |
|---------|------|--------|
| `status` | none | Query session/message counts, DB file size, date range |
| `list` | `--limit N` | List sessions ordered by `ended_at DESC` |
| `query` | `"SQL"` | Execute arbitrary `SELECT` query |
| `save` | `<session-id>` | Save session from JSONL transcript |
| `read` | `<session-id>` | Read messages from DB |
| `cleanup` | none | Run `VACUUM` on database |
| `help` | none | Print usage |

### Implementation Notes
- All commands use `sqlite3` driver directly (not db-utils wrappers for async queries)
- Status/list/query use callback-based `db.get()`/`db.all()` with manual `db.close()`
- Save/read use db-utils functions (`findTranscriptPath`, `saveFullConversation`, `getSessionMessages`)
- Table formatting: auto-width columns, pipe-separated

---

## 13. Package Metadata

### `package.json`
```json
{
  "name": "conversation-sqlite-persist",
  "version": "1.2.0",
  "description": "Menu untuk save/load/summarize conversation dari SQLite database. Auto-saves via hooks with transcript parsing.",
  "main": "bin/install.js",
  "bin": {
    "conversation-sqlite-persist": "bin/install.js",
    "conv-persist": "bin/cli.js"
  },
  "scripts": {
    "install-skill": "node bin/install.js",
    "postinstall": "node bin/install.js"
  },
  "dependencies": {
    "sqlite3": "^5.1.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

### `.claude-plugin/plugin.json`
```json
{
  "name": "conversation-sqlite-persist",
  "version": "1.2.0",
  "description": "Menu untuk save/load/summarize conversation dari SQLite database.",
  "type": "skill",
  "entrypoint": "skills/conversation-sqlite-persist/SKILL.md",
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "node hooks/detect-conversation-persist.js",
        "description": "Detect /conversation-sqlite-persist and inject menu context"
      }
    ],
    "Stop": [
      {
        "command": "node hooks/auto-save.js",
        "description": "Auto-save conversation to SQLite on AI response complete"
      }
    ]
  },
  "dependencies": {
    "sqlite3": "^5.1.0"
  }
}
```

---

## 14. Deterministic Build Sequence

An AI agent rebuilding this project MUST follow this exact sequence:

```
1. CREATE project root directory
2. CREATE subdirectories: hooks/, bin/, skills/conversation-sqlite-persist/, .claude-plugin/
3. WRITE hooks/db-utils.js          — §4 exact schema + functions + exports
4. WRITE hooks/detect-conversation-persist.js — §5 exact flow
5. WRITE hooks/auto-save.js         — §6 exact flow
6. WRITE skills/conversation-sqlite-persist/SKILL.md — §8 exact frontmatter
7. WRITE skills/conversation-sqlite-persist/menu.json — §9 exact values
8. WRITE skills/conversation-sqlite-persist/skill-actions.js — §10 exact commands
9. WRITE bin/install.js             — §11 exact steps + hook config format
10. WRITE bin/cli.js                — §12 exact commands
11. WRITE package.json              — §13 exact values
12. WRITE .claude-plugin/plugin.json — §13 exact values
13. WRITE .gitignore                — exclude node_modules, *.db, *.db-wal, *.db-shm, *.jsonl, logs/, .DS_Store
14. WRITE README.md                 — project documentation
15. npm install                     — install sqlite3 dependency
```

---

## 15. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ USER: types /conversation-sqlite-persist                    │
│                                                             │
│   Claude Code ──► UserPromptSubmit hook fires               │
│                      │                                      │
│                      ▼                                      │
│                  detect-conversation-persist.js              │
│                      │                                      │
│                      ├─ Read menu.json                       │
│                      ├─ Interpolate {session_id}             │
│                      └─ Output hookSpecificOutput             │
│                              │                              │
│                              ▼                              │
│                  Claude Code injects context into LLM       │
│                              │                              │
│                              ▼                              │
│                  LLM renders AskUserQuestion menu           │
│                              │                              │
│                  ┌───────────┼───────────┐                  │
│                  ▼           ▼           ▼                  │
│            generate/update  load      cancel                │
│                  │           │           │                  │
│                  ▼           ▼           ▼                  │
│           Run save cmd   Run 5-step    Exit                 │
│                  │        pipeline                         │
│                  ▼           │                              │
│           save ──────────────┤                              │
│                  │           ▼                              │
│                  │      read ─► clear ─► summary            │
│                  │                                          │
│                  ▼                                          │
│             db-utils.js                                     │
│                  │                                          │
│                  ├─ findTranscriptPath()                    │
│                  ├─ parseJsonlTranscript()                  │
│                  └─ saveFullConversation()                  │
│                          │                                  │
│                          ▼                                  │
│                    conversations.db                          │
│                          │                                  │
│                    sessions + messages tables                │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ AI: finishes response (Stop event)                          │
│                                                             │
│   Claude Code ──► Stop hook fires                           │
│                      │                                      │
│                      ▼                                      │
│                  auto-save.js                               │
│                      │                                      │
│                      ├─ Read input: session_id,             │
│                      │   transcript_path, cwd               │
│                      ├─ Call saveFullConversation()          │
│                      │   ├─ parseJsonlTranscript()          │
│                      │   ├─ BEGIN TRANSACTION               │
│                      │   ├─ Upsert session                  │
│                      │   ├─ Batch INSERT OR IGNORE messages │
│                      │   └─ COMMIT                          │
│                      └─ Log result to stderr                │
│                                                             │
│   (Never blocks session — always exits 0)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 16. Critical Invariants

These MUST hold true for the system to function:

1. **db-utils.js uses `sqlite3`**, NOT `better-sqlite3`. All database operations are callback-based.
2. **Deduplication** is via `INSERT OR IGNORE` on `messages` table with unique index on `(session_id, message_index)`.
3. **Transcript parsing** only includes entries where `entry.type === 'user'` or `entry.type === 'assistant'`.
4. **Hook stdin** is always JSON. If parse fails, hook MUST exit silently with code 0.
5. **auto-save.js NEVER blocks** the session — always calls `process.exit(0)`.
6. **detect-conversation-persist.js** outputs to stdout as JSON with `hookSpecificOutput.additionalContext`.
7. **menu.json** uses `{session_id}` placeholder that gets interpolated at runtime.
8. **skill-actions.js** outputs ALL responses as JSON to stdout (never plain text).
9. **`clear` command** uses ANSI escape `\x1b[2J\x1b[H` to clear the terminal.
10. **`cmdRead`** truncates each message content to 2000 characters before returning.
11. **Schema DDL** is idempotent — all `CREATE TABLE/INDEX IF NOT EXISTS`.
12. **`saveFullConversation`** wraps everything in a single transaction (`BEGIN` → batch insert → `COMMIT`).

---

## 17. Testing Checklist

After rebuild, verify:

- [ ] `npm install` succeeds (sqlite3 compiles)
- [ ] `node bin/install.js` creates all directories and files under `~/.claude/`
- [ ] `~/.claude/settings.json` contains both hooks in correct format
- [ ] `node ~/.claude/hooks/detect-conversation-persist.js` with stdin `{"prompt":"/conversation-sqlite-persist","session_id":"test-123"}` outputs valid JSON with `hookSpecificOutput`
- [ ] `node ~/.claude/hooks/auto-save.js` with stdin `{"session_id":"test-123","transcript_path":"/nonexistent","cwd":"/tmp"}` exits 0 without error
- [ ] `node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js save --session-id <valid-id>` returns `{status:"success"}` or `{status:"no_transcript"}`
- [ ] `node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js read --session-id <valid-id>` returns `{status:"success"}` or `{status:"no_session"}`
- [ ] `node ~/.claude/skills/conversation-sqlite-persist/skill-actions.js clear` outputs ANSI clear
- [ ] `node bin/cli.js status` shows database statistics
- [ ] `node bin/cli.js help` shows usage text
- [ ] `/conversation-sqlite-persist` in Claude Code renders AskUserQuestion menu with 3 options
- [ ] Selecting "generate/update" saves current session to DB
- [ ] Selecting "load" runs save→read→clear→summary workflow
- [ ] Auto-save fires on every Stop event (check `~/.claude/conversations.db` grows)
