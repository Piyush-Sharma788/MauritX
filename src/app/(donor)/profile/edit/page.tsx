import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ChangePhoneCard } from "@/components/donor/change-phone-card";
import { DonorProfileForm } from "@/components/donor/donor-profile-form";
import { Spinner } from "@/components/ui/button";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDonorOverview } from "@/server/donors/service";

export const metadata: Metadata = {
  title: "Edit profile",
  robots: { index: false },
};

export default function EditProfilePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href="/dashboard" className="-ml-2 inline-flex items-center gap-1.5 rounded-md border-2 border-transparent px-2 py-1 text-sm font-semibold text-ink transition-colors hover:border-ink hover:bg-signal-300">
        <ArrowLeftIcon className="size-4" /> Dashboard
      </Link>
      <h1 className="mt-3 font-display text-[2rem] font-extrabold leading-[1.02] tracking-[-0.045em] text-ink sm:text-[2.6rem]">Edit your profile</h1>
      <Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-ink-muted" role="status">
            <Spinner className="size-6" />
            <span className="sr-only">Loading</span>
          </div>
        }
      >
        <EditContent />
      </Suspense>
    </div>
  );
}

async function EditContent() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const overview = await getDonorOverview(user.id);
  if (!overview.profile) redirect("/dashboard");

  return (
    <div className="mt-8 space-y-5">
      <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-5 shadow-brut sm:p-8">
        <DonorProfileForm key={overview.profile.updatedAt} maskedPhone={overview.maskedPhone} profile={overview.profile} />
      </section>
      <ChangePhoneCard maskedPhone={overview.maskedPhone} />
    </div>
  );
}
