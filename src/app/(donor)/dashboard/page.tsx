import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { BecomeDonorButton } from "@/components/donor/become-donor-button";
import { DeleteAccount } from "@/components/donor/delete-account";
import { DonorDashboard } from "@/components/donor/donor-dashboard";
import { Spinner } from "@/components/ui/button";
import { ArrowRightIcon, ChatIcon, CheckIcon, DropIcon, InfoIcon } from "@/components/ui/icons";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isStaffRole, ROLE_LABELS } from "@/lib/auth/permissions";
import { getDonorOverview } from "@/server/donors/service";

export const metadata: Metadata = {
  title: "Dashboard",
  robots: { index: false },
};

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-ink-muted" role="status">
            <Spinner className="size-6" />
            <span className="sr-only">Loading your dashboard</span>
          </div>
        }
      >
        <DashboardContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function DashboardContent({ searchParams }: Pick<PageProps<"/dashboard">, "searchParams">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [overview, params] = await Promise.all([getDonorOverview(user.id), searchParams]);
  const flash = params.registered ? "registered" : params.updated ? "updated" : null;

  return (
    <div className="space-y-5">
      {overview.profile ? (
        // Keyed on updatedAt: Next keeps this page's client state between visits, so fresh server data must remount it.
        <DonorDashboard key={overview.profile.updatedAt} initial={overview.profile} flash={flash} />
      ) : (
        <section className="rounded-[var(--radius-card)] border border-brand-100 bg-gradient-to-br from-brand-50 via-surface to-surface p-6 shadow-soft sm:p-9">
          <p className="inline-flex items-center gap-1.5 rounded-full bg-success-50 px-3 py-1 text-xs font-semibold text-success-600">
            <CheckIcon className="size-3.5" /> Signed in · {overview.maskedPhone}
          </p>
          <h1 className="mt-4 font-display text-3xl font-bold tracking-[-0.04em] text-ink sm:text-4xl">
            {overview.whatsappOnboarding ? "Finish registering on WhatsApp" : "No donor profile for this number yet"}
          </h1>
          <p className="mt-3 max-w-2xl text-lg leading-relaxed text-ink-soft">
            {overview.whatsappOnboarding
              ? "You've started registering in our WhatsApp chat. Reply to our last message there to finish. Your answers so far are saved."
              : "Donor registration happens in a short WhatsApp chat with MarutiX. Send REGISTER from this number and your profile will appear here."}
          </p>
          <ul className="mt-6 grid gap-2.5 text-sm text-ink-soft sm:grid-cols-2">
            {["About two minutes, no forms", "Your number is taken from the chat", "Blood group can be “not sure”", "Alerts only if you say yes"].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <DropIcon className="size-4 shrink-0 text-brand-500" /> {item}
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <BecomeDonorButton size="lg">
              <ChatIcon className="size-5" /> {overview.whatsappOnboarding ? "Open WhatsApp" : "Register on WhatsApp"}
            </BecomeDonorButton>
            <Link href="/donate" className="text-sm font-semibold text-brand-600 hover:text-brand-700">
              On a computer? Scan a QR code
            </Link>
          </div>
          <p className="mt-6 flex gap-2 text-sm text-ink-muted">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            Registered on WhatsApp with a different number? Sign out and sign in with that number.
          </p>
        </section>
      )}

      {isStaffRole(user.role) && (
        <Link
          href="/admin/operations"
          className="group flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-ink/15 bg-ink p-5 text-white shadow-soft transition hover:bg-ink/90 sm:p-6"
        >
          <span>
            <span className="block font-semibold">Admin · {ROLE_LABELS[user.role]}</span>
            <span className="mt-0.5 block text-sm text-white/70">Verify and coordinate emergency requests. Two-factor authentication is required.</span>
          </span>
          <ArrowRightIcon className="size-5 shrink-0 transition-transform group-hover:translate-x-1" />
        </Link>
      )}

      <Link
        href="/get-help"
        className="group flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-soft transition hover:border-brand-200 sm:p-6"
      >
        <span>
          <span className="block font-semibold text-ink">Need blood right now?</span>
          <span className="mt-0.5 block text-sm text-ink-soft">See the fastest official routes to blood centres and emergency help.</span>
        </span>
        <ArrowRightIcon className="size-5 shrink-0 text-brand-500 transition-transform group-hover:translate-x-1" />
      </Link>

      <DeleteAccount isStaff={isStaffRole(user.role)} />
    </div>
  );
}
