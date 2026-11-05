import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { MfaFlow } from "@/components/auth/mfa-flow";
import { Spinner } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isStaffRole } from "@/lib/auth/permissions";

export const metadata: Metadata = {
  title: "Two-factor authentication · Admin",
  robots: { index: false },
};

export default function AdminMfaPage() {
  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-14">
      <Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-ink-muted" role="status">
            <Spinner className="size-6" />
            <span className="sr-only">Loading</span>
          </div>
        }
      >
        <Gate />
      </Suspense>
    </div>
  );
}

/** Not requireAdminPage: that sends unverified staff here, so this page only needs a signed-in staff session. */
async function Gate() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!isStaffRole(user.role)) notFound();
  if (user.mfaVerified) redirect("/admin/operations");
  return <MfaFlow enrolled={user.mfaEnrolled} />;
}
