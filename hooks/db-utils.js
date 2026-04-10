/**
 * db-utils.js
 * SQLite database utilities for conversation persistence.
 * Shared by all hook scripts.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DB_PATH = path.join(CLAUDE_DIR, 'conversations.db');
const ARCHIVE_DB_PATH = path.join(CLAUDE_DIR, 'conversations-archive.db');
const BUFFER_DIR = path.join(CLAUDE_DIR, 'buffer');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });

  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      total_messages INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS clear_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      backup_timestamp TEXT DEFAULT (datetime('now')),
      messages_backup_count INTEGER DEFAULT 0,
      backup_path TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
  `);

  db.close();
}

function createSession(sessionId, projectPath) {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO sessions (id, project_path) VALUES (?, ?)'
  );
  stmt.run(sessionId, projectPath);
  db.close();
}

function insertMessage(sessionId, role, content) {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)'
  );
  const result = stmt.run(sessionId, role, content);

  db.prepare(
    'UPDATE sessions SET total_messages = total_messages + 1 WHERE id = ?'
  ).run(sessionId);

  db.close();
  return result;
}

function insertClearEvent(sessionId, eventType, messageCount, backupPath) {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO clear_events (session_id, event_type, messages_backup_count, backup_path) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(sessionId, eventType, messageCount, backupPath);
  db.close();
  return result;
}

function getSessionMessages(sessionId) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC'
  ).all(sessionId);
  db.close();
  return rows;
}

function endSession(sessionId) {
  const db = getDb();
  db.prepare(
    'UPDATE sessions SET ended_at = datetime(\'now\') WHERE id = ?'
  ).run(sessionId);
  db.close();
}

function getBufferPath(sessionId) {
  return path.join(BUFFER_DIR, `${sessionId}.jsonl`);
}

function appendToBuffer(sessionId, role, content) {
  const bufferPath = getBufferPath(sessionId);
  const entry = JSON.stringify({
    role,
    content,
    timestamp: new Date().toISOString()
  }) + '\n';
  fs.appendFileSync(bufferPath, entry, 'utf8');
}

function readBuffer(sessionId) {
  const bufferPath = getBufferPath(sessionId);
  if (!fs.existsSync(bufferPath)) return [];
  const lines = fs.readFileSync(bufferPath, 'utf8').trim().split('\n');
  return lines.filter(Boolean).map(l => JSON.parse(l));
}

function clearBuffer(sessionId) {
  const bufferPath = getBufferPath(sessionId);
  if (fs.existsSync(bufferPath)) fs.unlinkSync(bufferPath);
}

// ==========================================
// Archive Database Functions
// ==========================================

function getArchiveDb() {
  const db = new Database(ARCHIVE_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function initArchiveDb() {
  const db = getArchiveDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT,
      started_at TEXT,
      ended_at TEXT,
      total_messages INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS archive_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      archived_at TEXT DEFAULT (datetime('now')),
      session_id TEXT,
      message_count INTEGER DEFAULT 0,
      source TEXT DEFAULT 'auto'
    );

    CREATE INDEX IF NOT EXISTS idx_archive_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_archive_messages_timestamp ON messages(timestamp);
  `);
  db.close();
}

function archiveOldSessions(daysThreshold = 90, source = 'auto') {
  initArchiveDb();

  const activeDb = getDb();
  const archiveDb = getArchiveDb();

  const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();

  // Find old sessions
  const oldSessions = activeDb.prepare(
    'SELECT * FROM sessions WHERE ended_at < ? AND ended_at IS NOT NULL'
  ).all(cutoff);

  if (oldSessions.length === 0) {
    activeDb.close();
    archiveDb.close();
    return { archived: 0, sessions: [] };
  }

  const archivedIds = [];

  const archiveTx = archiveDb.transaction(() => {
    for (const session of oldSessions) {
      // Copy session to archive
      archiveDb.prepare(
        'INSERT OR REPLACE INTO sessions (id, project_path, started_at, ended_at, total_messages) VALUES (?, ?, ?, ?, ?)'
      ).run(session.id, session.project_path, session.started_at, session.ended_at, session.total_messages);

      // Copy messages to archive
      const messages = activeDb.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC'
      ).all(session.id);

      for (const msg of messages) {
        archiveDb.prepare(
          'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
        ).run(msg.session_id, msg.role, msg.content, msg.timestamp);
      }

      // Log archive event
      archiveDb.prepare(
        'INSERT INTO archive_log (session_id, message_count, source) VALUES (?, ?, ?)'
      ).run(session.id, messages.length, source);

      archivedIds.push(session.id);
    }
  });

  archiveTx();

  // Delete from active DB (messages first due to FK)
  const deleteTx = activeDb.transaction(() => {
    for (const sessionId of archivedIds) {
      activeDb.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      activeDb.prepare('DELETE FROM clear_events WHERE session_id = ?').run(sessionId);
      activeDb.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    }
  });

  deleteTx();

  activeDb.close();
  archiveDb.close();

  return { archived: archivedIds.length, sessions: archivedIds };
}

function restoreSession(sessionId) {
  if (!fs.existsSync(ARCHIVE_DB_PATH)) return false;

  const activeDb = getDb();
  const archiveDb = getArchiveDb();

  // Check if session exists in archive
  const session = archiveDb.prepare(
    'SELECT * FROM sessions WHERE id = ?'
  ).get(sessionId);

  if (!session) {
    activeDb.close();
    archiveDb.close();
    return false;
  }

  const restoreTx = activeDb.transaction(() => {
    // Restore session
    activeDb.prepare(
      'INSERT OR REPLACE INTO sessions (id, project_path, started_at, ended_at, total_messages) VALUES (?, ?, ?, ?, ?)'
    ).run(session.id, session.project_path, session.started_at, session.ended_at, session.total_messages);

    // Restore messages
    const messages = archiveDb.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId);

    for (const msg of messages) {
      activeDb.prepare(
        'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
      ).run(msg.session_id, msg.role, msg.content, msg.timestamp);
    }
  });

  restoreTx();

  // Remove from archive
  archiveDb.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  archiveDb.prepare('DELETE FROM archive_log WHERE session_id = ?').run(sessionId);
  archiveDb.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

  activeDb.close();
  archiveDb.close();

  return true;
}

function restoreAllSessions() {
  if (!fs.existsSync(ARCHIVE_DB_PATH)) return { restored: 0 };

  const archiveDb = getArchiveDb();
  const sessions = archiveDb.prepare('SELECT id FROM sessions').all();
  archiveDb.close();

  let restored = 0;
  for (const s of sessions) {
    if (restoreSession(s.id)) restored++;
  }

  return { restored };
}

function queryArchive(sql, params = []) {
  if (!fs.existsSync(ARCHIVE_DB_PATH)) return [];
  const db = getArchiveDb();
  try {
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows;
  } catch (err) {
    db.close();
    throw err;
  }
}

function getArchiveStats() {
  if (!fs.existsSync(ARCHIVE_DB_PATH)) {
    return { sessions: 0, messages: 0, archived_events: 0 };
  }
  const db = getArchiveDb();
  const stats = {
    sessions: db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
    messages: db.prepare('SELECT COUNT(*) as count FROM messages').get().count,
    archived_events: db.prepare('SELECT COUNT(*) as count FROM archive_log').get().count
  };
  db.close();
  return stats;
}

function listArchivedSessions(limit = 50, offset = 0) {
  if (!fs.existsSync(ARCHIVE_DB_PATH)) return [];
  const db = getArchiveDb();
  const rows = db.prepare(
    'SELECT id, project_path, started_at, ended_at, total_messages FROM sessions ORDER BY ended_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  db.close();
  return rows;
}

function deleteArchivedSessionsOlderThan(days) {
  if (!fs.existsSync(ARCHIVE_DB_PATH)) return { deleted: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = getArchiveDb();

  const oldSessions = db.prepare(
    'SELECT id FROM sessions WHERE ended_at < ?'
  ).all(cutoff);

  if (oldSessions.length === 0) {
    db.close();
    return { deleted: 0 };
  }

  const deleteTx = db.transaction(() => {
    for (const s of oldSessions) {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM archive_log WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    }
  });

  deleteTx();
  db.close();

  return { deleted: oldSessions.length };
}

module.exports = {
  DB_PATH,
  ARCHIVE_DB_PATH,
  BUFFER_DIR,
  getDb,
  initDb,
  createSession,
  insertMessage,
  insertClearEvent,
  getSessionMessages,
  endSession,
  getBufferPath,
  appendToBuffer,
  readBuffer,
  clearBuffer,
  // Archive functions
  getArchiveDb,
  initArchiveDb,
  archiveOldSessions,
  restoreSession,
  restoreAllSessions,
  queryArchive,
  getArchiveStats,
  listArchivedSessions,
  deleteArchivedSessionsOlderThan
};
