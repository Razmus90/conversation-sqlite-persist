#!/usr/bin/env node
// detect-conversation-persist.js
// UserPromptSubmit hook — detects /conversation-sqlite-persist and injects menu context into LLM

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const SKILL_DIR = path.join(HOME, '.claude', 'skills', 'conversation-sqlite-persist');
const MENU_PATH = path.join(SKILL_DIR, 'menu.json');

// Read stdin
const stdinData = fs.readFileSync(0, 'utf-8');
let input;
try {
    input = JSON.parse(stdinData);
} catch (err) {
    process.exit(0); // silent pass-through
}

// Extract user prompt
let userPrompt = input.prompt || '';

// Extract from XML wrapper if present
const cmdMatch = userPrompt.match(/<command-name>(.*?)<\/command-name>/);
if (cmdMatch) {
    userPrompt = cmdMatch[1].trim();
}

// Only react to /conversation-sqlite-persist
if (!/^\/conversation-sqlite-persist$/i.test(userPrompt.trim())) {
    process.exit(0); // not our command, pass through
}

// Read menu definition
let menu;
try {
    menu = JSON.parse(fs.readFileSync(MENU_PATH, 'utf-8'));
} catch (err) {
    process.exit(0); // no menu file, pass through
}

// Extract session_id from hook input
const sessionId = input.session_id || 'unknown';

// Build context lines
const lines = [
    `## ${menu.title}`,
    '',
    'Show this menu using AskUserQuestion:',
    '',
];

// Menu options
for (let i = 0; i < menu.options.length; i++) {
    const opt = menu.options[i];
    lines.push(`${i + 1}. **${opt.label}** — ${opt.description}`);
}
lines.push('');
lines.push('After user selects, execute the matching action.');
lines.push('');

// Action instructions with session_id interpolated
for (const opt of menu.options) {
    if (opt.action === 'none') continue;

    if (opt.steps) {
        // Multi-step workflow (e.g., load)
        lines.push(`**${opt.label}**: Execute these steps in order:`);
        for (let j = 0; j < opt.steps.length; j++) {
            let step = opt.steps[j];
            step = step.replace(/{session_id}/g, sessionId);
            lines.push(`${j + 1}. \`${step}\``);
        }
        lines.push('');
    } else if (opt.command) {
        // Single command (e.g., save)
        let cmd = opt.command.replace(/{session_id}/g, sessionId);
        lines.push(`**${opt.label}**: Run \`${cmd}\``);
        lines.push('');
    }
}

// Summary format template (for load workflow)
if (menu.summaryFormat) {
    lines.push(menu.summaryFormat.replace(/{session_id}/g, sessionId));
}

const output = {
    hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: lines.join('\n')
    }
};

console.log(JSON.stringify(output));
