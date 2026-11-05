import "server-only";
import { Types } from "mongoose";
import type { AuditEntryView, ConversationLogEntry, FailedMessageView, OperationsOverview } from "@/features/coordination/types";
import { getAiConfig } from "@/lib/ai/config";
import { connectToDatabase } from "@/lib/db/mongoose";
import { decryptPii } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/validation/phone";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { RETRYABLE_FAILURES } from "@/server/coordination/alerts";
import { readMetrics } from "@/server/metrics/bot-metrics";
import { AUDIT_ACTIONS, AuditLog } from "@/server/models/audit-log";
import { EmergencyRequest } from "@/server/models/emergency-request";
import { Institution } from "@/server/models/institution";
import { NotificationEvent } from "@/server/models/notification-event";
import { RequestResponse } from "@/server/models/request-response";
import { User } from "@/server/models/user";
import { WhatsAppConversation } from "@/server/models/whatsapp-conversation";
import { expireOverdueRequests } from "@/server/requests/service";
import { recordAudit } from "@/server/services/audit";
import { getMessagingSettings } from "@/server/settings/service";
import { readConnectionStatus } from "@/server/whatsapp/connection-store";

/**
 * Admin control centre read models. Every number is counted from database
 * records at request time; nothing is estimated or cached.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (d?: Date | null) => (d ? d.toISOString() : null);

function aiSummary(): OperationsOverview["ai"] {
  try {
    const config = getAiConfig();
    return { provider: config.provider, model: config.provider === "none" ? null : config.model };
  } catch {
    return { provider: "none", model: null };
  }
}

/** The pilot may not be configured at all; the dashboard then shows it as offline. */
async function whatsappStatus(now: Date): Promise<OperationsOverview["whatsapp"]> {
  try {
    return await readConnectionStatus(getWhatsAppWebConfig(), now);
  } catch {
    return {
      provider: "whatsapp_web", state: "disconnected", workerOnline: false, busy: false, account: null,
      lastReadyAt: null, lastDisconnectedAt: null, lastDisconnectReason: null,
      lastError: "WhatsApp Web pilot isn't configured (WHATSAPP_WEB_WORKER_SECRET).", updatedAt: null,
      limits: { maxMessagesPerHour: 0, minSendIntervalMs: 0 },
    };
  }
}

