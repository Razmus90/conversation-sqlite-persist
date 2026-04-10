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
 *   2. Initializes SQLite database
 *   3. Merges hook config into ~/.claude/settings.json
 *   4. Copies skill files to ~/.claude/skills/conversation-sqlite-persist/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const LOGS_DIR = path.join(CLAUDE_DIR, 'logs');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills', 'conversation-sqlite-persist');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

// Source paths (relative to this script)
const SRC_DIR = path.resolve(__dirname, '..');
const SRC_HOOKS = path.join(SRC_DIR, 'hooks');
const SRC_SKILL_DIR = path.join(SRC_DIR, 'skills', 'conversation-sqlite-persist');

const HOOK_FILES = [
  'db-utils.js',
  'detect-conversation-persist.js',
  'auto-save.js'
];

const SKILL_FILES = [
  'SKILL.md',
  'menu.json',
  'skill-actions.js'
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
  log(`  Copied:  ${path.basename(src)} -> ${dest}`);
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

function mergeHookConfig() {
  function hookCmd(scriptName) {
    const scriptPath = path.join(HOOKS_DIR, scriptName).replace(/\/g, '/');
    return `node ${scriptPath}`;
  }

  const newHooks = {
    UserPromptSubmit: [
      {
        command: hookCmd('detect-conversation-persist.js'),
        description: 'Detect /conversation-sqlite-persist and inject menu context',
        id: 'conv-persist-detect'
      }
    ],
    Stop: [
      {
        command: hookCmd('auto-save.js'),
        description: 'Auto-save conversation to SQLite on AI response complete',
        id: 'conv-persist-auto-save'
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

function initDatabase() {
  try {
    const { initDatabase: initDb } = require(path.join(HOOKS_DIR, 'db-utils.js'));
    initDb().then(() => {
      log(`  Database initialized`);
    }).catch(err => {
      log(`  Note: Database will be initialized on first use (${err.message})`);
    });
  } catch (err) {
    log(`  Note: Database will be initialized on first use (${err.message})`);
  }
}

function main() {
  log('');
  log('========================================================');
  log('  conversation-sqlite-persist Installer');
  log('  Menu-based conversation persistence for Claude Code');
  log('========================================================');
  log('');

  // Step 1: Create directories
  log('Step 1: Creating directories...');
  ensureDir(CLAUDE_DIR);
  ensureDir(HOOKS_DIR);
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

  // Step 3: Copy skill files
  log('Step 3: Installing skill files...');
  for (const file of SKILL_FILES) {
    const src = path.join(SRC_SKILL_DIR, file);
    const dest = path.join(SKILLS_DIR, file);
    if (!fs.existsSync(src)) {
      log(`  Warning: ${file} not found at ${src}`);
      continue;
    }
    copyFile(src, dest);
  }
  log('');

  // Step 4: Merge hook configuration
  log('Step 4: Configuring hooks...');
  mergeHookConfig();
  log('');

  // Step 5: Initialize database
  log('Step 5: Initializing database...');
  initDatabase();
  log('');

  // Done
  log('========================================================');
  log('  Installation Complete!');
  log('========================================================');
  log('');
  log('Next steps:');
  log('  1. Restart Claude Code');
  log('  2. Type /conversation-sqlite-persist to see the menu');
  log('  3. Conversations auto-save to ~/.claude/conversations.db');
  log('');
  log('Files installed:');
  log(`  Hooks:    ${HOOKS_DIR}`);
  log(`  Skill:    ${SKILLS_DIR}`);
  log(`  Database: ${path.join(CLAUDE_DIR, 'conversations.db')}`);
  log('');
}

main();
