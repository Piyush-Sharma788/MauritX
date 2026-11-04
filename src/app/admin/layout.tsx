import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Logo href="/dashboard" />
            <span className="rounded-full bg-ink px-2.5 py-0.5 text-xs font-semibold text-white">Admin</span>
            <div className="ml-2 hidden sm:block"><AdminNav /></div>
          </div>
          <Link href="/dashboard" className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-ink-soft hover:bg-ink/5 hover:text-ink">
            <ArrowLeftIcon className="size-4" /> <span className="hidden sm:inline">Dashboard</span>
          </Link>
        </div>
        <div className="border-t border-line px-4 py-2 sm:hidden"><AdminNav /></div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
