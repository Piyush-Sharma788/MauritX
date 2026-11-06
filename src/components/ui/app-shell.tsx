import type { ReactNode } from "react";
import { Logo } from "@/components/ui/logo";

/**
 * Dashboard shell shared by the donor portal and the admin console.
 * lg and up: a fixed white sidebar (brand, navigation, footer actions) beside
 * the content. Below lg: a sticky top bar with the brand and actions, and the
 * same navigation as scrollable tabs underneath.
 */
export function AppShell({
  homeHref,
  badge,
  nav,
  mobileActions,
  sidebarFooter,
  children,
}: {
  homeHref: string;
  badge?: ReactNode;
  nav?: ReactNode;
  mobileActions?: ReactNode;
  sidebarFooter?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-md lg:h-dvh lg:border-b-0 lg:border-r lg:bg-surface lg:backdrop-blur-none">
        <div className="flex h-full flex-col">
          <div className="flex h-16 shrink-0 items-center justify-between gap-3 px-4 sm:px-6 lg:px-5">
            <div className="flex min-w-0 items-center gap-2">
              <Logo href={homeHref} />
              {badge}
            </div>
            {mobileActions && <div className="flex items-center gap-1.5 lg:hidden">{mobileActions}</div>}
          </div>
          {nav && <div className="px-3 pb-2 empty:hidden sm:px-5 lg:flex-1 lg:overflow-y-auto lg:px-3 lg:pt-3">{nav}</div>}
          {sidebarFooter && <div className="mt-auto hidden border-t border-line p-3 lg:block">{sidebarFooter}</div>}
        </div>
      </aside>
      <main id="main" className="min-w-0">
        {children}
      </main>
    </div>
  );
}

/** Small label next to the logo: which portal this is. */
export function PortalBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-line bg-paper px-1.5 py-0.5 text-[0.7rem] font-semibold leading-4 text-ink-soft">{children}</span>;
}
