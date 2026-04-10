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
  ARCHIVE_DB_PATH,
  getDb,
  initDb,
  initArchiveDb,
  archiveOldSessions,
  restoreSession,
  restoreAllSessions,
  queryArchive,
  getArchiveStats,
  listArchivedSessions,
  deleteArchivedSessionsOlderThan
} = require(path.resolve(__dirname, '..', 'hooks', 'db-utils.js'));

// ==========================================
// Helpers
// ==========================================

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

  return [header, sep, ...lines].map(l => `  ${l}`).join('\n');
}

function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
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

function getStats() {
  const db = getDb();
  const stats = {
    sessions: db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
    messages: db.prepare('SELECT COUNT(*) as count FROM messages').get().count,
    clear_events: db.prepare('SELECT COUNT(*) as count FROM clear_events').get().count,
    oldest: db.prepare('SELECT MIN(started_at) as date FROM sessions').get().date,
    newest: db.prepare('SELECT MAX(ended_at) as date FROM sessions').get().date
  };
  db.close();
  return stats;
}

function queryActive(sql, params = []) {
  const db = getDb();
  try {
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows;
  } catch (err) {
    db.close();
    throw err;
  }
}

// ==========================================
// Commands
// ==========================================

function cmdStatus() {
  console.log('\n  Conversation SQLite Persistence - Status\n');

  // Active DB
  if (fs.existsSync(DB_PATH)) {
    const activeStats = getStats();
    const dbSizeMB = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2);

    console.log('  Active Database (conversations.db):');
    console.log(`    Sessions:  ${activeStats.sessions}`);
    console.log(`    Messages:  ${activeStats.messages}`);
    console.log(`    Events:    ${activeStats.clear_events}`);
    console.log(`    Size:      ${dbSizeMB} MB`);
    console.log(`    Oldest:    ${activeStats.oldest || 'N/A'}`);
    console.log(`    Newest:    ${activeStats.newest || 'N/A'}`);
  } else {
    console.log('  Active Database: Not initialized');
  }

  console.log('');

  // Archive DB
  if (fs.existsSync(ARCHIVE_DB_PATH)) {
    const archiveStats = getArchiveStats();
    const archiveSizeMB = (fs.statSync(ARCHIVE_DB_PATH).size / 1024 / 1024).toFixed(2);

    console.log('  Archive Database (conversations-archive.db):');
    console.log(`    Sessions:  ${archiveStats.sessions}`);
    console.log(`    Messages:  ${archiveStats.messages}`);
    console.log(`    Events:    ${archiveStats.archived_events}`);
    console.log(`    Size:      ${archiveSizeMB} MB`);
  } else {
    console.log('  Archive Database: Empty (no archives yet)');
  }

  console.log('');

  // Backups
  const backupDir = path.join(os.homedir(), '.claude', 'backups');
  if (fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.json'));
    console.log(`  Backups: ${backups.length} files in ~/.claude/backups/`);
  } else {
    console.log('  Backups: Directory not found');
  }

  console.log('');
}

function cmdArchive(args) {
  const days = parseInt(args.flags.days || '90', 10);
  console.log(`\n  Archiving sessions older than ${days} days...\n`);

  initDb();
  const result = archiveOldSessions(days, 'manual');

  if (result.archived === 0) {
    console.log('  No sessions to archive.\n');
  } else {
    console.log(`  Archived ${result.archived} session(s) to conversations-archive.db`);
    for (const id of result.sessions) {
      console.log(`    - ${id.slice(0, 16)}...`);
    }
    console.log('');
  }
}

function cmdList(args) {
  const archived = args.flags.archived || false;
  const limit = parseInt(args.flags.limit || '20', 10);

  console.log('');

  if (archived) {
    console.log(`  Archived Sessions (limit ${limit}):\n`);
    const rows = listArchivedSessions(limit);
    if (rows.length === 0) {
      console.log('  No archived sessions.\n');
      return;
    }
    console.log(formatTable(rows, ['id', 'project_path', 'started_at', 'ended_at', 'total_messages']));
  } else {
    console.log(`  Active Sessions (limit ${limit}):\n`);
    if (!fs.existsSync(DB_PATH)) {
      console.log('  No active database.\n');
      return;
    }
    const rows = queryActive(
      'SELECT id, project_path, started_at, ended_at, total_messages FROM sessions ORDER BY ended_at DESC LIMIT ?',
      [limit]
    );
    if (rows.length === 0) {
      console.log('  No active sessions.\n');
      return;
    }
    console.log(formatTable(rows, ['id', 'project_path', 'started_at', 'ended_at', 'total_messages']));
  }

  console.log('');
}

function cmdQuery(args) {
  const sql = args.positional.join(' ');
  if (!sql) {
    console.error('  Error: No SQL query provided.');
    console.log('  Usage: conv-persist query "SELECT * FROM sessions" [--archived]');
    process.exit(1);
  }

  const archived = args.flags.archived || false;

  console.log('');
  console.log(`  Querying ${archived ? 'archive' : 'active'} database...\n`);
  console.log(`  SQL: ${sql}\n`);

  try {
    const rows = archived ? queryArchive(sql) : queryActive(sql);
    if (rows.length === 0) {
      console.log('  No results.\n');
      return;
    }

    // Auto-detect columns from first row
    const columns = Object.keys(rows[0]);
    console.log(formatTable(rows, columns));
    console.log(`\n  ${rows.length} row(s) returned.\n`);
  } catch (err) {
    console.error(`  Query error: ${err.message}\n`);
    process.exit(1);
  }
}

