import { homedir } from 'os';
import { join } from 'path';

export function getConfigDir(): string {
  return process.env.CLAUDE_THREADS_CONFIG_DIR || join(homedir(), '.config', 'claude-threads');
}

export function getDataDir(): string {
  return process.env.CLAUDE_THREADS_DATA_DIR || join(homedir(), '.claude-threads');
}
