import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { NearbyFacilities } from "@/components/requests/nearby-facilities";
import { TrackedRequest } from "@/components/requests/tracked-request";
import { ButtonLink, Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { TRACKING_TOKEN } from "@/features/requests/schemas";
import type { TrackedRequestView } from "@/features/requests/types";
import { AppError } from "@/lib/api/errors";
import { nearbyFacilitiesForRequest } from "@/server/discovery/nearby";
import { getTrackedRequest } from "@/server/requests/service";

export const metadata: Metadata = {
  title: "Request status",
  robots: { index: false, follow: false },
};

export default function TrackPage({ params }: PageProps<"/track/[token]">) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center text-ink-muted" role="status">
            <Spinner className="size-6" />
            <span className="sr-only">Loading request</span>
          </div>
        }
      >
        <TrackContent params={params} />
      </Suspense>
    </div>
  );
}

const PROBLEMS = {
  TRACKING_LINK_EXPIRED: { title: "This link has expired", body: "Tracking links stop working after a while to protect the request. Ask the person who shared it for a new one." },
  TRACKING_LINK_REVOKED: { title: "This link has been turned off", body: "The requester or the MarutiX team turned this link off. Ask the person who shared it for a new one." },
  NOT_FOUND: { title: "We couldn't find this request", body: "Check that you copied the whole link. Links look like marutix…/track/ followed by a long code." },
} as const;

async function TrackContent({ params }: Pick<PageProps<"/track/[token]">, "params">) {
  const { token } = await params;
  // Link validity depends on the current time, so this always renders per request.
  await connection();
  let view: TrackedRequestView | null = null;
  let problem: keyof typeof PROBLEMS = "NOT_FOUND";
  if (TRACKING_TOKEN.test(token)) {
    try {
      view = await getTrackedRequest(token);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      problem = error.code in PROBLEMS ? (error.code as keyof typeof PROBLEMS) : "NOT_FOUND";
    }
  }

  if (!view) {
    const p = PROBLEMS[problem];
    return (
      <section className="mx-auto max-w-lg rounded-[var(--radius-card)] border border-line bg-surface p-8 text-center shadow-brut-sm">
        <span aria-hidden="true" className="mx-auto flex size-14 items-center justify-center rounded-md border border-line bg-signal-300 shadow-brut-sm"><InfoIcon className="size-7 text-ink" /></span>
        <h1 className="mt-5 font-display text-3xl font-semibold tracking-[-0.03em] text-ink">{p.title}</h1>
        <p className="mt-2 text-ink-soft">{p.body}</p>
        <div className="mt-7 flex flex-col justify-center gap-4 sm:flex-row">
          <ButtonLink href="/request">Make a new request</ButtonLink>
          <ButtonLink href="/get-help" variant="secondary">Get help now</ButtonLink>
        </div>
        <p className="mt-6 text-xs text-ink-muted">In a life-threatening emergency, call <Link href="tel:112" className="font-bold text-ink underline">112</Link>.</p>
      </section>
    );
  }
  // The token was checked above, so this viewer may see the request. Database read only, no external calls.
  // A failure here must never hide the request itself.
  const nearby = await nearbyFacilitiesForRequest(view.publicRequestId).catch(() => null);
  return <TrackedRequest initial={view} token={token} nearby={nearby ? <NearbyFacilities result={nearby} /> : null} />;
}
