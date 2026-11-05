import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-inbound-message context for the replies it produces, so handlers deep in
 * the conversation code don't need extra parameters. Today it carries one
 * thing: whether the first reply to a number's first-ever message should carry
 * the welcome image (see queueBotReplies).
 */
export interface ReplyContext {
  inboundMessageId: string;
  /** Attach the welcome image to the next bot reply for this message. Cleared once used or skipped. */
  attachWelcomeImage: boolean;
}

const storage = new AsyncLocalStorage<ReplyContext>();

export function runWithReplyContext<T>(context: ReplyContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export const currentReplyContext = (): ReplyContext | undefined => storage.getStore();

/** Flows where speed matters more than a picture (an emergency request) call this before replying. */
export function skipWelcomeImage() {
  const context = storage.getStore();
  if (context) context.attachWelcomeImage = false;
}
