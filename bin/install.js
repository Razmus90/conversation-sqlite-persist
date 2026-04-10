#!/usr/bin/env node
/**
 * install.js
 * npx installer for conversation-sqlite-persist skill.
 *
 * Usage:
 *   npx conversation-sqlite-persist@latest
 *
 * What it does:
 *   1. Creates ~/.claude/hooks/ and copies hook scripts
 *   2. Creates ~/.claude/buffer/ and ~/.claude/backups/
 *   3. Initializes SQLite database
 *   4. Merges hook config into ~/.claude/settings.json
 *   5. Copies SKILL.md to ~/.claude/skills/conversation-sqlite-persist/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const BUFFER_DIR = path.join(CLAUDE_DIR, 'buffer');
const BACKUP_DIR = path.join(CLAUDE_DIR, 'backups');
const LOGS_DIR = path.join(CLAUDE_DIR, 'logs');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills', 'conversation-sqlite-persist');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

// Source paths (relative to this script)
const SRC_DIR = path.resolve(__dirname, '..');
const SRC_HOOKS = path.join(SRC_DIR, 'hooks');
const SRC_SKILL = path.join(SRC_DIR, 'skills', 'conversation-sqlite-persist', 'SKILL.md');

const HOOK_FILES = [
  'db-utils.js',
  'capture-user-message.js',
  'detect-clear.js',
  'pre-compact-backup.js',
  'final-save.js',
  'archive-manager.js'
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log(`  Created: ${dir}`);
  } else {
    log(`  Exists:  ${dir}`);
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
  log(`  Copied:  ${path.basename(src)} → ${dest}`);
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

function mergeHookConfig() {
  // Build hook entries
  const nodePath = process.execPath; // path to node.exe
  const isWindows = os.platform() === 'win32';

  function hookCmd(scriptName) {
    const scriptPath = path.join(HOOKS_DIR, scriptName).replace(/\\/g, '/');
    // Use forward slashes for cross-platform compatibility
    return `node ${scriptPath}`;
  }

  const newHooks = {
    beforeSubmitPrompt: [
      {
        command: hookCmd('detect-clear.js'),
        event: 'beforeSubmitPrompt',
        description: 'Detect /clear and backup before clear',
        id: 'conv-persist-detect-clear'
      },
      {
        command: hookCmd('capture-user-message.js'),
        event: 'beforeSubmitPrompt',
        description: 'Capture user messages to SQLite',
        id: 'conv-persist-capture'
      }
    ],
    preCompact: [
      {
        command: hookCmd('pre-compact-backup.js'),
        event: 'preCompact',
        description: 'Backup before context compaction',
        id: 'conv-persist-pre-compact'
      }
    ],
    sessionEnd: [
      {
        command: hookCmd('final-save.js'),
        event: 'sessionEnd',
        description: 'Final save on session end',
        id: 'conv-persist-final-save'
      }
    ]
  };

  // Read existing settings or create new
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      log(`  Found existing settings.json`);
    } catch {
      log(`  Warning: settings.json is invalid JSON, creating fresh`);
      settings = {};
    }
  }

  // Initialize hooks structure
  if (!settings.hooks) settings.hooks = {};

  // Merge each event type
  for (const [event, entries] of Object.entries(newHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    for (const entry of entries) {
      // Check if hook already exists (by id)
      const existing = settings.hooks[event].find(h => h.id === entry.id);
      if (!existing) {
        settings.hooks[event].push(entry);
        log(`  Added hook: ${entry.id} (${event})`);
      } else {
        // Update command path
        existing.command = entry.command;
        log(`  Updated hook: ${entry.id} (${event})`);
      }
    }
  }

  // Write settings
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  log(`  Saved: ${SETTINGS_PATH}`);
}

function installCli() {
  const binDir = path.join(CLAUDE_DIR, 'bin');
  ensureDir(binDir);

  const srcCli = path.join(SRC_DIR, 'bin', 'cli.js');
  const destCli = path.join(binDir, 'conv-persist.js');

  if (fs.existsSync(srcCli)) {
    copyFile(srcCli, destCli);

    // Create shell wrapper
    if (os.platform() === 'win32') {
      // Windows batch file
      const batContent = `@echo off\nnode "%~dp0conv-persist.js" %*\n`;
      fs.writeFileSync(path.join(binDir, 'conv-persist.bat'), batContent, 'utf8');
      log(`  Created: conv-persist.bat`);
    } else {
      // Unix shell script
      const shContent = `#!/bin/sh\nnode "$(dirname "$0")/conv-persist.js" "$@"\n`;
      const shPath = path.join(binDir, 'conv-persist');
      fs.writeFileSync(shPath, shContent, 'utf8');
      fs.chmodSync(shPath, '755');
      log(`  Created: conv-persist (shell wrapper)`);
    }

    log(`  CLI installed: ${destCli}`);
    log(`  Add ${binDir} to PATH, or run directly with:`);
    log(`    node ${destCli} <command>`);
  } else {
    log(`  Warning: cli.js not found at ${srcCli}`);
  }
}

function initDatabase() {
  // Lazy-load better-sqlite3 (may not be installed yet)
  try {
    const { initDb, initArchiveDb } = require(path.join(HOOKS_DIR, 'db-utils.js'));
    initDb();
    initArchiveDb();
    log(`  Active + Archive databases initialized`);
  } catch (err) {
    log(`  Note: Databases will be initialized on first use (${err.message})`);
  }
}

function main() {
  log('');
  log('╔══════════════════════════════════════════════════════╗');
  log('║    conversation-sqlite-persist Installer             ║');
  log('║    Zero-miss conversation persistence for Claude     ║');
  log('╚══════════════════════════════════════════════════════╝');
  log('');

  // Step 1: Create directories
  log('Step 1: Creating directories...');
  ensureDir(CLAUDE_DIR);
  ensureDir(HOOKS_DIR);
  ensureDir(BUFFER_DIR);
  ensureDir(BACKUP_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(SKILLS_DIR);
  log('');

  // Step 2: Copy hook scripts
  log('Step 2: Installing hook scripts...');
  for (const file of HOOK_FILES) {
    const src = path.join(SRC_HOOKS, file);
    const dest = path.join(HOOKS_DIR, file);
    if (!fs.existsSync(src)) {
      log(`  ERROR: Source not found: ${src}`);
      process.exit(1);
    }
    copyFile(src, dest);
  }
  log('');

  // Step 3: Install CLI
  log('Step 3: Installing CLI...');
  installCli();
  log('');

  // Step 4: Copy SKILL.md
  log('Step 4: Installing skill definition...');
  if (fs.existsSync(SRC_SKILL)) {
    copyFile(SRC_SKILL, path.join(SKILLS_DIR, 'SKILL.md'));
  } else {
    log(`  Warning: SKILL.md not found at ${SRC_SKILL}`);
  }
  log('');

  // Step 5: Merge hook configuration (including archive-manager)
  log('Step 5: Configuring hooks...');
  mergeHookConfig();
  log('');

  // Step 6: Initialize databases
  log('Step 6: Initializing databases...');
  initDatabase();
  log('');

  // Done
  log('╔══════════════════════════════════════════════════════╗');
  log('║              Installation Complete!                  ║');
  log('╚══════════════════════════════════════════════════════╝');
  log('');
  log('Next steps:');
  log('  1. Restart Claude Code');
  log('  2. Conversations auto-save to ~/.claude/conversations.db');
  log('  3. Sessions >90 days auto-archive to conversations-archive.db');
  log('');
  log('CLI commands:');
  log('  conv-persist status              # View statistics');
  log('  conv-persist list --archived     # List archived sessions');
  log('  conv-persist restore <id>        # Restore from archive');
  log('  conv-persist help                # Show all commands');
  log('');
  log('Files installed:');
  log(`  Hooks:    ${HOOKS_DIR}`);
  log(`  CLI:      ${path.join(CLAUDE_DIR, 'bin')}`);
  log(`  Skill:    ${SKILLS_DIR}`);
  log(`  Database: ${path.join(CLAUDE_DIR, 'conversations.db')}`);
  log(`  Archive:  ${path.join(CLAUDE_DIR, 'conversations-archive.db')}`);
  log(`  Backups:  ${BACKUP_DIR}`);
  log('');
}

main();
