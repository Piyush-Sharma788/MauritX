#!/usr/bin/env node
/**
 * CI dependency gate. Fails on any high or critical advisory in production
 * dependencies (`npm audit --omit=dev`) unless it is listed in
 * .github/audit-allowlist.json with an unexpired date AND every path to the
 * affected package goes through one of the entry's `onlyVia` top-level
 * dependencies. A new path (for example the web app starting to use the
 * vulnerable package directly) fails the gate even for an allowlisted advisory.
 *
 *   node scripts/audit-gate.mjs [--allowlist path]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BLOCKING = new Set(["high", "critical"]);
const argIndex = process.argv.indexOf("--allowlist");
const allowlistPath = argIndex > 0 ? process.argv[argIndex + 1] : ".github/audit-allowlist.json";

function npmJson(args) {
  try {
    return JSON.parse(execFileSync("npm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    // npm audit and npm explain exit non-zero when they have findings; the JSON is still on stdout.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

/** Top-level dependencies (direct dependencies of the project) through which this installed package is reached. */
function rootsOf(node, seen = new Set()) {
  const roots = new Set();
  for (const edge of node.dependents ?? []) {
    const from = edge.from ?? {};
    if (!from.name) {
      roots.add(edge.name);
      continue;
    }
    const key = `${from.name}@${from.version}@${from.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const r of rootsOf(from, seen)) roots.add(r);
  }
  return roots;
}

const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")).advisories ?? [];
const today = new Date().toISOString().slice(0, 10);
const audit = npmJson(["audit", "--omit=dev", "--json"]);

// advisory id -> { severity, title, packages: Map<package, affected install locations> }
const advisories = new Map();
for (const [pkg, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
    const id = String(via.url ?? via.source).split("/").pop();
    const entry = advisories.get(id) ?? { severity: via.severity, title: via.title, packages: new Map() };
    // Only the installed copies npm marks as affected (a patched copy elsewhere doesn't count).
    entry.packages.set(pkg, new Set(vuln.nodes ?? []));
    advisories.set(id, entry);
  }
}

const failures = [];
const accepted = [];
for (const [id, advisory] of advisories) {
  const allowed = allowlist.find((a) => a.id === id);
  if (!allowed) {
    failures.push(`${id} (${advisory.severity}) ${advisory.title} in ${[...advisory.packages.keys()].join(", ")}: not allowlisted`);
    continue;
  }
  if (!allowed.expires || allowed.expires < today) {
    failures.push(`${id}: allowlist entry expired on ${allowed.expires ?? "(no date)"}; re-review it`);
    continue;
  }
  for (const [pkg, locations] of advisory.packages) {
    const roots = new Set();
    for (const node of npmJson(["explain", pkg, "--json"])) {
      if (locations.size && !locations.has(node.location)) continue;
      for (const r of rootsOf(node)) roots.add(r);
    }
    const unexpected = [...roots].filter((r) => !allowed.onlyVia.includes(r));
    if (unexpected.length) failures.push(`${id}: ${pkg} is also reached through ${unexpected.join(", ")} (allowlisted only via ${allowed.onlyVia.join(", ")})`);
  }
  accepted.push(`${id} (${advisory.severity}) via ${allowed.onlyVia.join(", ")} until ${allowed.expires}: ${allowed.reason}`);
}

const stale = allowlist.filter((a) => !advisories.has(a.id)).map((a) => a.id);
const counts = audit.metadata?.vulnerabilities ?? {};
console.log(`npm audit (production deps): critical ${counts.critical ?? 0}, high ${counts.high ?? 0}, moderate ${counts.moderate ?? 0}, low ${counts.low ?? 0}`);
for (const line of accepted) console.log(`accepted: ${line}`);
if (stale.length) console.log(`note: allowlist entries no longer needed (remove them): ${stale.join(", ")}`);
if (failures.length) {
  console.error(`\nDependency gate FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("Dependency gate passed.");
