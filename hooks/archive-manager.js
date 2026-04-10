#!/usr/bin/env node
/**
 * archive-manager.js
 * Hook: SessionStart (or beforeSubmitPrompt with throttling)
 * Auto-archives sessions older than 90 days when a new session starts.
 * Runs once per session (checks if already ran in current session).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  initDb,
  archiveOldSessions,
  getArchiveStats,
  ARCHIVE_DB_PATH
} = require('./db-utils');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const LOCK_FILE = path.join(CLAUDE_DIR, '.archive-lock');

const ARCHIVE_DAYS = parseInt(process.env.CONV_PERSIST_ARCHIVE_DAYS || '90', 10);

function getSessionId() {
  return process.env.CLAUDE_SESSION_ID
    || process.env.SESSION_ID
    || `session-${Date.now()}`;
}

function isAlreadyRan() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  return lockData.date === today && lockData.session_id === getSessionId();
}

function setLock() {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    session_id: getSessionId(),
    date: new Date().toISOString().slice(0, 10),
    ran_at: new Date().toISOString()
  }), 'utf8');
}

async function main() {
  // Only run once per session
  if (isAlreadyRan()) {
    process.exit(0);
  }

  try {
    initDb();

    // Auto-archive old sessions
    const result = archiveOldSessions(ARCHIVE_DAYS, 'auto');

    if (result.archived > 0) {
      const stats = getArchiveStats();
      process.stderr.write(
        `[conv-persist] Auto-archived ${result.archived} session(s) (> ${ARCHIVE_DAYS} days). ` +
        `Archive DB: ${stats.sessions} sessions, ${stats.messages} messages\n`
      );
    }

    setLock();
  } catch (err) {
    process.stderr.write(`[conv-persist] Archive manager error: ${err.message}\n`);
  }
}

main();
