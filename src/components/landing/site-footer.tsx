import Link from "next/link";
import { Logo } from "@/components/ui/logo";

const COLUMNS = [
  {
    title: "Platform",
    links: [
      { href: "/request", label: "Request blood" },
      { href: "/get-help", label: "Get help now" },
      { href: "/donate", label: "Become a donor (WhatsApp)" },
      { href: "/login", label: "Donor sign-in" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "/#how-it-works", label: "How it works" },
      { href: "/#safety", label: "Trust & safety" },
      { href: "/#faq", label: "FAQ" },
    ],
  },
  {
    title: "Policies",
    links: [{ href: "/privacy", label: "Privacy notice" }],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-paper-deep/60">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="max-w-sm">
            <Logo />
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              An India-first platform that coordinates communication between families, voluntary donors and verified
              blood centres.
            </p>
            <p className="mt-4 text-xs leading-relaxed text-ink-muted">
              MarutiX is not a blood bank. It does not collect, test, store, transport or certify blood, and it does not
              replace a licensed blood centre or a clinician.
            </p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{column.title}</h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-sm text-ink-soft transition hover:text-brand-600">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-6 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 MarutiX. Built in India.</p>
          <p>
            Medical emergency? Call <a href="tel:112" className="font-semibold text-ink underline-offset-2 hover:underline">112</a>{" "}
            or contact the treating hospital.
          </p>
        </div>
      </div>
    </footer>
  );
}
