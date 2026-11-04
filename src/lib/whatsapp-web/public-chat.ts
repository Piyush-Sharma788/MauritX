import "server-only";
import { normalizeIndianMobile } from "@/lib/validation/phone";

/**
 * The MarutiX pilot WhatsApp number people message to register. Public by
 * design. Read at render time; statically prerendered pages pick up a change
 * on the next build.
 */
export function marutixWhatsAppNumber(): string | null {
  const raw = (process.env.WHATSAPP_WEB_PUBLIC_NUMBER ?? "").trim();
  if (!raw) return null;
  const indian = normalizeIndianMobile(raw);
  if (indian) return indian.slice(1);
  const digits = raw.replace(/[\s()+-]/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}

/** wa.me link that opens the chat with "REGISTER" ready to send, or null if not configured. */
export function donorRegistrationChatUrl(): string | null {
  const number = marutixWhatsAppNumber();
  return number ? `https://wa.me/${number}?text=${encodeURIComponent("REGISTER")}` : null;
}
