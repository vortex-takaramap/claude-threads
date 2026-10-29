import { afterEach, describe, expect, it, mock } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogHandler } from '../../utils/logger.js';
import { spoolEvent } from './event-spool.js';

const directories: string[] = [];
function spoolPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'slack-spool-'));
  directories.push(directory);
  return join(directory, 'events.jsonl');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  setLogHandler(null);
});

describe('spoolEvent', () => {
  it('does nothing when disabled or when the event is not a channel/group message', () => {
    const append = mock(() => {});
    spoolEvent(undefined, { event: { type: 'message', channel_type: 'channel' } }, Date.now, append);
    spoolEvent('', { event: { type: 'message', channel_type: 'channel' } }, Date.now, append);
    for (const channel_type of ['im', 'mpim', undefined]) {
      spoolEvent('/unused', { event: { type: 'message', channel_type } }, Date.now, append);
    }
    spoolEvent('/unused', { event: { type: 'reaction_added', channel_type: 'channel' } }, Date.now, append);
    spoolEvent('/unused', {}, Date.now, append);
    expect(append).not.toHaveBeenCalled();
  });

  it('appends unmodified messages and subtypes with epoch seconds and event ids', () => {
    const path = spoolPath();
    const events = ['channel', 'group'].flatMap(channel_type =>
      [undefined, 'message_changed', 'message_deleted', 'thread_broadcast', 'bot_message', 'file_share', 'channel_join'].map(subtype => ({
        type: 'message', channel_type, subtype, bot_id: 'B-SELF',
        text: 'hello\nworld', message: { text: 'edited', ts: '1.1' }, deleted_ts: '1.1',
      })));
    for (const event of events) spoolEvent(path, { event_id: 'Ev1', event }, () => 1234567);
    spoolEvent(path, { event: events[0] }, () => 1234567);
    const content = readFileSync(path, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    const rows = content.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(rows).toEqual([...events.map(event => ({ received_at: 1234.567, event_id: 'Ev1', event: JSON.parse(JSON.stringify(event)) })),
      { received_at: 1234.567, event_id: null, event: JSON.parse(JSON.stringify(events[0])) }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reopens the path after rotation', () => {
    const path = spoolPath();
    const payload = { event: { type: 'message', channel_type: 'channel' } };
    spoolEvent(path, payload, () => 1000);
    renameSync(path, path + '.rotated');
    spoolEvent(path, payload, () => 1000);
    expect(readFileSync(path, 'utf8')).toBe(readFileSync(path + '.rotated', 'utf8'));
  });

  it('tries three times and logs only the path and error code without throwing', () => {
    const path = spoolPath();
    const warnings: string[] = [];
    setLogHandler((level, _component, message) => { if (level === 'warn') warnings.push(message); });
    const append = mock(() => { throw Object.assign(new Error('private event text'), { code: 'EACCES' }); });
    expect(() => spoolEvent(path, { event: { type: 'message', channel_type: 'group', text: 'secret' } }, Date.now, append)).not.toThrow();
    expect(append).toHaveBeenCalledTimes(3);
    expect(warnings).toEqual([`Event spool failed: ${path} (EACCES)`]);
    expect(append.mock.calls).toHaveLength(3);
  });

  it('stops retrying after a successful append and uses one append per attempt', () => {
    const path = spoolPath();
    let attempts = 0;
    const append: typeof appendFileSync = (file, data, options) => {
      if (++attempts < 3) throw Object.assign(new Error(), { code: 'ENOENT' });
      appendFileSync(file, data, options);
    };
    spoolEvent(path, { event: { type: 'message', channel_type: 'channel' } }, () => 1000, append);
    expect(attempts).toBe(3);
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(2);
  });

  it('does not create missing directories or throw on a real write failure', () => {
    const path = join(spoolPath(), 'missing', 'events.jsonl');
    setLogHandler(() => {});
    expect(() => spoolEvent(path, { event: { type: 'message', channel_type: 'channel' } })).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
