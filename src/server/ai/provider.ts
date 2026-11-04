/**
 * AI provider abstraction. Implementations turn one message into an
 * unvalidated proposal; interpret.ts validates it. Swap providers by adding
 * an implementation and an AI_PROVIDER value; nothing else changes.
 */

export interface AiMessageContext {
  /** What the bot already knows about the sender, so intents are read in context. */
  role: "donor" | "institution" | "requester" | "unknown";
  hasRecentAlert: boolean;
  hasOpenRequest: boolean;
}

export interface AiProvider {
  readonly name: string;
  /** Returns the provider's raw structured output. Throws on transport errors or refusals. */
  interpret(text: string, context: AiMessageContext): Promise<unknown>;
}

export class AiProviderError extends Error {
  constructor(readonly code: "REFUSED" | "TRUNCATED" | "NO_OUTPUT" | "TRANSPORT") {
    super(`AI provider error: ${code}`);
    this.name = "AiProviderError";
  }
}
