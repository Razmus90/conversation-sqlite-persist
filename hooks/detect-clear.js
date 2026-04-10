#!/usr/bin/env node
/**
 * detect-clear.js
 * Hook: beforeSubmitPrompt
 * Detects /clear command and backs up full transcript before clear proceeds.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  initDb,
  createSession,
  getSessionMessages,
  insertClearEvent,
  readBuffer,
  clearBuffer,
  DB_PATH
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

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const userMessage = data?.tool_input?.command
    || data?.message
    || data?.content
    || '';

  // Only act on /clear
  if (userMessage.trim() !== '/clear') {
    process.exit(0);
  }

  const sessionId = getSessionId();

  try {
    initDb();
    ensureBackupDir();

    // Get all messages from DB
    const messages = getSessionMessages(sessionId);

    // Also get buffer messages (may have more recent data)
    const bufferMessages = readBuffer(sessionId);

    // Merge: DB messages + buffer messages not yet in DB
    const allMessages = [...messages, ...bufferMessages.filter(bm =>
      !messages.some(m => m.content === bm.content && m.timestamp === bm.timestamp)
    )];

    if (allMessages.length > 0) {
      // Save backup as JSON
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(BACKUP_DIR, `clear-${sessionId.slice(0, 8)}-${timestamp}.json`);

      fs.writeFileSync(backupPath, JSON.stringify({
        session_id: sessionId,
        event: 'clear',
        backed_up_at: new Date().toISOString(),
        message_count: allMessages.length,
        messages: allMessages
      }, null, 2), 'utf8');

      // Log event to DB
      insertClearEvent(sessionId, 'clear', allMessages.length, backupPath);

      // Clear the buffer file
      clearBuffer(sessionId);

      process.stderr.write(`[conv-persist] /clear detected. Backed up ${allMessages.length} messages to ${backupPath}\n`);
    }
  } catch (err) {
    process.stderr.write(`[conv-persist] Error during /clear backup: ${err.message}\n`);
  }
}

main();
