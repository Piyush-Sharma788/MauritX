"use client";

import { badgeBase } from "@/components/ui/primitives";
import { useEffect, useId, useState } from "react";
import { Button, ButtonLink, Spinner } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/form";
import { AlertIcon, BellOffIcon, ChatIcon, CheckIcon, DropIcon, InfoIcon, MapPinIcon, ShieldIcon } from "@/components/ui/icons";
import { donorApi } from "@/features/donors/api-client";
import { BLOOD_GROUP_LABELS } from "@/features/donors/schemas";
import type { DonorAlertView, DonorProfileView, NotificationStatus } from "@/features/donors/types";

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const dateOnly = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const formatDay = (iso: string) => dateOnly.format(new Date(`${iso}T00:00:00+05:30`));

const ALERT_STATUS: Record<NotificationStatus, { label: string; tone: string }> = {
  active: { label: "On", tone: "bg-mint-400 text-ink" },
  paused: { label: "Paused", tone: "bg-signal-300 text-ink" },
  not_enabled: { label: "Off", tone: "bg-paper-deep text-ink" },
  opted_out: { label: "Stopped", tone: "bg-brand-500 text-white" },
};

export function DonorDashboard({ initial, flash }: { initial: DonorProfileView; flash: "registered" | "updated" | null }) {
  const [profile, setProfile] = useState(initial);
  const first = profile.name.split(" ")[0] || "there";

  return (
    <div className="space-y-5">
      {flash && (
        <p role="status" className="animate-rise flex items-center gap-2.5 rounded-md border-2 border-ink bg-mint-300 px-4 py-3 text-sm font-bold text-ink shadow-brut-sm">
          <CheckIcon className="size-5 shrink-0" />
          {flash === "registered" ? "You're registered as a MarutiX donor. Thank you for volunteering." : "Your profile has been updated."}
        </p>
      )}

      <header className="relative flex items-center justify-between gap-4 overflow-hidden rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut-lg sm:p-8">
        <div aria-hidden="true" className="absolute inset-y-0 right-0 hidden w-44 border-l-2 border-ink bg-signal-300 bg-dots sm:block" />
        <div className="relative min-w-0">
          <p className={`${badgeBase} bg-mint-400 text-ink`}>
            <CheckIcon className="size-3.5" strokeWidth={3} /> Registered donor
          </p>
          <h1 className="mt-3 font-display text-[2rem] font-extrabold leading-[1.02] tracking-[-0.045em] text-ink sm:text-[2.6rem]">Hi, {first}</h1>
          <p className="mt-2 text-ink-soft">
            Registered on {dateOnly.format(new Date(profile.registeredAt))} via {profile.registeredVia === "whatsapp" ? "WhatsApp" : "the web"}.
          </p>
        </div>
        <div className="relative flex shrink-0 justify-center sm:w-[8.5rem]">
          <div className="relative flex size-20 items-center justify-center sm:size-24" role="img" aria-label={`Blood group ${BLOOD_GROUP_LABELS[profile.bloodGroup]}`}>
            <DropIcon className="absolute inset-0 size-20 fill-brand-500 text-ink drop-shadow-[4px_4px_0_var(--color-ink)] sm:size-24" strokeWidth={1.2} />
            <span className={`relative mt-3 font-display font-extrabold text-white sm:mt-4 ${profile.bloodGroup === "unknown" ? "text-[0.65rem]" : "text-xl sm:text-2xl"}`}>
              {BLOOD_GROUP_LABELS[profile.bloodGroup]}
            </span>
          </div>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <AvailabilityCard profile={profile} onChange={setProfile} />
        <AlertsCard profile={profile} onChange={setProfile} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <ProfileCard profile={profile} />
        <RecentAlerts />
      </div>
    </div>
  );
}

function Card({ title, icon, children, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 shadow-brut sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-sm border-2 border-ink bg-signal-300 text-ink">{icon}</span>
          <h2 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{title}</h2>
        </div>
        {action}
      </div>
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </section>
  );
}

function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 flex gap-2 text-sm font-semibold text-danger-600">
      <InfoIcon className="mt-px size-4 shrink-0" />
      {message}
    </p>
  );
}

function AvailabilityCard({ profile, onChange }: { profile: DonorProfileView; onChange: (p: DonorProfileView) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setPending(true);
    setError(null);
    const result = await donorApi.setAvailability(next);
    setPending(false);
    if (result.ok) onChange(result.data);
    else setError(result.error.message);
  }

  return (
    <Card title="Donation availability" icon={<DropIcon className="size-5" />}>
      <div className="flex items-center justify-between gap-4 rounded-md border-2 border-ink bg-paper p-4">
        <div>
          <p className="font-bold text-ink">{profile.availableForRequests ? "Available to donate" : "Not available right now"}</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {profile.availableForRequests ? "You can be contacted about nearby requests." : "You won't be contacted until you switch this on."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pending && <Spinner className="size-4 text-ink-muted" />}
          <Switch checked={profile.availableForRequests} onChange={toggle} disabled={pending} label="Available to donate" />
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-muted">
        Switch this off after donating, when travelling or unwell. Only you decide; the blood centre confirms eligibility on the day.
      </p>
      <ErrorText message={error} />
    </Card>
  );
}

