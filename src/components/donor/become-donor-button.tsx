import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { donorRegistrationChatUrl } from "@/lib/whatsapp-web/public-chat";

/**
 * "Become a Donor": opens the MarutiX WhatsApp chat with REGISTER pre-filled.
 * Registration happens only in WhatsApp. If the pilot number isn't configured,
 * it links to /donate, which says so plainly.
 */
export function BecomeDonorButton({
  children = "Become a Donor",
  variant = "primary",
  size = "md",
  className = "",
}: {
  children?: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "lg";
  className?: string;
}) {
  const url = donorRegistrationChatUrl();
  const classes = buttonClasses({ variant, size, className });
  if (!url) {
    return (
      <Link href="/donate" className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={classes}>
      {children}
      <span className="sr-only"> (opens WhatsApp)</span>
    </a>
  );
}
