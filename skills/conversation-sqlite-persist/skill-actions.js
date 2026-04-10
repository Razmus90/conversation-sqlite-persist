#!/usr/bin/env node
// skill-actions.js — CLI untuk skill conversation-sqlite-persist
// Usage: node skill-actions.js <save|read|clear> --session-id <id>

const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const db = require(path.join(HOME, '.claude', 'hooks', 'db-utils.js'));

// Parse CLI args
function parseArgs() {
    const args = process.argv.slice(2);
    const command = args[0];
    let sessionId = null;

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--session-id' && args[i + 1]) {
            sessionId = args[i + 1];
            i++;
        }
    }
    return { command, sessionId };
}

// === Commands ===

async function cmdSave(sessionId) {
    if (!sessionId) {
        console.log(JSON.stringify({ status: 'error', message: 'Missing --session-id' }));
        process.exit(1);
    }

    const transcriptPath = db.findTranscriptPath(sessionId);
    if (!transcriptPath) {
        console.log(JSON.stringify({
            status: 'no_transcript',
            session_id: sessionId,
            message: `No transcript found for session ${sessionId}`
        }));
        return;
    }

    const result = await db.saveFullConversation(sessionId, '', transcriptPath);

    if (result.success) {
        console.log(JSON.stringify({
            status: 'success',
            session_id: sessionId,
            messages_saved: result.saved,
            transcript_path: transcriptPath
        }));
    } else {
        console.log(JSON.stringify({
            status: 'error',
            session_id: sessionId,
            error: result.error || 'No messages found'
        }));
    }
}

async function cmdRead(sessionId) {
    if (!sessionId) {
        console.log(JSON.stringify({ status: 'error', message: 'Missing --session-id' }));
        process.exit(1);
    }

    await db.initDatabase();

    const exists = await db.validateSession(sessionId);
    if (!exists) {
        console.log(JSON.stringify({
            status: 'no_session',
            session_id: sessionId,
            message: 'Session not found in DB. Run save first.'
        }));
        return;
    }

    const messages = await db.getSessionMessages(sessionId);

    if (!messages || messages.length === 0) {
        console.log(JSON.stringify({ status: 'no_messages', session_id: sessionId }));
        return;
    }

    // Format: extract text from JSON content blocks
    const formatted = messages.map(m => {
        let content = m.content || '';
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                const textParts = parsed
                    .filter(b => b.type === 'text')
                    .map(b => b.content || b.text || '');
                content = textParts.join('\n') || content;
            }
        } catch (e) {
            // content is plain text, use as-is
        }

        return {
            role: m.role,
            content: content.substring(0, 2000),
            timestamp: m.timestamp
        };
    });

    console.log(JSON.stringify({
        status: 'success',
        session_id: sessionId,
        message_count: formatted.length,
        messages: formatted
    }));
}

function cmdClear() {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(JSON.stringify({ status: 'cleared' }));
}

// === Main ===

async function main() {
    const { command, sessionId } = parseArgs();

    switch (command) {
        case 'save':
            await cmdSave(sessionId);
            break;
        case 'read':
            await cmdRead(sessionId);
            break;
        case 'clear':
            cmdClear();
            break;
        default:
            console.log(JSON.stringify({
                status: 'error',
                message: `Unknown command: ${command}. Use: save, read, clear`
            }));
            process.exit(1);
    }
}

main().catch(err => {
    console.error(`[skill-actions] Fatal: ${err.message}`);
    console.log(JSON.stringify({ status: 'fatal_error', error: err.message }));
    process.exit(1);
});
