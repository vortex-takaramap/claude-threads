import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { getConfigDir, getDataDir } from './paths.js';

const originalConfigDir = process.env.CLAUDE_THREADS_CONFIG_DIR;
const originalDataDir = process.env.CLAUDE_THREADS_DATA_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_THREADS_CONFIG_DIR;
  else process.env.CLAUDE_THREADS_CONFIG_DIR = originalConfigDir;
  if (originalDataDir === undefined) delete process.env.CLAUDE_THREADS_DATA_DIR;
  else process.env.CLAUDE_THREADS_DATA_DIR = originalDataDir;
});

describe('storage paths', () => {
  test('uses the original paths when unset', () => {
    delete process.env.CLAUDE_THREADS_CONFIG_DIR;
    delete process.env.CLAUDE_THREADS_DATA_DIR;
    expect(getConfigDir()).toBe(join(homedir(), '.config', 'claude-threads'));
    expect(getDataDir()).toBe(join(homedir(), '.claude-threads'));
  });

  test('reads overrides on every call and returns them unchanged', () => {
    process.env.CLAUDE_THREADS_CONFIG_DIR = '/tmp/bot-one/config';
    process.env.CLAUDE_THREADS_DATA_DIR = '/tmp/bot-one/data';
    expect(getConfigDir()).toBe('/tmp/bot-one/config');
    expect(getDataDir()).toBe('/tmp/bot-one/data');
    process.env.CLAUDE_THREADS_CONFIG_DIR = 'relative/config';
    process.env.CLAUDE_THREADS_DATA_DIR = 'relative/data';
    expect(getConfigDir()).toBe('relative/config');
    expect(getDataDir()).toBe('relative/data');
  });

  test('treats empty strings as unset', () => {
    process.env.CLAUDE_THREADS_CONFIG_DIR = '';
    process.env.CLAUDE_THREADS_DATA_DIR = '';
    expect(getConfigDir()).toBe(join(homedir(), '.config', 'claude-threads'));
    expect(getDataDir()).toBe(join(homedir(), '.claude-threads'));
  });
});
