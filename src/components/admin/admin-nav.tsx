"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { can, type Permission } from "@/lib/auth/permissions";

const LINKS: { href: string; label: string; permission: Permission }[] = [
  { href: "/admin/operations", label: "Operations", permission: "operations.read" },
  { href: "/admin/coordination", label: "Coordination", permission: "admin.access" },
  { href: "/admin/requests", label: "Requests", permission: "requests.manage" },
  { href: "/admin/institutions", label: "Institutions", permission: "admin.access" },
  { href: "/admin/whatsapp", label: "WhatsApp", permission: "whatsapp.read" },
  { href: "/admin/audit", label: "Audit", permission: "audit.read" },
];

function NavLinks({ pathname, role }: { pathname: string | null; role: string }) {
  return (
    <nav aria-label="Admin" className="flex gap-1 overflow-x-auto">
      {LINKS.filter((link) => can(role, link.permission)).map((link) => {
        const active = pathname?.startsWith(link.href) ?? false;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition ${active ? "bg-ink text-white" : "text-ink-soft hover:bg-ink/5 hover:text-ink"}`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ActiveNav({ role }: { role: string }) {
  return <NavLinks pathname={usePathname()} role={role} />;
}

/** The URL is request data under Cache Components, so the active state streams in behind Suspense. */
export function AdminNav({ role }: { role: string }) {
  return (
    <Suspense fallback={<NavLinks pathname={null} role={role} />}>
      <ActiveNav role={role} />
    </Suspense>
  );
}
