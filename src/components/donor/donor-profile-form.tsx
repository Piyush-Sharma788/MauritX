"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { LocationPicker } from "@/components/donor/location-picker";
import { Button, Spinner } from "@/components/ui/button";
import { Field, TextInput } from "@/components/ui/form";
import { InfoIcon } from "@/components/ui/icons";
import { donorApi } from "@/features/donors/api-client";
import { BLOOD_GROUP_LABELS, BLOOD_GROUPS, donorProfileUpdateSchema, todayInIndia, type BloodGroup } from "@/features/donors/schemas";
import type { DonorProfileView } from "@/features/donors/types";

type Errors = Partial<Record<string, string>>;

interface FormState {
  name: string;
  bloodGroup: BloodGroup | null;
  city: string;
  locality: string;
  location: { latitude: number; longitude: number } | null;
  lastDonationDate: string;
}

function initialState(profile: DonorProfileView): FormState {
  return {
    name: profile.name,
    bloodGroup: profile.bloodGroup,
    city: profile.city,
    locality: profile.locality,
    location: profile.location ? { latitude: profile.location.latitude, longitude: profile.location.longitude } : null,
    lastDonationDate: profile.lastDonationDate ?? "",
  };
}

function issuesToErrors(issues: { path: PropertyKey[]; message: string }[]): Errors {
  const errors: Errors = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return errors;
}

/**
 * Edits an existing donor profile on the website. Registration itself happens
 * only in WhatsApp; availability and alerts are managed on the dashboard.
 */
export function DonorProfileForm({ maskedPhone, profile }: { maskedPhone: string; profile: DonorProfileView }) {
  const router = useRouter();
  const id = useId();
  const [form, setForm] = useState<FormState>(() => initialState(profile));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const common = {
      name: form.name,
      bloodGroup: form.bloodGroup ?? undefined,
      city: form.city,
      locality: form.locality,
      location: form.location,
      lastDonationDate: form.lastDonationDate || null,
    };

    const parsed = donorProfileUpdateSchema.safeParse(common);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      setFormError("Please check the highlighted fields.");
      return;
    }
    setPending(true);
    const result = await donorApi.update(parsed.data);
    setPending(false);
    if (!result.ok) {
      setErrors((result.error.details?.fields as Errors) ?? {});
      setFormError(result.error.message);
      return;
    }
    router.replace("/dashboard?updated=1");
    router.refresh();
  }

  const f = (name: string) => `${id}-${name}`;

  return (
    <form onSubmit={submit} noValidate className="space-y-7">
      <section className="space-y-5">
        <Field id={f("name")} label="Your name" hint="Your full name, or the name you'd like us to use." error={errors.name}>
          <TextInput id={f("name")} autoComplete="name" value={form.name} maxLength={60} onChange={(e) => set("name", e.target.value)} error={errors.name} />
        </Field>

        <Field id={f("phone")} label="Mobile number" hint="Your WhatsApp number. To change it, use “Change mobile number” below.">
          <TextInput id={f("phone")} value={maskedPhone} readOnly disabled className="bg-paper-deep" />
        </Field>

        <div>
          <p id={f("blood-label")} className="text-sm font-semibold text-ink">Blood group</p>
          <div role="radiogroup" aria-labelledby={f("blood-label")} className="mt-2 grid grid-cols-4 gap-2">
            {BLOOD_GROUPS.map((group) => {
              const checked = form.bloodGroup === group;
              return (
                <label
                  key={group}
                  className={`flex h-12 cursor-pointer items-center justify-center rounded-xl border font-display text-base font-bold transition has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-100 ${
                    group === "unknown" ? "col-span-4 text-sm font-semibold" : ""
                  } ${checked ? "border-brand-500 bg-brand-500 text-white shadow-soft" : `${errors.bloodGroup ? "border-danger-600" : "border-line-strong"} bg-surface text-ink hover:border-ink/30`}`}
                >
                  <input type="radio" name="bloodGroup" value={group} checked={checked} onChange={() => set("bloodGroup", group)} className="sr-only" />
                  {BLOOD_GROUP_LABELS[group]}
                  {group === "unknown" && <span className={`ml-1.5 font-normal ${checked ? "text-white/80" : "text-ink-muted"}`}>· the blood centre can test it</span>}
                </label>
              );
            })}
          </div>
          {errors.bloodGroup && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errors.bloodGroup}</p>}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id={f("city")} label="City" error={errors.city}>
            <TextInput id={f("city")} autoComplete="address-level2" value={form.city} maxLength={60} onChange={(e) => set("city", e.target.value)} error={errors.city} placeholder="e.g. Lucknow" />
          </Field>
          <Field id={f("locality")} label="Locality or area" error={errors.locality}>
            <TextInput id={f("locality")} autoComplete="address-level3" value={form.locality} maxLength={80} onChange={(e) => set("locality", e.target.value)} error={errors.locality} placeholder="e.g. Gomti Nagar" />
          </Field>
        </div>

        <div>
          <p className="flex items-baseline justify-between text-sm font-semibold text-ink">
            Current location <span className="text-xs font-normal text-ink-muted">Optional</span>
          </p>
          <div className="mt-2">
            <LocationPicker value={form.location} onChange={(v) => set("location", v)} />
          </div>
          {errors.location && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errors.location}</p>}
        </div>

        <Field id={f("last")} label="Last blood donation" optional hint="Self-reported. Leave empty if you've never donated or don't remember." error={errors.lastDonationDate}>
          <TextInput id={f("last")} type="date" max={todayInIndia()} min="1950-01-01" value={form.lastDonationDate} onChange={(e) => set("lastDonationDate", e.target.value)} error={errors.lastDonationDate} />
        </Field>
      </section>

      <p className="flex gap-2 rounded-xl bg-paper-deep/70 px-4 py-3 text-xs leading-relaxed text-ink-soft">
        <InfoIcon className="mt-px size-4 shrink-0" />
        We never ask for medical history. Registering isn&apos;t a medical eligibility check: a licensed blood centre always makes that decision.
      </p>

      {formError && (
        <p role="alert" className="flex gap-2 rounded-xl bg-danger-50 px-4 py-3 text-sm text-danger-600">
          <InfoIcon className="mt-px size-4 shrink-0" />
          {formError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={pending} className="sm:min-w-52">
          {pending && <Spinner />}
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
