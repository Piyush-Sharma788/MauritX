import { describe, expect, it } from "vitest";
import { classifyByKeywords, normaliseForIntent } from "@/server/ai/interpret";
import { parseMenuChoice, WELCOME_MENU_TEXT } from "@/server/conversations/menu";
import { SendPacer } from "@/server/messaging/pacing";
import { MAX_MERGED_REPLY_LENGTH, mergeReplies } from "@/server/messaging/queue";

/** Deterministic parts of the bot: intent keywords, the first-contact menu, reply merging and pacing. No database. */

describe("keyword intent classifier (English, Hindi, Hinglish, typos)", () => {
  it.each([
    // Requests
    ["Need B positive blood urgently in Prayagraj", "create_request"],
    ["khoon chahiye", "create_request"],
    ["blood ki zarurat hai", "create_request"],
    ["Blood ki jarurat h", "create_request"],
    ["papa ko 2 unit B+ chahiye", "create_request"],
    ["mujhe O- chahiye abhi", "create_request"],
    ["urjent blod needed", "create_request"],
    ["need platlets for my mother", "create_request"],
    ["donor chahiye", "create_request"],
    ["cancer patient needs blood", "create_request"],
    // Donors
    ["donor banna hai", "register_donor"],
    ["I want to donate blood", "register_donor"],
    ["main blood dena chahta hoon", "register_donor"],
    ["how to become a donor", "register_donor"],
    ["regster me as donar", "register_donor"],
    // Tracking
    ["mera request kaha tak pahucha", "track_request"],
    ["meri request kahan tak pahunchi?", "track_request"],
    ["koi donor mila?", "track_request"],
    ["trak my request", "track_request"],
    ["any update?", "track_request"],
    // Cancelling
    ["ab blood nahi chahiye", "cancel_request"],
    ["cancel my request", "cancel_request"],
    // Consent: proposed only, the person confirms with the exact command
    ["band karo", "stop_messages"],
    ["message mat bhejo", "stop_messages"],
    ["please stop messaging me", "stop_messages"],
    ["alerts band karo", "pause_alerts"],
    ["alerts wapas chalu karo", "resume_alerts"],
    // Alerts
    ["I can help", "donor_interested"],
    ["main aa sakta hoon", "donor_interested"],
    ["nahi aa sakta", "donor_unavailable"],
    ["where is the hospital", "more_info"],
    // Other
    ["meri profile dikhao", "view_profile"],
    ["change my city", "update_profile"],
    ["madad", "help"],
    ["hiii", "greeting"],
    ["Namaste ji", "greeting"],
    ["asdfgh qwerty", "other"],
    ["what a nice truck", "other"],
  ])("%s → %s", (text, intent) => {
    expect(classifyByKeywords(text).intent).toBe(intent);
  });

  it("corrects typos without touching real words", () => {
    expect(normaliseForIntent("bloooood URJENT!!")).toBe("blood urgent");
    expect(normaliseForIntent("emergancy plateletes")).toBe("emergency platelets");
    expect(normaliseForIntent("cancer truck")).toBe("cancer truck");
  });

  it("extracts details from Hinglish requests", () => {
    const r = classifyByKeywords("Lucknow mein do unit B+ khoon chahiye turant");
    expect(r.entities).toMatchObject({ bloodGroup: "B+", units: 2, city: "Lucknow", requiredBy: "now" });
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(classifyByKeywords("donor banna hai").requires_confirmation).toBe(true);
  });
});

describe("one-word commands with typos", () => {
  it.each([["reqest", "create_request"], ["requst", "create_request"], ["regster", "register_donor"], ["trak", "track_request"]])("%s → %s", (text, intent) => {
    expect(classifyByKeywords(text).intent).toBe(intent);
  });
});

