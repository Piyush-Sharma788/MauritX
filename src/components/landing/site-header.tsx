"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ButtonLink } from "@/components/ui/button";
import { ArrowRightIcon, MenuIcon, XIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";

const NAV_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#safety", label: "Trust & safety" },
  { href: "/#donors", label: "For donors" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => window.innerWidth >= 1024 && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b-2 border-ink bg-paper">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:h-[4.5rem]">
        <Logo />

        <nav aria-label="Primary" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="inline-flex min-h-11 items-center rounded-md border-2 border-transparent px-3 text-[0.93rem] font-semibold text-ink transition-colors hover:border-ink hover:bg-signal-300"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 sm:flex">
            <ButtonLink href="/login" variant="ghost">
              Sign in
            </ButtonLink>
            <ButtonLink href="/request" className="px-4 text-sm">
              Request Blood
            </ButtonLink>
          </div>
          <button
            type="button"
            className="inline-flex size-11 items-center justify-center rounded-md border-2 border-ink bg-surface text-ink shadow-brut-xs transition-colors hover:bg-signal-300 aria-expanded:bg-signal-300 lg:hidden"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <XIcon className="size-5" /> : <MenuIcon className="size-5" />}
          </button>
        </div>
      </div>

      <div
        id={menuId}
        hidden={!open}
        className="border-t-2 border-ink bg-paper px-4 pb-6 pt-3 sm:px-6 lg:hidden"
      >
        <nav aria-label="Mobile">
          <ul className="flex flex-col divide-y-2 divide-ink border-y-2 border-ink">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-13 items-center justify-between px-1 font-display text-xl font-extrabold tracking-[-0.03em] text-ink hover:bg-signal-300"
                >
                  {link.label}
                  <ArrowRightIcon className="size-5" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <ButtonLink href="/login" variant="secondary" onClick={() => setOpen(false)}>
            Sign in
          </ButtonLink>
          <ButtonLink href="/request" onClick={() => setOpen(false)}>
            Request Blood
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}
