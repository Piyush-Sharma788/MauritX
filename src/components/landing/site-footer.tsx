import Link from "next/link";
import { PhoneIcon } from "@/components/ui/icons";
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
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="max-w-sm">
            <Logo />
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              An India-first platform that coordinates communication between families, voluntary donors and verified
              blood centres.
            </p>
            <p className="mt-4 rounded-md border border-dashed border-line-strong p-3 text-xs leading-relaxed text-ink-muted">
              MarutiX is not a blood bank. It does not collect, test, store, transport or certify blood, and it does not
              replace a licensed blood centre or a clinician.
            </p>
          </div>
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h2 className="eyebrow text-ink-muted">{column.title}</h2>
              <ul className="mt-3 space-y-0.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-brand-500 md:min-h-9">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
      <div className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-5 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-ink-muted">© 2026 MarutiX · Built in India</p>
          <p className="flex items-start gap-2 text-ink-soft">
            <PhoneIcon className="mt-px size-4 shrink-0 text-brand-600" />
            <span>
              Medical emergency? Call <a href="tel:112" className="font-semibold text-brand-600 underline underline-offset-2">112</a>{" "}
              or contact the treating hospital.
            </span>
          </p>
        </div>
      </div>
    </footer>
  );
}
