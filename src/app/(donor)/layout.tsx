import { LogoutButton } from "@/components/auth/logout-button";
import { AppShell, PortalBadge } from "@/components/ui/app-shell";
import { SidebarNav, type NavItem } from "@/components/ui/sidebar-nav";

const ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/profile/edit", label: "Edit profile", icon: "profile" },
  { href: "/get-help", label: "Need blood?", icon: "help" },
  { href: "/privacy", label: "Privacy", icon: "privacy" },
];

export default function DonorLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      homeHref="/dashboard"
      badge={<PortalBadge>Donor</PortalBadge>}
      nav={<SidebarNav items={ITEMS} label="Donor" />}
      mobileActions={<LogoutButton />}
      sidebarFooter={
        <div className="[&>div]:items-stretch [&_button]:w-full">
          <LogoutButton />
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
