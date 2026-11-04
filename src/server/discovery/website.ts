import "server-only";
import { logger } from "@/lib/logger";
import { normaliseEmail, normaliseIndianPhones, type DiscoveredChannel } from "@/server/discovery/normalize";
import { safeFetchText } from "@/server/discovery/safe-fetch";

/**
 * Reads official contact links from an institution's own website: only
 * explicit `mailto:` and `tel:` links, on the homepage and at most one
 * contact page on the same host, and only where robots.txt allows. Results
 * are unverified until an admin reviews them.
 */

const MAX_PER_TYPE = 3;

/** Minimal robots.txt check for our user agent group and "*". */
export function robotsAllows(robotsTxt: string, path: string, agentToken = "marutix"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else {
      lastWasAgent = false;
    }
  }
  const group = groups.find((g) => g.agents.some((a) => a !== "*" && agentToken.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  // Longest matching rule wins; ties go to Allow.
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    const prefix = rule.path.replace(/\*.*$/, "").replace(/\$$/, "");
    if (path.startsWith(prefix) && (!best || prefix.length > best.length || (prefix.length === best.length && rule.allow))) best = { allow: rule.allow, length: prefix.length };
  }
  return best ? best.allow : true;
}

/** Explicit contact links in a page, plus same-host links that look like a contact page. */
export function extractContactLinks(html: string, pageUrl: string): { emails: string[]; phones: string[]; contactPages: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const contactPages = new Set<string>();
  const base = new URL(pageUrl);
  for (const m of html.matchAll(/href\s*=\s*["']([^"']{1,400})["']/gi)) {
    const href = m[1].replace(/&amp;/g, "&").trim();
    if (/^mailto:/i.test(href)) {
      const email = normaliseEmail(decodeURIComponent(href));
      if (email) emails.add(email);
    } else if (/^tel:/i.test(href)) {
      for (const p of normaliseIndianPhones(decodeURIComponent(href.slice(4)))) phones.add(p);
    } else if (/contact/i.test(href)) {
      try {
        const url = new URL(href, base);
        if (url.host === base.host && (url.protocol === "https:" || url.protocol === "http:")) contactPages.add(url.toString().split("#")[0]);
      } catch {
        // ignore malformed links
      }
    }
  }
  return { emails: [...emails], phones: [...phones], contactPages: [...contactPages] };
}

export async function contactsFromWebsite(website: string, options: { userAgent: string; timeoutMs: number }): Promise<DiscoveredChannel[]> {
  let origin: URL;
  try {
    origin = new URL(website);
  } catch {
    return [];
  }
  try {
    const robots = await safeFetchText(new URL("/robots.txt", origin).toString(), { ...options, maxBytes: 64 * 1024, accept: "text/plain" }).catch(() => null);
    const robotsTxt = robots && robots.status === 200 ? robots.text : "";
    const pages = [origin.toString()];
    const emails = new Map<string, string>();
    const phones = new Map<string, string>();
    for (let i = 0; i < pages.length && i < 2; i++) {
      const page = new URL(pages[i]);
      if (!robotsAllows(robotsTxt, page.pathname)) continue;
      const res = await safeFetchText(page.toString(), options);
      if (res.status !== 200 || !/html/i.test(res.contentType)) continue;
      const found = extractContactLinks(res.text, res.url);
      for (const e of found.emails) if (!emails.has(e)) emails.set(e, res.url);
      for (const p of found.phones) if (!phones.has(p)) phones.set(p, res.url);
      if (i === 0 && found.contactPages[0]) pages.push(found.contactPages[0]);
    }
    return [
      ...[...emails].slice(0, MAX_PER_TYPE).map(([value, sourceUrl]) => ({ type: "email" as const, value, source: "official_website" as const, sourceUrl })),
      ...[...phones].slice(0, MAX_PER_TYPE).map(([value, sourceUrl]) => ({ type: "phone" as const, value, source: "official_website" as const, sourceUrl })),
    ];
  } catch (error) {
    logger.warn("discovery.website_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return [];
  }
}
