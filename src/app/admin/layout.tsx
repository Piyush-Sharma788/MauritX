import Link from "next/link";
import { Suspense } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isStaffRole } from "@/lib/auth/permissions";

/** Only the links this role may open, and none until the second factor is passed. */
async function StaffNav() {
  const user = await getCurrentUser();
  if (!user || !isStaffRole(user.role) || !user.mfaVerified) return null;
  return <AdminNav role={user.role} />;
}

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b-2 border-ink bg-paper">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Logo href="/dashboard" />
            <span className="rounded-sm border-2 border-ink bg-ink px-2 py-0.5 font-mono text-[0.66rem] font-bold uppercase tracking-[0.14em] text-signal-300">Admin</span>
          </div>
          <Link href="/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border-2 border-ink bg-surface px-3 text-sm font-bold text-ink shadow-brut-xs transition-colors hover:bg-signal-300">
            <ArrowLeftIcon className="size-4" /> <span className="hidden sm:inline">Dashboard</span><span className="sr-only sm:hidden">Dashboard</span>
          </Link>
        </div>
        <Suspense fallback={null}>
          <div className="border-t-2 border-ink bg-surface has-[>div:empty]:hidden">
            <div className="mx-auto max-w-6xl px-2 py-1.5 sm:px-4 empty:hidden"><StaffNav /></div>
          </div>
        </Suspense>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
