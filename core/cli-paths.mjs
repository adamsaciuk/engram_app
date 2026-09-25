// ENGRAM core: where the user's CLAUDE.md lives. Shared by the command and
// the server so both report the same installed rules version.

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function claudeMdPath(explicit) {
    return explicit ? resolve(explicit) : join(process.env.ENGRAM_CLAUDE_HOME || join(homedir(), '.claude'), 'CLAUDE.md');
}
