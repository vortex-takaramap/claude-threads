import { appendFileSync } from 'node:fs';
import { createLogger } from '../../utils/logger.js';
import type { SlackEventPayload } from './types.js';

const log = createLogger('slack');

/** Append thumb reactions before channel routing, including reactions in DMs. */
export function spoolReaction(
  path: string | undefined,
  payload: SlackEventPayload,
  now: () => number = Date.now,
  append: typeof appendFileSync = appendFileSync,
): void {
  const event = payload.event;
  if (!path || event?.type !== 'reaction_added' || event.item?.type !== 'message' ||
      !['+1', '-1', 'thumbsup', 'thumbsdown'].includes(event.reaction?.split('::')[0] ?? '')) return;

  let code = 'UNKNOWN';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const line = JSON.stringify({
        received_at: now() / 1000,
        channel: event.item.channel,
        ts: event.item.ts,
        reaction: event.reaction,
        user: event.user,
      }) + '\n';
      append(path, line, { mode: 0o600, flag: 'a' });
      return;
    } catch (error) {
      code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    }
  }
  log.warn(`Reaction spool failed: ${path} (${code})`);
}

/** Append before channel routing, reopening the file for every event to allow rotation. */
export function spoolEvent(
  path: string | undefined,
  payload: SlackEventPayload,
  now: () => number = Date.now,
  append: typeof appendFileSync = appendFileSync,
): void {
  const event = payload.event;
  if (!path || event?.type !== 'message' ||
      (event.channel_type !== 'channel' && event.channel_type !== 'group')) return;

  let code = 'UNKNOWN';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const line = JSON.stringify({ received_at: now() / 1000, event_id: payload.event_id ?? null, event }) + '\n';
      append(path, line, { mode: 0o600, flag: 'a' });
      return;
    } catch (error) {
      code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    }
  }
  log.warn(`Event spool failed: ${path} (${code})`);
}
