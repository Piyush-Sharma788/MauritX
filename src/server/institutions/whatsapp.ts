import "server-only";
import { randomUUID } from "node:crypto";
import { BLOOD_GROUP_LABELS, type BloodGroup } from "@/features/donors/schemas";
import { parseBloodGroup } from "@/features/donors/parse";
import { formatIstShort, parseComponent } from "@/features/requests/parse";
import { COMPONENT_LABELS, OPEN_STATUSES, STATUS_LABELS, type Component } from "@/features/requests/schemas";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii, phoneLookupToken } from "@/lib/security/crypto";
import type { InboundMessage } from "@/server/conversations/bot";
import { verifiedInstitutionContact } from "@/server/messaging/eligibility";
import { queueBotReplies } from "@/server/messaging/queue";
import { INSTITUTION_HELP_TEXT } from "@/server/messaging/templates";
import { AvailabilityReport } from "@/server/models/availability-report";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { applyTransition, expireOverdueRequests, type RequestRecord } from "@/server/requests/service";
import { findRequestId } from "@/server/requests/whatsapp";
import { recordAudit } from "@/server/services/audit";

/**
 * WhatsApp commands for verified hospital and blood bank contacts. Every
 * command re-checks, at the time it runs, that the contact and institution
 * are both verified and that the request is linked to that institution.
 */

export const INSTITUTION_KEYWORDS = new Set(["REQUESTS", "ACK", "ACKNOWLEDGE", "AVAILABLE", "FULFILLED", "PARTIAL", "STATUS", "HELP"]);
const PRIVILEGED = new Set(["REQUESTS", "ACK", "ACKNOWLEDGE", "FULFILLED", "PARTIAL"]);

export interface AvailabilityLine {
  bloodGroup: Exclude<BloodGroup, "unknown">;
  component: Component;
  units: number;
}

/** "AVAILABLE O+ PRBC 3", "available AB neg platelets 0", "AVAILABLE B+ whole blood NONE". */
export function parseAvailabilityLine(text: string): AvailabilityLine | null {
  const m = /^\s*AVAILABLE\s+(AB|A|B|O|0)\s*(\+|-|−|POS(?:ITIVE)?|NEG(?:ATIVE)?|\+VE|-VE)\s+(.+?)\s+(\d{1,3}|NONE|NIL)\s*(?:UNITS?)?\s*$/i.exec(text);
  if (!m) return null;
  const group = parseBloodGroup(`${m[1]}${m[2]}`);
  const component = parseComponent(m[3]);
  const units = /^(NONE|NIL)$/i.test(m[4]) ? 0 : Number(m[4]);
  if (!group || group === "unknown" || !component || units > 500) return null;
  return { bloodGroup: group, component, units };
}

const reply = (msg: InboundMessage, texts: string[]) => queueBotReplies(msg.fromE164, msg.providerMessageId, texts);

const NOT_AUTHORISED =
  "This number isn't authorised for MarutiX institutional access. Hospitals and blood banks are verified by the MarutiX team first. Please contact MarutiX to get your number verified.";

/**
 * Handles an institutional command. Returns false when the message isn't
 * one, or when an unprivileged word (STATUS, AVAILABLE, HELP) comes from a
 * number that isn't a verified institution contact, so donors keep their
 * own meaning of those words.
 */
