import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound HTTP for public data. Discovery follows URLs that anyone can edit
 * on OpenStreetMap, so every request is checked: http(s) on the default
 * ports only, public IP addresses only (no loopback, private or link-local
 * ranges), redirects re-checked hop by hop, and a size and time limit.
 */

export class UnsafeUrlError extends Error {
  constructor(reason: string) {
    super(`Refused URL: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("protocol");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("port");
  if (url.username || url.password) throw new UnsafeUrlError("credentials in URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new UnsafeUrlError("host does not resolve");
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError("private address");
  return url;
}

export interface SafeFetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes?: number;
  accept?: string;
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
}

/** Fetches a public URL and returns its text, following at most 3 checked redirects. */
export async function safeFetchText(raw: string, options: SafeFetchOptions): Promise<{ status: number; url: string; contentType: string; text: string }> {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertPublicUrl(current);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { "User-Agent": options.userAgent, Accept: options.accept ?? "text/html,application/json;q=0.9,*/*;q=0.5", ...(options.contentType ? { "Content-Type": options.contentType } : {}) },
      body: options.body,
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, url).toString();
      continue;
    }
    const max = options.maxBytes ?? 512 * 1024;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { status: response.status, url: url.toString(), contentType: response.headers.get("content-type") ?? "", text: Buffer.concat(chunks).toString("utf8") };
  }
  throw new UnsafeUrlError("too many redirects");
}
