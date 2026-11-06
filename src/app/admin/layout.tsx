import Link from "next/link";
import { Suspense } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { AppShell, PortalBadge } from "@/components/ui/app-shell";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isStaffRole } from "@/lib/auth/permissions";

/** Only the links this role may open, and none until the second factor is passed. */
async function StaffNav() {
  const user = await getCurrentUser();
  if (!user || !isStaffRole(user.role) || !user.mfaVerified) return null;
  return <AdminNav role={user.role} />;
}

function BackToDashboard({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/dashboard"
      className={`inline-flex min-h-10 items-center gap-2 rounded-lg text-sm font-medium text-ink-soft transition-colors hover:bg-signal-100 hover:text-ink ${compact ? "border border-line-strong bg-surface px-3" : "w-full px-3"}`}
    >
      <ArrowLeftIcon className="size-4" />
      {compact ? <><span className="hidden sm:inline">My dashboard</span><span className="sr-only sm:hidden">My dashboard</span></> : "Back to my dashboard"}
    </Link>
  );
}

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <AppShell
      homeHref="/dashboard"
      badge={<PortalBadge>Admin</PortalBadge>}
      nav={
        <Suspense fallback={null}>
          <StaffNav />
        </Suspense>
      }
      mobileActions={<BackToDashboard compact />}
      sidebarFooter={<BackToDashboard />}
    >
      {children}
    </AppShell>
  );
}
