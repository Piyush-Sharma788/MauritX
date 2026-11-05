import type { WhatsAppStatusResponse } from "@/features/whatsapp/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { getWhatsAppWebConfig } from "@/lib/whatsapp-web/config";
import { readConnectionStatus } from "@/server/whatsapp/connection-store";

/** GET /api/v1/admin/whatsapp/status: current WhatsApp Web pilot connection. Admin only. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin("whatsapp.read");
  return ok<WhatsAppStatusResponse>(ctx, await readConnectionStatus(getWhatsAppWebConfig()));
});
