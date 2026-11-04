import "server-only";
import type { CoordinationSummary, MatchingRunView, ResponseView } from "@/features/coordination/types";
import { AppError } from "@/lib/api/errors";
import { connectToDatabase } from "@/lib/db/mongoose";
import { coordinationSummary, listResponses } from "@/server/coordination/responses";
import { getLatestRun } from "@/server/matching/service";
import { EmergencyRequest } from "@/server/models/emergency-request";

export interface RequestCoordination {
  summary: CoordinationSummary;
  latestRun: MatchingRunView | null;
  responses: ResponseView[];
}

/** Everything the admin request page shows about matching, alerts and responses. */
export async function getRequestCoordination(publicRequestId: string): Promise<RequestCoordination> {
  await connectToDatabase();
  const request = await EmergencyRequest.findOne({ publicRequestId }, { status: 1, expiresAt: 1, institutionId: 1, institutionAcknowledgedAt: 1 }).lean();
  if (!request) throw new AppError(404, "NOT_FOUND", "We couldn't find that request.");
  const [summary, latestRun, responses] = await Promise.all([coordinationSummary(request), getLatestRun(request._id), listResponses(request._id)]);
  return { summary, latestRun, responses };
}
