import type { BloodGroup } from "@/features/donors/schemas";

/** API views for the donor dashboard. Browser-safe. */

export type NotificationStatus = "not_enabled" | "active" | "paused" | "opted_out";

export interface DonorProfileView {
  name: string;
  maskedPhone: string;
  bloodGroup: BloodGroup;
  city: string;
  locality: string;
  /** Approximate (≈1 km) coordinates the donor shared, visible only to them. */
  location: { latitude: number; longitude: number; updatedAt: string } | null;
  lastDonationDate: string | null;
  availableForRequests: boolean;
  notifications: { status: NotificationStatus; consentAt: string | null; pausedAt: string | null };
  registeredVia: "web" | "whatsapp";
  registeredAt: string;
  updatedAt: string;
}

export interface DonorOverview {
  name: string | null;
  maskedPhone: string;
  profile: DonorProfileView | null;
  /** A WhatsApp registration that has been started but not finished. */
  whatsappOnboarding: { inProgress: boolean; updatedAt: string } | null;
}

export interface DonorAlertView {
  id: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface DonorAlertsResponse {
  alerts: DonorAlertView[];
}
