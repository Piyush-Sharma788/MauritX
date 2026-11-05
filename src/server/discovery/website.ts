import "server-only";
import { logger } from "@/lib/logger";
import { normaliseEmail, normaliseIndianPhones, type DiscoveredChannel } from "@/server/discovery/normalize";
import { safeFetchText } from "@/server/discovery/safe-fetch";

/**
 * Reads official contact details from an institution's own website: explicit
 * `mailto:` and `tel:` links, plus emails and labelled phone numbers written
 * in the text, on the homepage and at most one contact page on the same host,
 * and only where robots.txt allows. Results are unverified until an admin
 * reviews them.
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

/** Visible text of an HTML page: no scripts, styles or markup; basic entities decoded; whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const CONTACT_WORDS = /(contact|phone|tel|mobile|call|helpline|emergency|e-?mail|mail|address|blood|transfusion|casualty|reception|enquir|whatsapp|24\s*x\s*7|24\/7|@|\[at\]|\(at\))/i;

/**
 * Only the parts of a page that can hold an institution's contact details or
 * blood-bank capability: lines with contact words, and their neighbours,
 * capped at `maxChars`. Everything else (news, doctor profiles, patient
 * stories) is dropped before anything is sent to an AI provider.
 */
export function relevantText(text: string, maxChars: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (CONTACT_WORDS.test(line)) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  });
  let out = "";
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i].slice(0, 300);
    if (out.length + line.length + 1 > maxChars) break;
    out += `${line}\n`;
  }
  return out.trim();
}

const TEXT_EMAIL = /[A-Za-z0-9._%+-]+\s*(?:@|\[at\]|\(at\))\s*[A-Za-z0-9-]+(?:\s*(?:\.|\[dot\]|\(dot\))\s*[A-Za-z0-9-]+)+/gi;
const LABELLED_PHONE = /(?:phone|tel|telephone|mobile|mob|call|helpline|contact|emergency|blood bank|ph)\.?\s*(?:no\.?|number)?\s*[:\-–]?\s*((?:\+?91[\s-]*)?(?:\(?0?\d{2,4}\)?[\s-]*)?\d[\d\s-]{5,12}\d)/gi;
const BLOOD_BANK_TEXT = /\b(blood\s*(bank|centre|center|storage\s*(unit|centre|center))|department of transfusion|transfusion medicine|immuno-?haematology)\b/i;

/**
 * Deterministic extraction from visible text: written-out emails (including
 * "name [at] host [dot] in") and phone numbers that follow a label such as
 * "Phone:" or "Helpline". Used when AI is off, and to cross-check AI output.
 */
export function extractFromText(text: string): { emails: string[]; phones: string[]; mentionsBloodBank: string | null } {
  const emails = new Set<string>();
  for (const m of text.matchAll(TEXT_EMAIL)) {
    const cleaned = m[0].replace(/\s*(\[at\]|\(at\))\s*/gi, "@").replace(/\s*(\[dot\]|\(dot\))\s*/gi, ".").replace(/\s+/g, "");
    const email = normaliseEmail(cleaned);
    if (email) emails.add(email);
  }
  const phones = new Set<string>();
  for (const m of text.matchAll(LABELLED_PHONE)) for (const p of normaliseIndianPhones(m[1])) phones.add(p);
  const blood = BLOOD_BANK_TEXT.exec(text);
  return { emails: [...emails], phones: [...phones], mentionsBloodBank: blood ? blood[0] : null };
}

export interface WebsitePage {
  url: string;
  text: string;
}

export interface WebsiteReading {
  channels: DiscoveredChannel[];
  pages: WebsitePage[];
  /** Phrase on the site that names a blood bank / transfusion service, with the page it was on. */
  bloodBankEvidence: { phrase: string; url: string } | null;
  reachable: boolean;
}

/**
 * Reads an institution's own website: robots.txt first, then the homepage and
 * at most one same-host contact page. Explicit mailto:/tel: links and
 * labelled contacts in the text become official_website channels (unverified).
 */
export async function readWebsite(website: string, options: { userAgent: string; timeoutMs: number }): Promise<WebsiteReading> {
  const empty: WebsiteReading = { channels: [], pages: [], bloodBankEvidence: null, reachable: false };
  let origin: URL;
  try {
    origin = new URL(website);
  } catch {
    return empty;
  }
  try {
    const robots = await safeFetchText(new URL("/robots.txt", origin).toString(), { ...options, maxBytes: 64 * 1024, accept: "text/plain" }).catch(() => null);
    const robotsTxt = robots && robots.status === 200 ? robots.text : "";
    const pagesToRead = [origin.toString()];
    const emails = new Map<string, string>();
    const phones = new Map<string, string>();
    const pages: WebsitePage[] = [];
    let bloodBankEvidence: WebsiteReading["bloodBankEvidence"] = null;
    let reachable = false;
    for (let i = 0; i < pagesToRead.length && i < 2; i++) {
      const page = new URL(pagesToRead[i]);
      if (!robotsAllows(robotsTxt, page.pathname)) continue;
      const res = await safeFetchText(page.toString(), options);
      if (res.status < 400) reachable = true;
      if (res.status !== 200 || !/html/i.test(res.contentType)) continue;
      const found = extractContactLinks(res.text, res.url);
      const text = htmlToText(res.text);
      const fromText = extractFromText(text);
      for (const e of [...found.emails, ...fromText.emails]) if (!emails.has(e)) emails.set(e, res.url);
      for (const p of [...found.phones, ...fromText.phones]) if (!phones.has(p)) phones.set(p, res.url);
      if (!bloodBankEvidence && fromText.mentionsBloodBank) bloodBankEvidence = { phrase: fromText.mentionsBloodBank, url: res.url };
      pages.push({ url: res.url, text });
      if (i === 0 && found.contactPages[0]) pagesToRead.push(found.contactPages[0]);
    }
    return {
      channels: [
        ...[...emails].slice(0, MAX_PER_TYPE).map(([value, sourceUrl]) => ({ type: "email" as const, value, source: "official_website" as const, sourceUrl })),
        ...[...phones].slice(0, MAX_PER_TYPE).map(([value, sourceUrl]) => ({ type: "phone" as const, value, source: "official_website" as const, sourceUrl })),
      ],
      pages,
      bloodBankEvidence,
      reachable,
    };
  } catch (error) {
    logger.warn("discovery.website_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return empty;
  }
}

/** Official contact channels only (kept for callers that don't need the page text). */
export async function contactsFromWebsite(website: string, options: { userAgent: string; timeoutMs: number }): Promise<DiscoveredChannel[]> {
  return (await readWebsite(website, options)).channels;
}
