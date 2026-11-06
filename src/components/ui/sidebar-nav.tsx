"use client";

import {
  Activity,
  ClipboardList,
  Hospital,
  LayoutDashboard,
  LifeBuoy,
  MessageCircle,
  ScrollText,
  ShieldCheck,
  UserRoundPen,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

const ICONS = {
  operations: Activity,
  coordination: Workflow,
  requests: ClipboardList,
  institutions: Hospital,
  whatsapp: MessageCircle,
  audit: ScrollText,
  dashboard: LayoutDashboard,
  profile: UserRoundPen,
  help: LifeBuoy,
  privacy: ShieldCheck,
} satisfies Record<string, LucideIcon>;

export type NavIcon = keyof typeof ICONS;
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
}

function isActive(pathname: string | null, href: string) {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

/**
 * Horizontal, scrollable tabs on small screens; a vertical list in the
 * sidebar from lg up. The same markup serves both, so there is one nav.
 */
function Links({ items, pathname, label }: { items: NavItem[]; pathname: string | null; label: string }) {
  return (
    <nav aria-label={label}>
      <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = ICONS[item.icon];
          return (
            <li key={item.href} className="shrink-0 lg:shrink">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`group relative flex min-h-10 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors duration-150 ${
                  active ? "bg-brand-50 text-brand-700" : "text-ink-soft hover:bg-signal-100 hover:text-ink"
                }`}
              >
                {active && <span aria-hidden="true" className="absolute inset-y-2 left-0 hidden w-0.5 rounded-full bg-brand-500 lg:block" />}
                <Icon aria-hidden="true" className={`size-4.5 shrink-0 ${active ? "text-brand-600" : "text-ink-muted group-hover:text-ink-soft"}`} strokeWidth={2} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ActiveLinks(props: { items: NavItem[]; label: string }) {
  return <Links {...props} pathname={usePathname()} />;
}

/** The URL is request data under Cache Components, so the active state streams in behind Suspense. */
export function SidebarNav({ items, label }: { items: NavItem[]; label: string }) {
  return (
    <Suspense fallback={<Links items={items} pathname={null} label={label} />}>
      <ActiveLinks items={items} label={label} />
    </Suspense>
  );
}
