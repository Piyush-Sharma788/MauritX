import type { Metadata } from "next";

import { Suspense } from "react";
import { WhatsAppPanel } from "@/components/admin/whatsapp-panel";
import { Spinner } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireAdminPage } from "@/lib/auth/require-admin";

export const metadata: Metadata = {
  title: "WhatsApp integration · Admin",
  robots: { index: false },
};

export default function WhatsAppAdminPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">Integrations</p>
      <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.035em] text-ink sm:text-4xl">WhatsApp (pilot)</h1>
      <div className="mt-8">
        <Suspense
          fallback={
            <div className="flex min-h-64 items-center justify-center text-ink-muted" role="status">
              <Spinner className="size-6" />
              <span className="sr-only">Loading</span>
            </div>
          }
        >
          <AdminGate />
        </Suspense>
      </div>
    </div>
  );
}

/** Server-side gate: non-admins get a 404 so the page's existence isn't revealed. */
async function AdminGate() {
  const user = await requireAdminPage("whatsapp.read");
  return <WhatsAppPanel canManage={can(user.role, "whatsapp.manage")} />;
}