export async function handleInstitutionCommand(msg: InboundMessage, keyword: string, now = new Date()): Promise<boolean> {
  if (msg.input.type !== "text") return false;
  const text = msg.input.text.trim();
  const first = keyword.split(" ")[0];
  if (!INSTITUTION_KEYWORDS.has(first)) return false;

  await connectToDatabase();
  const lookup = phoneLookupToken(msg.fromE164);
  const actor = await verifiedInstitutionContact(lookup);
  if (!actor) {
    const privileged = PRIVILEGED.has(first) || (first === "AVAILABLE" && parseAvailabilityLine(text) !== null);
    if (!privileged) return false;
    await recordAudit({ action: "institution.access_denied", outcome: "failure", requestId: randomUUID(), resourceType: "institution_contact", resourceId: first });
    await reply(msg, [NOT_AUTHORISED]);
    return true;
  }

  const { contact, institution } = actor;
  const linked = (publicRequestId: string | null) =>
    EmergencyRequest.findOne({ institutionId: institution._id, ...(publicRequestId ? { publicRequestId } : {}) }).sort({ createdAt: -1 }).lean() as Promise<RequestRecord | null>;
  await expireOverdueRequests(now);

  switch (first) {
    case "HELP":
      await reply(msg, [`${institution.displayName}\n${INSTITUTION_HELP_TEXT}`]);
      return true;

    case "REQUESTS": {
      const open = (await EmergencyRequest.find({ institutionId: institution._id, status: { $in: OPEN_STATUSES } }).sort({ requiredBy: 1 }).limit(10).lean()) as RequestRecord[];
      if (open.length === 0) {
        await reply(msg, [`No open MarutiX requests are linked to ${institution.displayName} right now.`]);
        return true;
      }
      await reply(msg, [
        [
          `Open requests for ${institution.displayName}:`,
          ...open.map(
            (r) =>
              `• ${r.publicRequestId} · ${STATUS_LABELS[r.status]} · ${r.bloodGroup === "unknown" ? "group TBC" : BLOOD_GROUP_LABELS[r.bloodGroup]} · ${r.unitsRequested} × ${COMPONENT_LABELS[r.component]} · by ${formatIstShort(r.requiredBy)} · interested donors: ${r.responseStats?.interested ?? 0}${r.institutionAcknowledgedAt ? " · acknowledged" : ""}`,
          ),
          "Reply ACK <ID> to acknowledge, or STATUS <ID> for details.",
        ].join("\n"),
      ]);
      return true;
    }

    case "STATUS": {
      const id = findRequestId(text);
      if (id) {
        const r = await linked(id);
        if (!r) {
          await reply(msg, ["That request isn't linked to your institution."]);
          return true;
        }
        await reply(msg, [
          [
            `${r.publicRequestId}: ${STATUS_LABELS[r.status]}`,
            `${r.bloodGroup === "unknown" ? "Group to be confirmed" : BLOOD_GROUP_LABELS[r.bloodGroup]} · ${r.unitsRequested} × ${COMPONENT_LABELS[r.component]} · by ${formatIstShort(r.requiredBy)}`,
            `Acknowledged by your institution: ${r.institutionAcknowledgedAt ? formatIstShort(r.institutionAcknowledgedAt) : "not yet"}`,
            `Donor alerts queued: ${r.responseStats?.alertsQueued ?? 0} · interested: ${r.responseStats?.interested ?? 0} · unavailable: ${r.responseStats?.unavailable ?? 0}`,
            "Interest is not a confirmed donation.",
          ].join("\n"),
        ]);
        return true;
      }
      const [openCount, unacknowledged, latest] = await Promise.all([
        EmergencyRequest.countDocuments({ institutionId: institution._id, status: { $in: OPEN_STATUSES } }),
        EmergencyRequest.countDocuments({ institutionId: institution._id, status: { $in: OPEN_STATUSES }, institutionAcknowledgedAt: null }),
        AvailabilityReport.findOne({ institutionId: institution._id }).sort({ reportedAt: -1 }).lean(),
      ]);
      await reply(msg, [
        [
          `${institution.displayName} (verified ${institution.type === "blood_bank" ? "blood bank" : "hospital"})`,
          `Your role: ${contact.role}`,
          `Open linked requests: ${openCount} (${unacknowledged} not acknowledged yet)`,
          latest
            ? `Last availability report: ${latest.bloodGroup} ${COMPONENT_LABELS[latest.component]} ${latest.status === "available" ? `${latest.units ?? "?"} units` : "none"} at ${formatIstShort(latest.reportedAt)}`
            : "No availability reported yet.",
        ].join("\n"),
      ]);
      return true;
    }

    case "ACK":
    case "ACKNOWLEDGE": {
      const id = findRequestId(text);
      const r = id ? await linked(id) : null;
      if (!r || !OPEN_STATUSES.includes(r.status)) {
        await reply(msg, [id ? "That request isn't open or isn't linked to your institution." : "Please include the request ID, for example ACK MX-7K3Q9P2A."]);
        return true;
      }
      const result = await EmergencyRequest.updateOne(
        { _id: r._id, institutionId: institution._id, institutionAcknowledgedAt: null },
        { $set: { institutionAcknowledgedAt: now, institutionAcknowledgedBy: contact._id } },
      );
      if (result.modifiedCount === 1) {
        await recordAudit({ action: "request.institution_acknowledged", outcome: "success", requestId: randomUUID(), resourceType: "emergency_request", resourceId: `${r.publicRequestId}:${contact._id.toString()}` });
      }
      await reply(msg, [result.modifiedCount === 1 ? `Acknowledged ${r.publicRequestId}. Thank you.` : `${r.publicRequestId} was already acknowledged.`]);
      return true;
    }

    case "AVAILABLE": {
      const line = parseAvailabilityLine(text);
      if (!line) {
        await reply(msg, ["Please use: AVAILABLE <blood group> <component> <units>, for example AVAILABLE O+ PRBC 3, or AVAILABLE B- platelets 0 if you have none."]);
        return true;
      }
      await AvailabilityReport.create({
        institutionId: institution._id,
        contactId: contact._id,
        bloodGroup: line.bloodGroup,
        component: line.component,
        status: line.units > 0 ? "available" : "unavailable",
        ...(line.units > 0 ? { units: line.units } : {}),
        source: "whatsapp",
        reportedAt: now,
      });
      await recordAudit({ action: "institution.availability_reported", outcome: "success", requestId: randomUUID(), resourceType: "institution", resourceId: institution._id.toString() });
      await reply(msg, [
        `Recorded at ${formatIstShort(now)}: ${line.bloodGroup} ${COMPONENT_LABELS[line.component]}, ${line.units > 0 ? `${line.units} unit(s)` : "none available"}, reported by ${decryptPii(contact.nameEncrypted).split(" ")[0]}. Coordinators see this as your institution's report with its time, not as confirmed live stock.`,
      ]);
      return true;
    }

    case "FULFILLED":
    case "PARTIAL": {
      if (contact.role !== "coordinator") {
        await recordAudit({ action: "institution.access_denied", outcome: "failure", requestId: randomUUID(), resourceType: "institution_contact", resourceId: `${first}:not_coordinator` });
        await reply(msg, ["Only your institution's verified coordinator can confirm fulfilment. Please ask them, or contact MarutiX."]);
        return true;
      }
      const id = findRequestId(text);
      const r = id ? await linked(id) : null;
      if (!r) {
        await reply(msg, [id ? "That request isn't linked to your institution." : `Please include the request ID, for example ${first} MX-7K3Q9P2A.`]);
        return true;
      }
      const to = first === "FULFILLED" ? "fulfilled" : "partially_fulfilled";
      try {
        await applyTransition(r, to, { type: "institution", contactId: contact._id, note: `Reported by ${institution.displayName} on WhatsApp` }, { requestId: randomUUID() }, now);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await reply(msg, [`${r.publicRequestId} can't be marked ${STATUS_LABELS[to].toLowerCase()} now (it is ${STATUS_LABELS[r.status].toLowerCase()}).`]);
        return true;
      }
      await reply(msg, [
        `${r.publicRequestId} marked ${STATUS_LABELS[to].toLowerCase()}. ${to === "fulfilled" ? "Further donor alerts for it have been stopped." : "Alerts continue for the remaining need."} Thank you.`,
      ]);
      return true;
    }
  }
  return false;
}
