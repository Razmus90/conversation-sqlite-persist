#!/usr/bin/env node
/**
 * capture-user-message.js
 * Hook: beforeSubmitPrompt
 * Captures every user message to buffer + SQLite in real-time.
 */

const {
  initDb,
  createSession,
  insertMessage,
  appendToBuffer
} = require('./db-utils');

function getSessionId() {
  // Claude Code provides session info via environment or stdin
  return process.env.CLAUDE_SESSION_ID
    || process.env.SESSION_ID
    || `session-${Date.now()}`;
}

function getProjectPath() {
  return process.env.CLAUDE_PROJECT_PATH
    || process.cwd();
}

async function main() {
  // Read hook input from stdin (JSON)
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // If no valid JSON, skip
    process.exit(0);
  }

  const userMessage = data?.tool_input?.command
    || data?.message
    || data?.content
    || '';

  if (!userMessage.trim()) {
    process.exit(0);
  }

  // Skip /clear — handled by detect-clear.js
  if (userMessage.trim() === '/clear') {
    process.exit(0);
  }

  const sessionId = getSessionId();
  const projectPath = getProjectPath();

  try {
    initDb();
    createSession(sessionId, projectPath);
    insertMessage(sessionId, 'user', userMessage);
    appendToBuffer(sessionId, 'user', userMessage);

    process.stderr.write(`[conv-persist] Captured message for session ${sessionId.slice(0, 8)}...\n`);
  } catch (err) {
    process.stderr.write(`[conv-persist] Error: ${err.message}\n`);
  }
}

main();
