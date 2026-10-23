import { beforeEach, describe, expect, it } from 'bun:test';
import { installFetchHarness, jsonResponse, type FetchResponder } from '../test-helpers/fetch-harness.js';
import type { SlackPlatformConfig } from '../../config/types.js';
import type { PersistedSession } from '../../persistence/session-store.js';
import { SlackClient } from './client.js';
import { createSlackDmRuntime } from './dm-runtime.js';

let responder: FetchResponder;
const harness = installFetchHarness(() => responder);
const config = (overrides: Partial<SlackPlatformConfig> = {}): SlackPlatformConfig => ({
  type: 'slack', id: 'desk', displayName: 'Desk', botToken: 'xoxb-test', appToken: 'xapp-test',
  channelId: 'C-DESK', botName: 'bot', allowedUsers: ['alice'], directMessages: true, ...overrides,
});
const event = (ts = '1.1', user = 'U-ALICE') => ({ type: 'message', channel_type: 'im', channel: 'D-ALICE', user, ts, text: 'hello' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
beforeEach(() => {
  responder = (url) => {
    if (String(url).includes('auth.test')) return jsonResponse({ ok: true, user_id: 'U-BOT', url: 'https://team.slack.com/' });
    if (String(url).includes('users.info')) {
      const id = new URL(String(url)).searchParams.get('user') || 'U-BOT';
      return jsonResponse({ ok: true, user: { id, name: id === 'U-ALICE' ? 'alice' : 'other', profile: {} } });
    }
    if (String(url).includes('conversations.info')) return jsonResponse({ ok: true, channel: { is_im: true, user: 'U-ALICE' } });
    return jsonResponse({ ok: true, ts: '9.9' });
  };
});
function setup(cfg = config(), enabled = (_id: string) => true) {
  const parent = new SlackClient(cfg);
  const children: SlackClient[] = [];
  const derivedConfigs: SlackPlatformConfig[] = [];
  const removed: string[] = [];
  const delivered: string[] = [];
  const errors: unknown[] = [];
  const runtime = createSlackDmRuntime({
    unregisterPlatform: (id) => { removed.push(id); },
    isEnabled: enabled, logError: (error) => { errors.push(error); },
    registerPlatform: (derived, source) => {
      derivedConfigs.push(derived);
      const child = new SlackClient(derived, source);
      children.push(child);
      child.on('message', (post) => { delivered.push(post.id); });
      return child;
    },
  });
  runtime.wireParent(cfg, parent);
  return { parent, children, delivered, errors, runtime, derivedConfigs, removed };
}

describe('Slack DM runtime', () => {
  it('OFF drops DM events without posts or children', async () => {
    const state = setup(config({ directMessages: false }));
    state.parent._injectSlackEvent(event());
    await flush();
    expect(state.children).toHaveLength(0);
    expect(state.delivered).toEqual([]);
    expect(harness.calls).toHaveLength(0);
  });

  it('ignores mpim and bot messages, and inherits desk settings for an im', async () => {
    const cfg = config({ lifecycle: 'hidden', hiddenTools: ['Read'], memory: false, permissionMode: 'bypass' });
    const state = setup(cfg);
    state.parent._injectSlackEvent({ ...event(), channel_type: 'mpim' });
    state.parent._injectSlackEvent({ ...event(), bot_id: 'B-OTHER' });
    await flush();
    expect(state.children).toHaveLength(0);
    state.parent._injectSlackEvent(event());
    await flush();
    expect(state.derivedConfigs[0]).toMatchObject({
      lifecycle: 'hidden', hiddenTools: ['Read'], memory: false, permissionMode: 'bypass',
      memoryPlatformId: 'desk', directChannelMode: false, directMessages: false,
      routines: false, watches: false,
    });
  });

  it('cleans up a failed child connection and permits a later retry without sockets', async () => {
    const state = setup();
    const original = responder;
    responder = (url, init) => String(url).includes('auth.test')
      ? jsonResponse({ ok: false, error: 'invalid_auth' }) : original(url, init);
    state.parent._injectSlackEvent(event());
    await flush();
    expect(state.errors).toHaveLength(1);
    expect(state.removed).toEqual(['desk--dm-D-ALICE']);
    expect(state.delivered).toEqual([]);
    responder = original;
    state.parent._injectSlackEvent(event('2.2'));
    await flush();
    expect(state.children).toHaveLength(2);
    expect(state.delivered).toEqual(['2.2']);
    expect(harness.calls.some((c) => c.url.includes('apps.connections.open'))).toBe(false);
  });

  it('queues concurrent first messages and redelivery through one shared-source child', async () => {
    const state = setup();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const original = responder;
    responder = async (url, init) => {
      if (String(url).includes('auth.test')) await ready;
      return original(url, init);
    };
    state.parent._injectSlackEvent(event());
    state.parent._injectSlackEvent(event('2.2'));
    state.parent._injectSlackEvent(event());
    await flush();
    expect(state.children).toHaveLength(1);
    expect(state.delivered).toEqual([]);
    release();
    await flush();
    expect(state.delivered).toEqual(['1.1', '2.2']);
    state.parent._injectSlackEvent({ ...event('3.3'), thread_ts: '1.1' });
    await flush();
    expect(state.delivered).toEqual(['1.1', '2.2', '3.3']);
    expect(state.errors).toEqual([]);
    expect(harness.calls.filter((c) => c.url.includes('apps.connections.open'))).toHaveLength(0);
  });

  for (const deniedMessage of [undefined, 'Access denied']) {
    it(`rejects unauthorized DMs (${deniedMessage ?? 'silent'}) before registration`, async () => {
      const state = setup(config({ directMessagesDeniedMessage: deniedMessage }));
      state.parent._injectSlackEvent(event('1.1', 'U-OTHER'));
      state.parent._injectSlackEvent(event('2.2', 'U-OTHER'));
      await flush();
      expect(state.children).toHaveLength(0);
      expect(state.delivered).toEqual([]);
      const posts = harness.calls.filter((c) => c.url.includes('chat.postMessage'));
      expect(posts).toHaveLength(deniedMessage ? 1 : 0);
      if (deniedMessage) expect(posts[0].body).toMatchObject({ channel: 'D-ALICE', text: deniedMessage });
      expect(harness.calls.some((c) => c.url.includes('reactions.add'))).toBe(false);
    });
  }

  it('reconstructs one child for multiple persisted threads before parent connection', async () => {
    const state = setup();
    const sessions = new Map(['1.1', '2.2'].map((threadId) => [threadId, {
      platformId: 'desk--dm-D-ALICE', threadId, startedBy: 'alice',
    } as PersistedSession]));
    await state.runtime.reconstructPersisted([config()], new Map([['desk', state.parent]]), sessions);
    expect(state.children).toHaveLength(1);
    state.parent._injectSlackEvent({ ...event('3.3'), thread_ts: '1.1' });
    await flush();
    expect(state.delivered).toEqual(['3.3']);
    expect(harness.calls.some((c) => c.url.includes('apps.connections.open'))).toBe(false);
  });

  for (const cfg of [config({ directMessages: false }), config({ allowedUsers: ['bob'] })]) {
    it(`does not reconstruct with OFF or revoked access (${cfg.directMessages})`, async () => {
      const state = setup(cfg);
      await state.runtime.reconstructPersisted([cfg], new Map([['desk', state.parent]]), new Map([['session', {
        platformId: 'desk--dm-D-ALICE', threadId: '1.1', startedBy: 'alice',
      } as PersistedSession]]));
      expect(state.children).toHaveLength(0);
    });
  }
});
