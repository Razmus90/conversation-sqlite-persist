#!/usr/bin/env node
/**
 * cli.js
 * CLI interface for conversation-sqlite-persist.
 *
 * Usage: conv-persist <command> [options]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  DB_PATH,
  initDatabase,
  saveSession,
  saveMessage,
  findTranscriptPath,
  saveFullConversation,
  getSessionMessages,
  validateSession
} = require(path.resolve(__dirname, '..', 'hooks', 'db-utils.js'));

function formatTable(rows, columns) {
  if (rows.length === 0) return '  (no data)';
  const widths = {};
  for (const col of columns) {
    widths[col] = Math.max(col.length, ...rows.map(r => String(r[col] || '').length));
  }
  const header = columns.map(c => c.padEnd(widths[c])).join(' | ');
  const sep = columns.map(c => '-'.repeat(widths[c])).join('-+-');
  const lines = rows.map(r =>
    columns.map(c => String(r[c] || '').slice(0, widths[c]).padEnd(widths[c])).join(' | ')
  );
  return [header, sep, ...lines].map(l => '  ' + l).join('\n');
}

function parseArgs(args) {
  const parsed = { command: null, flags: {}, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.flags[key] = next;
        i++;
      } else {
        parsed.flags[key] = true;
      }
    } else if (!parsed.command) {
      parsed.command = arg;
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function cmdStatus() {
  console.log('\n  Conversation SQLite Persistence - Status\n');
  if (fs.existsSync(DB_PATH)) {
    const dbSizeMB = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(DB_PATH);
    db.get('SELECT COUNT(*) as count FROM sessions', (err, sessions) => {
      if (err) { console.log('  Error: ' + err.message); db.close(); return; }
      db.get('SELECT COUNT(*) as count FROM messages', (err2, messages) => {
        db.get('SELECT MIN(started_at) as oldest, MAX(ended_at) as newest FROM sessions', (err3, dates) => {
          console.log('  Active Database (conversations.db):');
          console.log('    Sessions:  ' + (sessions ? sessions.count : 0));
          console.log('    Messages:  ' + (messages ? messages.count : 0));
          console.log('    Size:      ' + dbSizeMB + ' MB');
          console.log('    Oldest:    ' + (dates && dates.oldest ? dates.oldest : 'N/A'));
          console.log('    Newest:    ' + (dates && dates.newest ? dates.newest : 'N/A'));
          console.log('');
          db.close();
        });
      });
    });
  } else {
    console.log('  Active Database: Not initialized\n');
  }
}

function cmdList(args) {
  const limit = parseInt(args.flags.limit || '20', 10);
  console.log('\n  Active Sessions (limit ' + limit + '):\n');
  if (!fs.existsSync(DB_PATH)) { console.log('  No active database.\n'); return; }
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB_PATH);
  db.all(
    'SELECT id, project_path, started_at, ended_at, total_messages FROM sessions ORDER BY ended_at DESC LIMIT ?',
    [limit],
    (err, rows) => {
      if (err) { console.log('  Error: ' + err.message + '\n'); db.close(); return; }
      if (!rows || rows.length === 0) { console.log('  No active sessions.\n'); }
      else { console.log(formatTable(rows, ['id', 'project_path', 'started_at', 'ended_at', 'total_messages'])); console.log(''); }
      db.close();
    }
  );
}

function cmdQuery(args) {
  const sql = args.positional.join(' ');
  if (!sql) {
    console.error('  Error: No SQL query provided.');
    console.log('  Usage: conv-persist query "SELECT * FROM sessions"');
    process.exit(1);
  }
  console.log('\n  Querying database...\n  SQL: ' + sql + '\n');
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(DB_PATH);
  db.all(sql, (err, rows) => {
    if (err) { console.error('  Query error: ' + err.message + '\n'); db.close(); process.exit(1); }
    if (!rows || rows.length === 0) { console.log('  No results.\n'); }
    else { console.log(formatTable(rows, Object.keys(rows[0]))); console.log('\n  ' + rows.length + ' row(s) returned.\n'); }
    db.close();
  });
}

function cmdSave(args) {
  const sessionId = args.positional[0];
  if (!sessionId) { console.error('  Error: No session ID provided.'); process.exit(1); }
  console.log('\n  Saving session: ' + sessionId + '\n');
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) { console.log('  No transcript found.\n'); return; }
  saveFullConversation(sessionId, '', transcriptPath).then(result => {
    if (result.success) console.log('  Saved ' + result.saved + ' messages.\n');
    else console.log('  Failed: ' + (result.error || 'no messages') + '\n');
  });
}

function cmdRead(args) {
  const sessionId = args.positional[0];
  if (!sessionId) { console.error('  Error: No session ID provided.'); process.exit(1); }
  console.log('\n  Reading session: ' + sessionId + '\n');
  getSessionMessages(sessionId).then(messages => {
    if (!messages || messages.length === 0) { console.log('  No messages found.\n'); return; }
    console.log(formatTable(messages, ['role', 'content', 'timestamp']));
    console.log('\n  ' + messages.length + ' message(s).\n');
  }).catch(err => { console.error('  Error: ' + err.message + '\n'); });
}

function cmdCleanup() {
  console.log('');
  if (fs.existsSync(DB_PATH)) {
    console.log('  Compacting database...');
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(DB_PATH);
    db.exec('VACUUM', (err) => {
      if (err) console.log('  Error: ' + err.message);
      else {
        const sizeMB = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
        console.log('  Database size: ' + sizeMB + ' MB');
      }
      db.close();
      console.log('\n  Cleanup complete.\n');
    });
  } else { console.log('  No database found.\n'); }
}

function cmdHelp() {
  console.log('');
  console.log('  conversation-sqlite-persist CLI');
  console.log('');
  console.log('  Usage: conv-persist <command> [options]');
  console.log('');
  console.log('  Commands:');
  console.log('    status                          Show database statistics');
  console.log('    list [--limit N]                List sessions (default: 20)');
  console.log('    query "SQL"                     Run SQL query on database');
  console.log('    save <session-id>               Save session from transcript to DB');
  console.log('    read <session-id>               Read messages from a session');
  console.log('    cleanup                         VACUUM database');
  console.log('    help                            Show this help');
  console.log('');
  console.log('  Examples:');
  console.log('    conv-persist status');
  console.log('    conv-persist list --limit 10');
  console.log('    conv-persist save abc123-def456');
  console.log('    conv-persist read abc123-def456');
  console.log('    conv-persist cleanup');
  console.log('');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.command || 'help';
  const commands = {
    status: cmdStatus, list: cmdList, query: cmdQuery,
    save: cmdSave, read: cmdRead, cleanup: cmdCleanup, help: cmdHelp
  };
  if (commands[cmd]) commands[cmd](args);
  else { console.error('\n  Unknown command: ' + cmd); cmdHelp(); process.exit(1); }
}

main();