export async function getOperationsOverview(now = new Date()): Promise<OperationsOverview> {
  await connectToDatabase();
  await expireOverdueRequests(now);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  const [whatsapp, settings, metrics, flows, queueRows, failed24h, suppressed24h, requestRows, alertRows, responseRows, confirmed7, fulfilled7, institutionRows] = await Promise.all([
    whatsappStatus(now),
    getMessagingSettings(),
    readMetrics(now),
    WhatsAppConversation.aggregate<{ _id: string; count: number }>([{ $match: { status: "active" } }, { $group: { _id: "$flow", count: { $sum: 1 } } }]),
    NotificationEvent.aggregate<{ _id: string; count: number }>([{ $match: { status: { $in: ["queued", "sending"] } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    NotificationEvent.countDocuments({ status: "failed", failedAt: { $gte: dayAgo } }),
    NotificationEvent.countDocuments({ status: "suppressed", failedAt: { $gte: dayAgo } }),
    EmergencyRequest.aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    NotificationEvent.aggregate<{ _id: string; count: number }>([
      { $match: { kind: "emergency_request", createdAt: { $gte: weekAgo }, status: { $ne: "suppressed" } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    RequestResponse.aggregate<{ _id: string; count: number }>([{ $match: { respondedAt: { $gte: weekAgo } } }, { $group: { _id: "$response", count: { $sum: 1 } } }]),
    RequestResponse.countDocuments({ coordinationHistory: { $elemMatch: { status: "donation_confirmed", at: { $gte: weekAgo } } } }),
    EmergencyRequest.countDocuments({ status: "fulfilled", closedAt: { $gte: weekAgo } }),
    Institution.aggregate<{ _id: string; count: number }>([{ $group: { _id: "$verificationStatus", count: { $sum: 1 } } }]),
  ]);

  const count = (rows: { _id: string; count: number }[], key: string) => rows.find((r) => r._id === key)?.count ?? 0;
  const conversationsByFlow = Object.fromEntries(flows.map((f) => [f._id, f.count]));
  return {
    whatsapp,
    settings,
    ai: aiSummary(),
    bot: {
      activeConversations: flows.reduce((sum, f) => sum + f.count, 0),
      conversationsByFlow,
      inboundToday: metrics.today.inbound_processed ?? 0,
      inbound7Days: metrics.last7Days.inbound_processed ?? 0,
      droppedWhileDisabled7Days: metrics.last7Days.inbound_dropped_disabled ?? 0,
      botErrors7Days: metrics.last7Days.bot_errors ?? 0,
      aiCalls7Days: metrics.last7Days.ai_calls ?? 0,
      aiErrors7Days: metrics.last7Days.ai_errors ?? 0,
      aiRejected7Days: metrics.last7Days.ai_rejected_output ?? 0,
    },
    queue: { queued: count(queueRows, "queued"), sending: count(queueRows, "sending"), failed24h, suppressed24h },
    coordination: {
      activeRequests: count(requestRows, "active") + count(requestRows, "partially_fulfilled"),
      verifiedRequests: count(requestRows, "verified"),
      pendingVerification: count(requestRows, "pending_verification"),
      alertsAttempted7Days: alertRows.reduce((sum, r) => sum + r.count, 0),
      // Only what WhatsApp acknowledged reaching the phone.
      alertsDelivered7Days: count(alertRows, "delivered") + count(alertRows, "read"),
      interested7Days: count(responseRows, "interested"),
      unavailable7Days: count(responseRows, "unavailable"),
      donationsConfirmed7Days: confirmed7,
      fulfilled7Days: fulfilled7,
    },
    institutions: { verified: count(institutionRows, "verified"), pending: count(institutionRows, "pending") },
  };
}

export async function listFailedMessages(limit = 25): Promise<FailedMessageView[]> {
  await connectToDatabase();
  const docs = await NotificationEvent.find({ status: "failed" }, { bodyEncrypted: 0 }).sort({ failedAt: -1 }).limit(limit).lean();
  const requestIds = [...new Set(docs.map((d) => d.requestId).filter((id): id is string => Boolean(id && Types.ObjectId.isValid(id))))];
  const requests = await EmergencyRequest.find({ _id: { $in: requestIds } }, { publicRequestId: 1 }).lean();
  const publicId = new Map(requests.map((r) => [r._id.toString(), r.publicRequestId]));
  return docs.map((d) => ({
    id: d._id.toString(),
    kind: d.kind,
    recipient: d.recipientPhoneEncrypted ? maskPhone(decryptPii(d.recipientPhoneEncrypted)) : "Erased",
    failureCode: d.failureCode ?? null,
    failedAt: iso(d.failedAt),
    attempts: d.attempts,
    requestPublicId: d.requestId ? (publicId.get(d.requestId) ?? null) : null,
    retryable: d.kind === "emergency_request" && RETRYABLE_FAILURES.has(d.failureCode ?? ""),
  }));
}

/**
 * Conversation metadata for admins: which flow and step each number is at.
 * Message content is never stored (WHATSAPP_BOT.md §2a), so none can be
 * shown. Every view is audit-logged.
 */
export async function listConversations(adminUserId: Types.ObjectId, requestId: string, cursor?: string, limit = 25): Promise<{ conversations: ConversationLogEntry[]; nextCursor: string | null }> {
  await connectToDatabase();
  const filter = cursor && Types.ObjectId.isValid(cursor) ? { _id: { $lt: new Types.ObjectId(cursor) } } : {};
  const docs = await WhatsAppConversation.find(filter, { dataEncrypted: 0, history: 0 }).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = docs.slice(0, limit);
  const users = await User.find({ _id: { $in: page.map((d) => d.userId).filter(Boolean) } }, { phoneEncrypted: 1 }).lean();
  const phone = new Map(users.map((u) => [u._id.toString(), maskPhone(decryptPii(u.phoneEncrypted))]));
  await recordAudit({ action: "conversations.viewed_by_admin", outcome: "success", requestId, actorUserId: adminUserId, resourceType: "whatsapp_conversation" });
  return {
    conversations: page.map((d) => ({
      id: d._id.toString(),
      // Numbers without an account are stored only as a keyed hash, so they can't be shown at all.
      maskedPhone: d.userId ? (phone.get(d.userId.toString()) ?? "Unknown") : "Not registered",
      flow: d.flow,
      state: d.state,
      status: d.status,
      lastInboundAt: iso(d.lastInboundAt),
      updatedAt: (d as { updatedAt: Date }).updatedAt.toISOString(),
    })),
    nextCursor: docs.length > limit ? page[page.length - 1]._id.toString() : null,
  };
}

export async function listAuditEvents(filter: { action?: string; cursor?: string; limit?: number }): Promise<{ events: AuditEntryView[]; nextCursor: string | null }> {
  await connectToDatabase();
  const limit = filter.limit ?? 50;
  const query: Record<string, unknown> = {};
  if (filter.action && (AUDIT_ACTIONS as readonly string[]).includes(filter.action)) query.action = filter.action;
  if (filter.cursor && Types.ObjectId.isValid(filter.cursor)) query._id = { $lt: new Types.ObjectId(filter.cursor) };
  const docs = await AuditLog.find(query).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = docs.slice(0, limit);
  const actors = await User.find({ _id: { $in: page.map((d) => d.actorUserId).filter(Boolean) } }, { role: 1, displayName: 1 }).lean();
  const actorLabel = new Map(actors.map((u) => [u._id.toString(), `${u.role}${u.displayName ? ` · ${u.displayName.split(" ")[0]}` : ""}`]));
  return {
    events: page.map((d) => ({
      id: d._id.toString(),
      action: d.action,
      outcome: d.outcome,
      actor: d.actorUserId ? (actorLabel.get(d.actorUserId.toString()) ?? "user") : null,
      resourceType: d.resourceType ?? null,
      resourceId: d.resourceId ?? null,
      createdAt: (d as { createdAt: Date }).createdAt.toISOString(),
    })),
    nextCursor: docs.length > limit ? page[page.length - 1]._id.toString() : null,
  };
}
