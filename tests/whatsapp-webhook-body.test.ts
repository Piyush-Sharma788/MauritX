import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/v1/webhooks/whatsapp/route";
import { resetWhatsAppCloudConfigForTests } from "@/lib/whatsapp/cloud-config";
import { readRawBodyLimited, signatureFor, verifySignature } from "@/server/messaging/cloud-webhook";

/**
 * The webhook reads its body as a stream with a hard cap, so a chunked body
 * without Content-Length can't be buffered in full, and the bytes it keeps are
 * exactly the bytes Meta signed. No database needed.
 */
const APP_SECRET = randomBytes(24).toString("hex");
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "test-access-token",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210987",
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: randomBytes(16).toString("hex"),
};
const URL = "http://localhost:3000/api/v1/webhooks/whatsapp";

/** A body delivered in chunks, with no Content-Length (Transfer-Encoding: chunked). */
function chunkedStream(chunks: Uint8Array[], onPull?: () => void) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}
const chunkedRequest = (stream: ReadableStream<Uint8Array>, signature?: string) =>
  new NextRequest(URL, {
    method: "POST",
    body: stream,
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);

describe("WhatsApp webhook body limit", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    resetWhatsAppCloudConfigForTests();
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetWhatsAppCloudConfigForTests();
  });

  it("returns the exact bytes, and stops reading once past the limit", async () => {
    const bytes = new Uint8Array([0x7b, 0xe2, 0x82, 0xb9, 0x7d]); // "{₹}" split mid-character below
    const raw = await readRawBodyLimited(new Request(URL, { method: "POST", body: chunkedStream([bytes.slice(0, 2), bytes.slice(2)]), duplex: "half" } as RequestInit), 100);
    expect(raw && [...raw]).toEqual([...bytes]);

    let pulls = 0;
    const big = Array.from({ length: 50 }, () => new Uint8Array(64 * 1024));
    const limited = await readRawBodyLimited(new Request(URL, { method: "POST", body: chunkedStream(big, () => pulls++), duplex: "half" } as RequestInit), 1024 * 1024);
    expect(limited).toBeNull();
    expect(pulls).toBeLessThan(25); // stopped just past 1 MB, not after all 3.2 MB
  });

  it("answers 413 to an oversized chunked body without Content-Length", async () => {
    const big = Array.from({ length: 40 }, () => new Uint8Array(64 * 1024).fill(0x20));
    const res = await POST(chunkedRequest(chunkedStream(big), `sha256=${"0".repeat(64)}`));
    expect(res.status).toBe(413);
  });

  it("still verifies a valid signed payload delivered in chunks", async () => {
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const encoded = new TextEncoder().encode(payload);
    const signature = signatureFor(payload, APP_SECRET);
    expect(verifySignature(Buffer.from(encoded), signature, APP_SECRET)).toBe(true);

    const res = await POST(chunkedRequest(chunkedStream([encoded.slice(0, 10), encoded.slice(10, 30), encoded.slice(30)]), signature));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");

    const forged = await POST(chunkedRequest(chunkedStream([encoded]), signatureFor(`${payload} `, APP_SECRET)));
    expect(forged.status).toBe(401);
  });
});