describe("Hindi in Devanagari script", () => {
  it.each([
    ["मुझे खून चाहिए O+ दिल्ली", "create_request"],
    ["मरीज के लिए ब्लड की जरूरत है", "create_request"],
    ["डोनर बनना है", "register_donor"],
    ["मैं रक्तदान करना चाहता हूँ", "register_donor"],
    ["मेरा रिक्वेस्ट कहाँ तक पहुँचा", "track_request"],
    ["मदद", "help"],
    ["नमस्ते", "greeting"],
  ])("%s → %s", (text, intent) => {
    expect(classifyByKeywords(text).intent).toBe(intent);
  });

  it("reads details from Devanagari messages", () => {
    const r = classifyByKeywords("मुझे खून चाहिए O+ दो यूनिट अभी");
    expect(r.entities.bloodGroup).toBe("O+");
    expect(r.entities.units).toBe(2);
    expect(r.entities.requiredBy).toBe("now");
  });

  it("only replaces whole Hindi words, and leaves Latin text alone", () => {
    // "दोस्त" (friend) starts with "दो" (two) but is a different word.
    expect(normaliseForIntent("दोस्त")).not.toContain("do");
    expect(normaliseForIntent("Need O+ blood")).toBe(normaliseForIntent("Need O+ blood"));
  });
});

describe("first-contact menu", () => {
  it.each([
    ["1", "request"], ["1.", "request"], ["REQUEST", "request"], ["ek", "request"], ["need blood", "request"],
    ["2", "donor"], ["register", "donor"], ["YES", "donor"], ["haan", "donor"], ["join", "donor"],
    ["3", "track"], ["track", "track"], ["teen", "track"],
    ["4", "help"], ["help", "help"], ["?", "help"],
    ["no", "decline"], ["nahi", "decline"],
    ["blood chahiye kal", null], ["hi", null], ["5", null],
  ])("%s → %s", (text, choice) => {
    expect(parseMenuChoice(text)).toBe(choice);
  });

  it("offers patients and donors the same four options and the safety lines", () => {
    expect(WELCOME_MENU_TEXT).toMatch(/1\. I need blood for a patient\n2\. I want to become a donor\n3\. Track my request\n4\. Help/);
    expect(WELCOME_MENU_TEXT).toMatch(/call 112/);
    expect(WELCOME_MENU_TEXT).toMatch(/Reply STOP anytime/);
    expect(WELCOME_MENU_TEXT.length).toBeLessThanOrEqual(MAX_MERGED_REPLY_LENGTH); // fits as an image caption
  });
});

describe("reply merging", () => {
  it("joins short parts with a blank line and keeps long ones separate", () => {
    expect(mergeReplies(["Intro.", "Question?"])).toEqual(["Intro.\n\nQuestion?"]);
    const long = "x".repeat(995);
    expect(mergeReplies(["Intro.", long, "Last?"])).toEqual(["Intro.", long, "Last?"]);
    expect(mergeReplies(["a".repeat(500), "b".repeat(400), "c".repeat(400)])).toEqual([`${"a".repeat(500)}\n\n${"b".repeat(400)}`, "c".repeat(400)]);
    expect(mergeReplies([long, long])).toHaveLength(2);
    expect(mergeReplies(["", "  ", "Only"])).toEqual(["Only"]);
  });
});

describe("send pacing (fake clock)", () => {
  const options = { replyIntervalMs: 1000, proactiveIntervalMs: 4000, idlePollMs: 2000, rateLimitedPollMs: 30_000 };

  it("lets replies follow each other quickly but keeps proactive messages 4 s apart", () => {
    const pacer = new SendPacer(options);
    let t = 0;
    expect(pacer.proactiveAllowed(t)).toBe(true);
    expect(pacer.delayAfter("sent", t)).toBe(1000); // a reply went out
    t += 1000;
    expect(pacer.proactiveAllowed(t)).toBe(false); // an alert must wait...
    expect(pacer.delayAfter("paced", t)).toBe(2000); // ...but no longer than needed (capped at the idle poll)
    t += 2000;
    expect(pacer.delayAfter("paced", t)).toBe(1000);
    t += 1000;
    expect(pacer.proactiveAllowed(t)).toBe(true);
    expect(pacer.delayAfter("suppressed", t)).toBe(0);
    expect(pacer.delayAfter("idle", t)).toBe(2000);
    expect(pacer.delayAfter("rate_limited", t)).toBe(30_000);
  });
});
