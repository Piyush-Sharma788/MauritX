import { describe, expect, it } from "vitest";
import { serializeMessageId, serializeWid } from "@/worker/whatsapp/wa-ids";

describe("WhatsApp Web IDs", () => {
  it("rebuilds a message ID when WhatsApp no longer exposes _serialized", () => {
    // Shape observed from WhatsApp Web 2.3000.x through whatsapp-web.js 1.34.7.
    const key = { fromMe: true, remote: "123456789012345@lid", id: "3EB012DCDB24AAAB17E615", $1: "true_123456789012345@lid_3EB012DCDB24AAAB17E615" };
    expect(serializeMessageId(key)).toBe("true_123456789012345@lid_3EB012DCDB24AAAB17E615");
  });

  it("prefers _serialized when present, and gives the same ID for a message and its acks", () => {
    expect(serializeMessageId({ _serialized: "false_919876543210@c.us_ABC" })).toBe("false_919876543210@c.us_ABC");
    const sent = serializeMessageId({ fromMe: true, remote: { user: "919876543210", server: "c.us" }, id: "XYZ" });
    const ack = serializeMessageId({ fromMe: true, remote: "919876543210@c.us", id: "XYZ" });
    expect(sent).toBe(ack);
  });

  it("returns null instead of a bogus ID when the parts are missing", () => {
    expect(serializeMessageId(undefined)).toBeNull();
    expect(serializeMessageId({ fromMe: true, id: "XYZ" })).toBeNull();
    expect(serializeMessageId({ fromMe: true, remote: "919876543210@c.us" })).toBeNull();
  });

  it("serialises chat and contact IDs from strings or parts", () => {
    expect(serializeWid("919876543210@c.us")).toBe("919876543210@c.us");
    expect(serializeWid({ user: "919876543210", server: "c.us" })).toBe("919876543210@c.us");
    expect(serializeWid({ _serialized: "123@lid" })).toBe("123@lid");
    expect(serializeWid("not-an-id")).toBeNull();
    expect(serializeWid(null)).toBeNull();
  });
});
