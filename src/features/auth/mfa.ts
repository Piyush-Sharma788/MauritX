import { z } from "zod";

/** Admin two-factor authentication payloads. Browser-safe. */
export const mfaCodeSchema = z.strictObject({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.") });
export const mfaVerifySchema = z.union([
  mfaCodeSchema,
  z.strictObject({ recoveryCode: z.string().trim().toUpperCase().regex(/^[2-9A-HJ-NP-TV-Z]{4}-?[2-9A-HJ-NP-TV-Z]{4}$/, "Recovery codes look like 7K3Q-9P2A.") }),
]);
