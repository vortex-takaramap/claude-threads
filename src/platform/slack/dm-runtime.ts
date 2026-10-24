import type { SlackPlatformConfig } from '../../config/types.js';
import type { PersistedSession } from '../../persistence/session-store.js';
import { dmPlatformId, DM_PLATFORM_SEP } from '../dm-discovery.js';
import { SlackClient } from './client.js';

type SlackEvent = Parameters<SlackClient['_injectSlackEvent']>[0];

export function createSlackDmRuntime(deps: {
  registerPlatform: (config: SlackPlatformConfig, parent: SlackClient) => SlackClient;
  unregisterPlatform: (id: string) => void;
  isEnabled: (id: string) => boolean;
  logError: (error: unknown) => void;
}) {
  const children = new Map<string, Promise<SlackClient>>();
  const queues = new Map<string, Promise<void>>();
  // ponytail: Denials are once per DM channel in this process; restart may resend.
  const denied = new Set<string>();

  const ensureChild = (config: SlackPlatformConfig, parent: SlackClient, channelId: string): Promise<SlackClient> => {
    const id = dmPlatformId(config.id, channelId);
    let pending = children.get(id);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const child = deps.registerPlatform({
          ...config, id, channelId,
          displayName: `${config.displayName || config.id} DM (${channelId})`,
          directMessages: false, directChannelMode: false,
          memoryPlatformId: config.id, routines: false, watches: false,
        }, parent);
        try {
          await child.connect();
          return child;
        } catch (error) {
          await child.disconnect().catch(() => {});
          deps.unregisterPlatform(id);
          throw error;
        }
      });
      children.set(id, pending);
      void pending.catch(() => { children.delete(id); });
    }
    return pending;
  };

  const wireParent = (config: SlackPlatformConfig, parent: SlackClient): void => {
    if (!config.directMessages) return;
    parent.on('slack_direct_message', (event: SlackEvent, appId: string | null) => {
      const channelId = event.channel;
      if (!channelId) return;
      const previous = queues.get(channelId) ?? Promise.resolve();
      const next = previous.then(async () => {
        const user = await parent.getUser(event.user || '');
        if (!user || !parent.isUserAllowed(user.username)) {
          if (config.directMessagesDeniedMessage && !denied.has(channelId)) {
            denied.add(channelId);
            // Use a shared-source client only as a REST target; never register it.
            const target = new SlackClient({ ...config, channelId, directMessages: false }, parent);
            await target.createPost(config.directMessagesDeniedMessage);
          }
          return;
        }
        if (!deps.isEnabled(config.id) || !deps.isEnabled(dmPlatformId(config.id, channelId))) return;
        const child = await ensureChild(config, parent, channelId);
        child._injectSlackEvent(event, appId);
      }).catch(deps.logError);
      queues.set(channelId, next);
      void next.finally(() => { if (queues.get(channelId) === next) queues.delete(channelId); });
    });
  };

  const reconstructPersisted = async (
    configs: SlackPlatformConfig[], platforms: Map<string, unknown>, sessions: Map<string, PersistedSession>,
  ): Promise<void> => {
    for (const persisted of sessions.values()) {
      const id = persisted.platformId || '';
      if (children.has(id)) continue;
      const config = configs.filter((p) => p.directMessages && id.startsWith(`${p.id}${DM_PLATFORM_SEP}`))
        .sort((a, b) => b.id.length - a.id.length)[0];
      if (!config || !deps.isEnabled(config.id) || !deps.isEnabled(id)) continue;
      const parent = platforms.get(config.id);
      const channelId = id.slice(config.id.length + DM_PLATFORM_SEP.length);
      if (!(parent instanceof SlackClient) || !channelId.startsWith('D')) continue;
      try {
        const user = await parent.getDirectMessageUser(channelId);
        if (user && parent.isUserAllowed(user.username)) await ensureChild(config, parent, channelId);
      } catch (error) { deps.logError(error); }
    }
  };
  return { wireParent, reconstructPersisted };
}
