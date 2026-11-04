import { describe, expect, it } from "vitest";
import { resolveSessionDir } from "@/worker/whatsapp/session-dir";

describe("resolveSessionDir", () => {
  it("resolves relative paths against the project root", () => {
    expect(resolveSessionDir(".data/whatsapp-session", "/srv/app")).toBe("/srv/app/.data/whatsapp-session");
  });
  it.each(["public", "public/wa", ".next/cache", "src/session", "./public/../public/x"])("refuses %s", (dir) => {
    expect(() => resolveSessionDir(dir, "/srv/app")).toThrow(/must not be inside/);
  });
  it("allows sibling names that only share a prefix", () => {
    expect(resolveSessionDir("publicity", "/srv/app")).toBe("/srv/app/publicity");
  });
});
