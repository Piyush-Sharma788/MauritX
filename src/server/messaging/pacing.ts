/**
 * How long an outbox dispatcher waits between sends. Pure, so it can be tested
 * with a fake clock.
 *
 * Two speeds:
 * - replies to someone who just wrote to us (priority 0) follow each other after
 *   `replyIntervalMs`, so a conversation feels live;
 * - proactive messages (alerts, confirmations, admin tests) are only claimed once
 *   `proactiveIntervalMs` has passed since the last send of any kind, the
 *   conservative pace that protects the sending number.
 */
export type PacedOutcome = "idle" | "rate_limited" | "paced" | "sent" | "retry" | "failed" | "suppressed";

export interface PacerOptions {
  replyIntervalMs: number;
  proactiveIntervalMs: number;
  idlePollMs: number;
  rateLimitedPollMs: number;
}

export class SendPacer {
  private lastSendAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: PacerOptions) {}

  /** Whether a proactive message may be claimed now. Pass to dispatchNext as `proactiveAllowed`. */
  proactiveAllowed(nowMs: number): boolean {
    return nowMs - this.lastSendAt >= this.options.proactiveIntervalMs;
  }

  /** Milliseconds to wait before the next dispatch attempt, given what the last one did. */
  delayAfter(outcome: PacedOutcome, nowMs: number): number {
    switch (outcome) {
      case "sent":
      case "retry":
      case "failed":
        // A send was attempted: the provider was busy talking to WhatsApp.
        this.lastSendAt = nowMs;
        return this.options.replyIntervalMs;
      case "suppressed":
        return 0;
      case "paced":
        // Only proactive work is waiting; come back exactly when it may go.
        return Math.max(0, Math.min(this.options.idlePollMs, this.lastSendAt + this.options.proactiveIntervalMs - nowMs));
      case "rate_limited":
        return this.options.rateLimitedPollMs;
      case "idle":
        return this.options.idlePollMs;
    }
  }
}
