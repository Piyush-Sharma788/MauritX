import Link from "next/link";
import { LogoutButton } from "@/components/auth/logout-button";
import { Logo } from "@/components/ui/logo";

export default function DonorLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Logo href="/dashboard" />
          <div className="flex items-center gap-1 sm:gap-2">
            <Link href="/get-help" className="hidden rounded-full px-3 py-2 text-sm font-medium text-ink-soft hover:bg-ink/5 hover:text-ink sm:inline-flex">
              Need blood?
            </Link>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
