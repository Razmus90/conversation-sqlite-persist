#!/usr/bin/env node
// auto-save.js — Stop hook: simpan conversation ke DB setiap AI selesai merespons
const fs = require('fs');
const db = require('./db-utils.js');

const stdinData = fs.readFileSync(0, 'utf-8');
let input;
try {
    input = JSON.parse(stdinData);
} catch (err) {
    process.exit(0);
}

const session_id = input.session_id;
const transcript_path = input.transcript_path;
const project_path = input.cwd || process.cwd();

if (!session_id || !transcript_path) {
    process.exit(0);
}

(async () => {
    try {
        const result = await db.saveFullConversation(session_id, project_path, transcript_path);
        if (result.success) {
            console.error(`[Auto-Save] ${result.saved} messages saved for ${session_id}`);
        } else {
            console.error(`[Auto-Save] Failed for ${session_id}: ${result.error || 'no messages'}`);
        }
    } catch (e) {
        console.error(`[Auto-Save] Error: ${e.message}`);
    }
    process.exit(0);
})();
