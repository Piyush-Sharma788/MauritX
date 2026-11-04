import mongoose from "mongoose";
import { connection } from "next/server";
import { connectToDatabase } from "@/lib/db/mongoose";

/**
 * GET /api/health: liveness + database readiness for container healthchecks
 * and post-deploy smoke tests. Reveals nothing beyond up/down.
 */
export async function GET() {
  await connection();
  const headers = { "Cache-Control": "no-store" };
  try {
    await connectToDatabase();
    await mongoose.connection.db?.admin().ping();
    return Response.json({ status: "ok", db: "up" }, { headers });
  } catch {
    // Also covers invalid configuration, so a bad deploy fails its healthcheck.
    return Response.json({ status: "unavailable", db: "down" }, { status: 503, headers });
  }
}