function AlertsCard({ profile, onChange }: { profile: DonorProfileView; onChange: (p: DonorProfileView) => void }) {
  const id = useId();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const status = profile.notifications.status;
  const badge = ALERT_STATUS[status];

  async function run(action: "enable" | "pause" | "resume" | "opt_out") {
    setPending(action);
    setError(null);
    const result = action === "enable" ? await donorApi.enableAlerts() : await donorApi.alertAction(action);
    setPending(null);
    setConfirmStop(false);
    setConsent(false);
    if (result.ok) onChange(result.data);
    else setError(result.error.message);
  }

  const description = {
    active: "We'll message you on WhatsApp about emergency blood requests near you.",
    paused: `Paused${profile.notifications.pausedAt ? ` since ${dateTime.format(new Date(profile.notifications.pausedAt))}` : ""}. You won't get alerts until you resume.`,
    not_enabled: "Alerts are off. Turn them on to hear about emergency requests near you.",
    opted_out: "You've stopped all MarutiX messages. You can turn alerts back on whenever you like.",
  }[status];

  return (
    <Card
      title="Emergency alerts"
      icon={<ChatIcon className="size-5" />}
      action={<span className={`${badgeBase} text-[0.75rem] ${badge.tone}`}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{badge.label}</span>}
    >
      <p className="text-ink-soft">{description}</p>
      {status === "active" && !profile.availableForRequests && (
        <p className="mt-3 flex gap-2 rounded-md border-2 border-ink bg-signal-50 px-3.5 py-2.5 text-sm text-ink">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          You&apos;re marked as not available, so no alerts will be sent until you switch availability on.
        </p>
      )}

      {(status === "not_enabled" || status === "opted_out") && (
        <div className="mt-4 space-y-3">
          <Checkbox id={`${id}-consent`} checked={consent} onChange={setConsent}>
            I agree that MarutiX may send me WhatsApp alerts about emergency blood requests near me. I can pause or stop at any time.
          </Checkbox>
          <Button onClick={() => run("enable")} disabled={!consent || pending !== null} className="w-full sm:w-auto">
            {pending === "enable" && <Spinner />}
            {status === "opted_out" ? "Turn alerts back on" : "Turn on alerts"}
          </Button>
        </div>
      )}

      {(status === "active" || status === "paused") && !confirmStop && (
        <div className="mt-auto flex flex-wrap gap-3 pt-5">
          {status === "active" ? (
            <Button variant="secondary" onClick={() => run("pause")} disabled={pending !== null}>
              {pending === "pause" && <Spinner />}
              Pause alerts
            </Button>
          ) : (
            <Button onClick={() => run("resume")} disabled={pending !== null}>
              {pending === "resume" && <Spinner />}
              Resume alerts
            </Button>
          )}
          <Button variant="danger" onClick={() => setConfirmStop(true)} disabled={pending !== null}>
            Stop all alerts
          </Button>
        </div>
      )}

      {confirmStop && (
        <div role="alertdialog" aria-labelledby={`${id}-stop`} className="mt-5 rounded-md border-2 border-ink bg-danger-50 p-4 text-sm text-danger-600">
          <p id={`${id}-stop`} className="font-semibold">Stop all MarutiX messages?</p>
          <p className="mt-1 leading-relaxed">
            We&apos;ll stop WhatsApp messages to {profile.maskedPhone} immediately, including anything already queued. Your donor profile stays, and you can turn alerts back on later.
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger-solid" className="h-10 px-4 text-sm" onClick={() => run("opt_out")} disabled={pending !== null}>
              {pending === "opt_out" && <Spinner />}
              Yes, stop everything
            </Button>
            <Button variant="ghost" className="h-10 px-4 text-sm" onClick={() => setConfirmStop(false)} disabled={pending !== null}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <ErrorText message={error} />
    </Card>
  );
}

function ProfileCard({ profile }: { profile: DonorProfileView }) {
  const rows: [string, React.ReactNode][] = [
    ["Name", profile.name],
    ["Mobile number", profile.maskedPhone],
    ["Blood group", BLOOD_GROUP_LABELS[profile.bloodGroup]],
    ["City", profile.city],
    ["Locality", profile.locality],
    [
      "Location",
      profile.location ? (
        <span className="inline-flex items-center gap-1.5">
          <MapPinIcon className="size-4 text-brand-600" /> Approximate · updated {dateOnly.format(new Date(profile.location.updatedAt))}
        </span>
      ) : (
        <span className="text-ink-muted">Not shared</span>
      ),
    ],
    ["Last donation", profile.lastDonationDate ? formatDay(profile.lastDonationDate) : <span className="text-ink-muted">Not provided</span>],
  ];
  return (
    <Card title="Your profile" icon={<ShieldIcon className="size-5" />} action={<ButtonLink href="/profile/edit" variant="secondary" className="h-10 px-4 text-sm">Edit profile</ButtonLink>}>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <dt className="font-mono text-[0.7rem] font-bold uppercase tracking-[0.1em] text-ink-muted">{label}</dt>
            <dd className="font-semibold text-ink sm:text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function RecentAlerts() {
  const [alerts, setAlerts] = useState<DonorAlertView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    donorApi.alerts().then((result) => {
      if (cancelled) return;
      if (result.ok) setAlerts(result.data.alerts);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card title="Recent emergency alerts" icon={<BellOffIcon className="size-5" />}>
      {error ? (
        <ErrorText message={error} />
      ) : alerts === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading alerts">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-paper-deep" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-md border-2 border-dashed border-ink/50 bg-paper px-5 py-8 text-center">
          <BellOffIcon className="size-7 text-ink-muted" />
          <p className="mt-3 font-bold text-ink">No alerts yet</p>
          <p className="mt-1 max-w-xs text-sm text-ink-soft">
            Emergency requests aren&apos;t live on MarutiX yet. Alerts you receive will appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {alerts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-3">
              <span className="text-ink">{dateTime.format(new Date(a.createdAt))}</span>
              <span className={`${badgeBase} bg-paper-deep text-ink`}>{a.readAt ? "read" : a.deliveredAt ? "delivered" : a.status}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
