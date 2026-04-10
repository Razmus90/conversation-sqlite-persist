#!/usr/bin/env node
/**
 * final-save.js
 * Hook: sessionEnd
 * Final save on session end + cleanup buffer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  initDb,
  getSessionMessages,
  insertClearEvent,
  endSession,
  readBuffer,
  clearBuffer
} = require('./db-utils');

const BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups');

function getSessionId() {
  return process.env.CLAUDE_SESSION_ID
    || process.env.SESSION_ID
    || `session-${Date.now()}`;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const sessionId = getSessionId();

  try {
    initDb();
    ensureBackupDir();

    const messages = getSessionMessages(sessionId);
    const bufferMessages = readBuffer(sessionId);

    const allMessages = [...messages, ...bufferMessages.filter(bm =>
      !messages.some(m => m.content === bm.content && m.timestamp === bm.timestamp)
    )];

    // Always create final backup (even if empty, for audit trail)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `final-${sessionId.slice(0, 8)}-${timestamp}.json`);

    fs.writeFileSync(backupPath, JSON.stringify({
      session_id: sessionId,
      event: 'session_end',
      backed_up_at: new Date().toISOString(),
      message_count: allMessages.length,
      messages: allMessages
    }, null, 2), 'utf8');

    insertClearEvent(sessionId, 'session_end', allMessages.length, backupPath);

    // Mark session as ended
    endSession(sessionId);

    // Cleanup buffer
    clearBuffer(sessionId);

    process.stderr.write(`[conv-persist] Session ended. Final backup: ${allMessages.length} messages saved to ${backupPath}\n`);
  } catch (err) {
    process.stderr.write(`[conv-persist] Final save error: ${err.message}\n`);
  }
}

main();
