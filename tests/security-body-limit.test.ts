import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@/lib/api/errors";
import { parseJsonBody, readBodyLimited } from "@/lib/api/handler";

/**
 * Route Handlers have no built-in body size limit, so the JSON parser must
 * stop reading as soon as a body is too large instead of buffering it all.
 */
const URL_ = "http://localhost:3000/api/v1/test";
const schema = z.strictObject({ text: z.string() });

function streamingRequest(totalBytes: number, chunkBytes = 1024) {
  let sent = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(chunkBytes, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
  const request = new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
  return { request, pulled: () => pulls, sent: () => sent };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return error instanceof AppError ? `${error.status} ${error.message}` : String(error);
  }
}

describe("JSON body size limit", () => {
  it("stops reading a chunked body without Content-Length once it passes the limit", async () => {
    const { request, sent } = streamingRequest(50 * 1024 * 1024);
    expect(await codeOf(parseJsonBody(request, schema))).toBe("400 Request body is too large.");
    // Only a few KB were read out of 50 MB.
    expect(sent()).toBeLessThan(16 * 1024);
  });

  it("rejects a declared Content-Length over the limit without reading the body", async () => {
    const { request, sent } = streamingRequest(10_000_000);
    const big = new NextRequest(request, { headers: { "content-type": "application/json", "content-length": "10000000" } });
    expect(await codeOf(parseJsonBody(big, schema))).toBe("400 Request body is too large.");
    // At most what the stream pre-fetches on its own; the parser read nothing.
    expect(sent()).toBeLessThanOrEqual(4 * 1024);
  });

  it("still rejects bodies over 2,048 characters", async () => {
    const request = new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a".repeat(2_100) }) });
    expect(await codeOf(parseJsonBody(request, schema))).toBe("400 Request body is too large.");
  });

  it("accepts a multi-byte (Hindi) body that is under the character limit, as before", async () => {
    const text = "रक्त".repeat(400); // 1,600 characters, 4,800 bytes
    const request = new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    expect(await parseJsonBody(request, schema)).toEqual({ text });
  });

  it("rejects unknown keys and operator objects (no raw objects reach queries)", async () => {
    const request = new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: { $gt: "" } }) });
    expect(await codeOf(parseJsonBody(request, schema))).toBe("422 Please check the submitted fields.");
  });

  it("readBodyLimited returns small bodies intact, including characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("नमस्ते");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const request = new Request(URL_, { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
    expect(await readBodyLimited(request, 100)).toBe("नमस्ते");
  });
});
