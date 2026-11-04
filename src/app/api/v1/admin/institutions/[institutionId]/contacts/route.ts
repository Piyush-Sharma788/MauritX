import { Types } from "mongoose";
import { addContactSchema } from "@/features/coordination/schemas";
import { apiRoute, ok, parseJsonBody } from "@/lib/api/handler";
import { requireAdmin } from "@/lib/auth/require-admin";
import { addContact } from "@/server/institutions/service";

/** POST /api/v1/admin/institutions/:id/contacts: `{ name, phone, role }`. Added as pending until verified. Admin only; audited. */
export const POST = apiRoute(async (request, ctx, route) => {
  const admin = await requireAdmin();
  const { institutionId } = await route.params;
  const body = await parseJsonBody(request, addContactSchema);
  await addContact(institutionId ?? "", body, new Types.ObjectId(admin.id), ctx.requestId);
  return ok(ctx, { status: "pending" }, 201);
});
