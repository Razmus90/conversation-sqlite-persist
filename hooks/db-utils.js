#!/usr/bin/env node
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const DB_PATH = path.join(HOME, '.claude', 'conversations.db');

const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT,
        started_at TIMESTAMP,
        ended_at TIMESTAMP,
        total_messages INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
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
    )`,
    'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(ended_at)',
    'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unique ON messages(session_id, message_index) WHERE message_index IS NOT NULL'
];

// Initialize database — waits for DDL to complete before resolving
function initDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.serialize(() => {
            for (let i = 0; i < SCHEMA_SQL.length; i++) {
                if (i === SCHEMA_SQL.length - 1) {
                    db.run(SCHEMA_SQL[i], (err) => {
                        db.close();
                        if (err) reject(err);
                        else resolve();
                    });
                } else {
                    db.run(SCHEMA_SQL[i]);
                }
            }
        });
    });
}

// Save session to database
function saveSession(session_id, project_path, total_messages = 0) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(
            `INSERT INTO sessions (id, project_path, started_at, ended_at, total_messages)
             VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(id) DO UPDATE SET
               ended_at = CURRENT_TIMESTAMP,
               total_messages = MAX(total_messages, excluded.total_messages),
               updated_at = CURRENT_TIMESTAMP`,
            [session_id, project_path, total_messages],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

// Save message to database — INSERT OR IGNORE prevents duplicates
function saveMessage(message) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(
            `INSERT OR IGNORE INTO messages
             (session_id, message_index, role, content, tool_calls, tool_results, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                message.session_id,
                message.message_index,
                message.role,
                typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
                JSON.stringify(message.tool_calls || []),
                JSON.stringify(message.tool_results || []),
                message.timestamp || new Date().toISOString()
            ],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

// Parse a JSONL transcript file from Claude Code's projects directory
function parseJsonlTranscript(transcript_path) {
    if (!transcript_path || !fs.existsSync(transcript_path)) return null;
    try {
        const content = fs.readFileSync(transcript_path, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const messages = [];
        let skipped = 0;
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'user' || entry.type === 'assistant') {
                    const msg = entry.message || {};
                    messages.push({
                        role: msg.role || entry.type,
                        content: typeof msg.content === 'string'
                            ? msg.content
                            : JSON.stringify(msg.content || ''),
                        tool_calls: msg.tool_calls || [],
                        tool_results: msg.tool_results || [],
                        timestamp: entry.timestamp || new Date().toISOString()
                    });
                }
            } catch (e) {
                skipped++;
            }
        }
        if (skipped > 0) {
            console.error(`[DB Utils] Skipped ${skipped} malformed lines in ${transcript_path}`);
        }
        return messages.length > 0 ? { messages } : null;
    } catch (err) {
        return null;
    }
}

// Find transcript path in Claude Code's projects directory by session_id
function findTranscriptPath(session_id) {
    const projectsDir = path.join(HOME, '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return null;
    try {
        const projects = fs.readdirSync(projectsDir);
        for (const proj of projects) {
            const candidate = path.join(projectsDir, proj, `${session_id}.jsonl`);
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// Read transcript — accepts explicit path, falls back to projects search
function readTranscript(session_id, transcript_path) {
    if (transcript_path) {
        const parsed = parseJsonlTranscript(transcript_path);
        if (parsed) return parsed;
    }
    const found = findTranscriptPath(session_id);
    if (found) return parseJsonlTranscript(found);
    return null;
}

// Save full conversation — single connection, transaction, batch insert
function saveFullConversation(conversation_id, project_path, transcript_path) {
    const transcript = readTranscript(conversation_id, transcript_path);
    if (!transcript || !transcript.messages || transcript.messages.length === 0) {
        return Promise.resolve({ success: false, saved: 0 });
    }

    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_PATH);

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            // Schema
            for (const sql of SCHEMA_SQL) {
                db.run(sql);
            }

            // Upsert session
            db.run(
                `INSERT INTO sessions (id, project_path, started_at, ended_at, total_messages)
                 VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   ended_at = CURRENT_TIMESTAMP,
                   total_messages = MAX(total_messages, excluded.total_messages),
                   updated_at = CURRENT_TIMESTAMP`,
                [conversation_id, project_path, transcript.messages.length]
            );

            // Batch insert messages
            const stmt = db.prepare(
                `INSERT OR IGNORE INTO messages
                 (session_id, message_index, role, content, tool_calls, tool_results, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            );
            for (let i = 0; i < transcript.messages.length; i++) {
                const msg = transcript.messages[i];
                stmt.run([
                    conversation_id, i,
                    msg.role || 'unknown',
                    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
                    JSON.stringify(msg.tool_calls || []),
                    JSON.stringify(msg.tool_results || []),
                    msg.timestamp || new Date().toISOString()
                ]);
            }
            stmt.finalize();

            // Commit
            db.run('COMMIT', (err) => {
                db.close();
                if (err) {
                    resolve({ success: false, saved: 0, error: err.message });
                } else {
                    resolve({ success: true, saved: transcript.messages.length });
                }
            });
        });
    });
}

// Get messages for a specific session
function getSessionMessages(session_id) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(
            'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY message_index ASC',
            [session_id],
            (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

// Check if session exists in DB
function validateSession(session_id) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(
            'SELECT id, total_messages FROM sessions WHERE id = ?',
            [session_id],
            (err, row) => {
                db.close();
                if (err) reject(err);
                else resolve(!!row);
            }
        );
    });
}

module.exports = {
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
};
