"use client";

import { SidebarNav, type NavItem } from "@/components/ui/sidebar-nav";
import { can, type Permission } from "@/lib/auth/permissions";

const LINKS: (NavItem & { permission: Permission })[] = [
  { href: "/admin/operations", label: "Operations", icon: "operations", permission: "operations.read" },
  { href: "/admin/coordination", label: "Coordination", icon: "coordination", permission: "admin.access" },
  { href: "/admin/requests", label: "Requests", icon: "requests", permission: "requests.manage" },
  { href: "/admin/institutions", label: "Institutions", icon: "institutions", permission: "admin.access" },
  { href: "/admin/whatsapp", label: "WhatsApp", icon: "whatsapp", permission: "whatsapp.read" },
  { href: "/admin/audit", label: "Audit", icon: "audit", permission: "audit.read" },
];

/** Only the links this role may open. */
export function AdminNav({ role }: { role: string }) {
  const items = LINKS.filter((link) => can(role, link.permission)).map(({ href, label, icon }) => ({ href, label, icon }));
  return <SidebarNav items={items} label="Admin" />;
}
