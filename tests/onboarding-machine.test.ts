import { describe, expect, it } from "vitest";
import { parseBloodGroup, parseDonationDate, parseYesNo } from "@/features/donors/parse";
import { advance, promptFor, startSnapshot, startUpdateSnapshot, type BotInput, type Outcome, type Snapshot } from "@/server/conversations/onboarding-machine";

const text = (t: string): BotInput => ({ type: "text", text: t });

function run(answers: BotInput[], from: Snapshot = startSnapshot(false)) {
  let snapshot = from;
  let last: Outcome | null = null;
  for (const answer of answers) {
    last = advance(snapshot, answer);
    if (last.type !== "continue") return last;
    snapshot = last.snapshot;
  }
  return last!;
}

const HAPPY = [
  text("yes"),
  text("  Rahul   Sharma "),
  text("o positive"),
  text("Prayagraj"),
  text("Civil Lines"),
  { type: "location", latitude: 25.45678, longitude: 81.84321 } as BotInput,
  text("15-08-2025"),
  text("1"),
  text("YES"),
];

describe("onboarding state machine", () => {
  it("walks the happy path in order and asks for confirmation", () => {
    const beforeConfirm = run(HAPPY);
    expect(beforeConfirm.type).toBe("continue");
    if (beforeConfirm.type !== "continue") return;
    expect(beforeConfirm.snapshot.state).toBe("confirm");
    expect(beforeConfirm.replies[0]).toMatch(/Name: Rahul Sharma/);
    expect(beforeConfirm.replies[0]).toMatch(/Blood group: O\+/);

    const done = advance(beforeConfirm.snapshot, text("yes"));
    expect(done).toEqual({
      type: "complete",
      replies: [],
      data: {
        name: "Rahul Sharma",
        bloodGroup: "O+",
        city: "Prayagraj",
        locality: "Civil Lines",
        location: { latitude: 25.46, longitude: 81.84 }, // coarsened to ~1 km
        lastDonationDate: "2025-08-15",
        availableForRequests: true,
        notificationConsent: true,
      },
    });
  });

  it("re-asks with a helpful error on invalid input and keeps state", () => {
    const atBlood = run(HAPPY.slice(0, 2));
    if (atBlood.type !== "continue") throw new Error("unexpected");
    const bad = advance(atBlood.snapshot, text("purple"));
    expect(bad.type).toBe("continue");
    if (bad.type !== "continue") return;
    expect(bad.snapshot).toBe(atBlood.snapshot);
    expect(bad.replies[0]).toMatch(/didn't recognise that blood group/);
  });

  it("rejects free text where a location is expected, accepts SKIP, and rejects locations outside India", () => {
    const atLocation = run(HAPPY.slice(0, 5));
    if (atLocation.type !== "continue") throw new Error("unexpected");
    expect(atLocation.snapshot.state).toBe("location");
    expect((advance(atLocation.snapshot, text("near the temple")) as { replies: string[] }).replies[0]).toMatch(/share your location/);
    expect((advance(atLocation.snapshot, { type: "location", latitude: 51.5, longitude: -0.12 }) as { replies: string[] }).replies[0]).toMatch(/outside India/);
    const skipped = advance(atLocation.snapshot, text("skip"));
    expect(skipped.type === "continue" && skipped.snapshot.state).toBe("last_donation");
    expect(skipped.type === "continue" && skipped.snapshot.data.location).toBeNull();
  });

  it("supports BACK through history without losing earlier answers", () => {
    const atCity = run(HAPPY.slice(0, 3));
    if (atCity.type !== "continue") throw new Error("unexpected");
    expect(atCity.snapshot.state).toBe("city");
    const back = advance(atCity.snapshot, text("back"));
    if (back.type !== "continue") throw new Error("unexpected");
    expect(back.snapshot.state).toBe("blood_group");
    expect(back.snapshot.data.name).toBe("Rahul Sharma");
    const backAgain = advance(back.snapshot, text("BACK"));
    if (backAgain.type !== "continue") throw new Error("unexpected");
    expect(backAgain.snapshot.state).toBe("name");
    const atStart = advance(backAgain.snapshot, text("back"));
    expect(atStart.type === "continue" && atStart.replies[0]).toMatch(/first question/);
  });

  it("cancels on NO at the start or CANCEL at any step, and restarts on RESTART", () => {
    expect(advance(startSnapshot(false), text("no")).type).toBe("cancelled");
    const mid = run(HAPPY.slice(0, 4));
    if (mid.type !== "continue") throw new Error("unexpected");
    expect(advance(mid.snapshot, text("cancel")).type).toBe("cancelled");
    const restarted = advance(mid.snapshot, text("restart"));
    expect(restarted.type === "continue" && restarted.snapshot).toEqual({ flow: "donor_onboarding", state: "name", history: [], data: {} });
  });

  it("answers HELP without moving", () => {
    const mid = run(HAPPY.slice(0, 3));
    if (mid.type !== "continue") throw new Error("unexpected");
    const help = advance(mid.snapshot, text("help"));
    expect(help.type === "continue" && help.snapshot).toBe(mid.snapshot);
    expect(help.type === "continue" && help.replies[1]).toBe(promptFor(mid.snapshot));
  });

  it("does not complete without explicit YES at confirmation", () => {
    const beforeConfirm = run(HAPPY);
    if (beforeConfirm.type !== "continue") throw new Error("unexpected");
    expect(advance(beforeConfirm.snapshot, text("no")).type).toBe("continue");
    expect(advance(beforeConfirm.snapshot, text("maybe")).type).toBe("continue");
  });

  it("records 'no alerts' when the donor declines consent", () => {
    const answers = [...HAPPY.slice(0, 8), text("no"), text("yes")];
    const done = run(answers);
    expect(done.type === "complete" && done.data.notificationConsent).toBe(false);
  });
});

describe("update flow", () => {
  it("picks a detail from the menu and returns only that change", () => {
    const pick = advance(startUpdateSnapshot(), text("2"));
    if (pick.type !== "continue") throw new Error("unexpected");
    expect(pick.snapshot.state).toBe("blood_group");
    expect(pick.replies[0]).toMatch(/^What's your blood group/); // no "Thanks, ." without a name
    expect(advance(pick.snapshot, text("o neg"))).toEqual({ type: "updated", changes: { bloodGroup: "O-" }, replies: [] });
  });

  it("asks for locality after city, and supports BACK to the menu and CANCEL", () => {
    const city = advance(startUpdateSnapshot(), text("3"));
    if (city.type !== "continue") throw new Error("unexpected");
    const locality = advance(city.snapshot, text("Jaipur"));
    expect(locality.type === "continue" && locality.snapshot.state).toBe("locality");
    if (locality.type !== "continue") return;
    expect(advance(locality.snapshot, text("Malviya Nagar"))).toMatchObject({ type: "updated", changes: { city: "Jaipur", locality: "Malviya Nagar" } });
    const back = advance(locality.snapshot, text("back"));
    expect(back.type === "continue" && back.snapshot.state).toBe("update_menu");
    expect(advance(locality.snapshot, text("cancel")).type).toBe("cancelled");
  });

  it("rejects menu choices outside 1–7 and lets SKIP clear the location", () => {
    expect((advance(startUpdateSnapshot(), text("9")) as { replies: string[] }).replies[0]).toMatch(/number from 1 to 7/);
    const loc = advance(startUpdateSnapshot(), text("4"));
    if (loc.type !== "continue") throw new Error("unexpected");
    expect(advance(loc.snapshot, text("skip"))).toEqual({ type: "updated", changes: { location: null }, replies: [] });
  });
});

describe("reply parsers", () => {
  it.each([
    ["O+", "O+"], ["o positive", "O+"], ["0+", "O+"], ["AB -ve", "AB-"], ["ab neg", "AB-"], ["B POS", "B+"], ["a-", "A-"], ["not sure", "unknown"],
  ])("blood group %s -> %s", (input, expected) => expect(parseBloodGroup(input)).toBe(expected));

  it.each(["C+", "A", "positive", "AB+-"])("rejects blood group %s", (input) => expect(parseBloodGroup(input)).toBeNull());

  it("parses dates in Indian formats and rejects impossible or future dates", () => {
    expect(parseDonationDate("5/3/2024")).toBe("2024-03-05");
    expect(parseDonationDate("2024-03-05")).toBe("2024-03-05");
    expect(parseDonationDate("31-02-2024")).toBeNull();
    expect(parseDonationDate("01-01-2999")).toBeNull();
    expect(parseDonationDate("yesterday")).toBeNull();
  });

  it("understands common yes/no replies including Hinglish", () => {
    expect(parseYesNo("haan")).toBe(true);
    expect(parseYesNo("Nahi")).toBe(false);
    expect(parseYesNo("whatever")).toBeNull();
  });
});
