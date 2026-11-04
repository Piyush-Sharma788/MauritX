import type {
  MessageLogResponse,
  QueueMessageResponse,
  WhatsAppQrResponse,
  WhatsAppStatusResponse,
} from "@/features/whatsapp/types";
import { apiRequest } from "@/lib/api/browser-client";

const BASE = "/api/v1/admin/whatsapp";

export const whatsappAdminApi = {
  status: () => apiRequest<WhatsAppStatusResponse>("GET", `${BASE}/status`),
  qr: () => apiRequest<WhatsAppQrResponse>("GET", `${BASE}/qr`),
  connect: (restart: boolean) => apiRequest<{ state: string }>("POST", `${BASE}/connect`, { body: { restart } }),
  logout: () => apiRequest<{ state: string }>("POST", `${BASE}/logout`),
  messages: () => apiRequest<MessageLogResponse>("GET", `${BASE}/messages?limit=25`),
  sendTest: (phone: string, text: string, idempotencyKey: string) =>
    apiRequest<QueueMessageResponse>("POST", `${BASE}/send-message`, {
      body: { phone, text },
      headers: { "Idempotency-Key": idempotencyKey },
    }),
};
