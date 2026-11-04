import type { WhatsAppQrResponse } from "@/features/whatsapp/types";
import { apiRoute, ok } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { whatsappWorker } from "@/lib/whatsapp-web/worker-client";

/** GET /api/v1/admin/whatsapp/qr: the current pairing QR as SVG. Admin only; never cached. */
export const GET = apiRoute(async (_request, ctx) => {
  await requireAdmin();
  return ok<WhatsAppQrResponse>(ctx, await whatsappWorker.getQr());
});