function cmdRestore(args) {
  const target = args.positional[0];

  console.log('');

  if (target === '--all' || args.flags.all) {
    console.log('  Restoring all archived sessions...\n');
    const result = restoreAllSessions();
    console.log(`  Restored ${result.restored} session(s) to active database.\n`);
  } else if (target) {
    console.log(`  Restoring session: ${target}\n`);
    const success = restoreSession(target);
    if (success) {
      console.log('  Session restored to active database.\n');
    } else {
      console.error('  Session not found in archive.\n');
      process.exit(1);
    }
  } else {
    console.error('  Error: No session ID provided.');
    console.log('  Usage: conv-persist restore <session-id>');
    console.log('         conv-persist restore --all\n');
    process.exit(1);
  }
}

function cmdExport(args) {
  const target = args.positional[0];
  const format = args.flags.format || 'json';
  const archived = args.flags.archived || false;
  const output = args.flags.output || args.flags.o;

  console.log('');

  if (!target) {
    console.error('  Error: No session ID provided.');
    console.log('  Usage: conv-persist export <session-id> [--format json|markdown|csv] [--archived] [--output file]');
    process.exit(1);
  }

  const messages = archived
    ? queryArchive('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC', [target])
    : queryActive('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC', [target]);

  if (messages.length === 0) {
    console.log('  No messages found for this session.\n');
    return;
  }

  let output_content;

  switch (format) {
    case 'markdown':
      output_content = messages.map(m =>
        `### ${m.role.toUpperCase()} (${m.timestamp})\n\n${m.content}\n`
      ).join('---\n\n');
      break;

    case 'csv':
      const header = 'role,timestamp,content';
      const rows = messages.map(m =>
        `"${m.role}","${m.timestamp}","${m.content.replace(/"/g, '""')}"`
      );
      output_content = [header, ...rows].join('\n');
      break;

    case 'json':
    default:
      output_content = JSON.stringify({ session_id: target, messages }, null, 2);
      break;
  }

  if (output) {
    fs.writeFileSync(output, output_content, 'utf8');
    console.log(`  Exported ${messages.length} messages to ${output}\n`);
  } else {
    console.log(output_content);
  }
}

function cmdCleanup(args) {
  const deleteArchivedDays = parseInt(args.flags['delete-archived-older-than'] || '0', 10);

  console.log('');

  // VACUUM active DB
  if (fs.existsSync(DB_PATH)) {
    console.log('  Compacting active database...');
    const db = getDb();
    db.exec('VACUUM');
    const sizeMB = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2);
    db.close();
    console.log(`  Active DB size: ${sizeMB} MB`);
  }

  // VACUUM archive DB
  if (fs.existsSync(ARCHIVE_DB_PATH)) {
    console.log('  Compacting archive database...');
    const adb = getArchiveDb();
    adb.exec('VACUUM');
    const sizeMB = (fs.statSync(ARCHIVE_DB_PATH).size / 1024 / 1024).toFixed(2);
    adb.close();
    console.log(`  Archive DB size: ${sizeMB} MB`);
  }

  // Delete old archived sessions
  if (deleteArchivedDays > 0) {
    console.log(`  Deleting archived sessions older than ${deleteArchivedDays} days...`);
    const result = deleteArchivedSessionsOlderThan(deleteArchivedDays);
    console.log(`  Deleted ${result.deleted} session(s) from archive.`);
  }

  // Clean buffer files
  const bufferDir = path.join(os.homedir(), '.claude', 'buffer');
  if (fs.existsSync(bufferDir)) {
    const buffers = fs.readdirSync(bufferDir);
    if (buffers.length > 0) {
      console.log(`  Cleaning ${buffers.length} buffer file(s)...`);
      for (const f of buffers) {
        fs.unlinkSync(path.join(bufferDir, f));
      }
    }
  }

  console.log('\n  Cleanup complete.\n');
}

function cmdHelp() {
  console.log(`
  conversation-sqlite-persist CLI

  Usage: conv-persist <command> [options]

  Commands:
    status                          Show database statistics (active + archive)
    archive [--days N]              Archive sessions older than N days (default: 90)
    list [--archived] [--limit N]   List sessions (active by default)
    query "SQL" [--archived]        Run SQL query on active or archive database
    restore <session-id>            Restore session from archive to active database
    restore --all                   Restore all archived sessions
    export <session-id> [options]   Export session to JSON/Markdown/CSV
      --format json|markdown|csv    Output format (default: json)
      --archived                    Export from archive database
      --output, -o <file>           Write to file instead of stdout
    cleanup [--delete-archived-older-than N]
                                    VACUUM databases, clean buffers
    help                            Show this help

  Examples:
    conv-persist status
    conv-persist archive --days 60
    conv-persist list --archived --limit 10
    conv-persist query "SELECT * FROM messages WHERE content LIKE '%bug%'" --archived
    conv-persist restore abc123
    conv-persist export abc123 --format markdown -o conversation.md
    conv-persist cleanup --delete-archived-older-than 365
  `);
}

// ==========================================
// Main
// ==========================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.command || 'help';

  const commands = {
    status: cmdStatus,
    archive: cmdArchive,
    list: cmdList,
    query: cmdQuery,
    restore: cmdRestore,
    export: cmdExport,
    cleanup: cmdCleanup,
    help: cmdHelp
  };

  if (commands[cmd]) {
    commands[cmd](args);
  } else {
    console.error(`\n  Unknown command: ${cmd}`);
    cmdHelp();
    process.exit(1);
  }
}

main();
