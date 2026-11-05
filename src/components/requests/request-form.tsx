"use client";

import Link from "next/link";
import { useId, useRef, useState, type ReactNode } from "react";
import { LocationPicker } from "@/components/donor/location-picker";
import { StatusBadge, formatIST } from "@/components/requests/status";
import { Button, Spinner, buttonClasses } from "@/components/ui/button";
import { Notice } from "@/components/ui/primitives";
import { Checkbox, Field, RadioCards, TextInput } from "@/components/ui/form";
import { AlertIcon, ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChatIcon, InfoIcon, PhoneIcon } from "@/components/ui/icons";
import { BLOOD_GROUP_LABELS, BLOOD_GROUPS, type BloodGroup } from "@/features/donors/schemas";
import { PRIVACY_NOTICE_VERSION } from "@/features/legal";
import { requestApi } from "@/features/requests/api-client";
import {
  bloodStepSchema,
  COMPONENT_LABELS,
  COMPONENTS,
  hospitalStepSchema,
  patientStepSchema,
  PRIORITIES,
  PRIORITY_LABELS,
  type Component,
  type Priority,
} from "@/features/requests/schemas";
import type { CreateRequestResponse } from "@/features/requests/types";
import { formatNationalDigits, INDIA_COUNTRY_CODE, toNationalDigits } from "@/lib/validation/phone";

type Errors = Partial<Record<string, string>>;

interface FormState {
  patientName: string;
  patientAge: string;
  contactName: string;
  contactDigits: string;
  bloodGroup: BloodGroup | null;
  component: Component | null;
  unitsRequested: number;
  requiredByLocal: string;
  priority: Priority | null;
  hospitalName: string;
  hospitalAddress: string;
  city: string;
  locality: string;
  hospitalPhone: string;
  location: { latitude: number; longitude: number } | null;
  whatsappUpdates: boolean;
  consent: boolean;
}

const STEPS = [
  { key: "patient", title: "Patient & contact" },
  { key: "blood", title: "Blood needed" },
  { key: "hospital", title: "Hospital & location" },
  { key: "review", title: "Review & submit" },
] as const;

const FIELD_STEP: Record<string, number> = {
  patientName: 0, patientAge: 0, contactName: 0, contactPhone: 0,
  bloodGroup: 1, component: 1, unitsRequested: 1, requiredBy: 1, priority: 1,
  hospitalName: 2, hospitalAddress: 2, city: 2, locality: 2, hospitalPhone: 2, location: 2,
};

/** "YYYY-MM-DDTHH:mm" in the browser's local time, for datetime-local inputs. */
function toLocalInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const hoursFromNow = (h: number) => toLocalInput(new Date(Date.now() + h * 60 * 60 * 1000));

const initialState: FormState = {
  patientName: "", patientAge: "", contactName: "", contactDigits: "",
  bloodGroup: null, component: null, unitsRequested: 1, requiredByLocal: "", priority: null,
  hospitalName: "", hospitalAddress: "", city: "", locality: "", hospitalPhone: "", location: null,
  whatsappUpdates: false, consent: false,
};

function issuesToErrors(issues: { path: PropertyKey[]; message: string }[]): Errors {
  const errors: Errors = {};
  for (const issue of issues) errors[String(issue.path[0] ?? "form")] ??= issue.message;
  return errors;
}

export function RequestForm() {
  const id = useId();
  const f = (name: string) => `${id}-${name}`;
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(initialState);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CreateRequestResponse | null>(null);
  // One key per request, created on first submit and reused for retries (double taps,
  // flaky networks), so they never create duplicates. Reset only after a success.
  const idempotencyKey = useRef<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((s) => ({ ...s, [key]: value }));
    setErrors((e) => ({ ...e, [key === "contactDigits" ? "contactPhone" : key === "requiredByLocal" ? "requiredBy" : key]: undefined }));
  };

  const values = {
    patient: () => ({
      patientName: form.patientName,
      patientAge: form.patientAge.trim() === "" ? null : Number(form.patientAge),
      contactName: form.contactName,
      contactPhone: form.contactDigits,
    }),
    blood: () => ({
      bloodGroup: form.bloodGroup ?? undefined,
      component: form.component ?? undefined,
      unitsRequested: form.unitsRequested,
      requiredBy: form.requiredByLocal ? new Date(form.requiredByLocal).toISOString() : undefined,
      priority: form.priority ?? undefined,
    }),
    hospital: () => ({
      hospitalName: form.hospitalName,
      hospitalAddress: form.hospitalAddress,
      city: form.city,
      locality: form.locality,
      hospitalPhone: form.hospitalPhone.trim() ? form.hospitalPhone : null,
      location: form.location,
    }),
  };

  const scrollTop = () => requestAnimationFrame(() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

  function validateStep(index: number): boolean {
    const schema = [patientStepSchema, bloodStepSchema, hospitalStepSchema][index];
    const value = [values.patient, values.blood, values.hospital][index]();
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      setFormError("Please check the highlighted fields.");
      return false;
    }
    setFormError(null);
    return true;
  }

  function next() {
    if (!validateStep(step)) return;
    setStep((s) => s + 1);
    scrollTop();
  }

  function back() {
    setFormError(null);
    setStep((s) => Math.max(0, s - 1));
    scrollTop();
  }

  async function submit() {
    for (const index of [0, 1, 2]) {
      if (!validateStep(index)) {
        setStep(index);
        scrollTop();
        return;
      }
    }
    if (!form.consent) {
      setErrors({ consent: "Please confirm to submit the request." });
      return;
    }
    setPending(true);
    setFormError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    const response = await requestApi.create(
      { ...values.patient(), ...values.blood(), ...values.hospital(), whatsappUpdates: form.whatsappUpdates, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION },
      idempotencyKey.current,
    );
    setPending(false);
    if (!response.ok) {
      const fields = (response.error.details?.fields as Errors | undefined) ?? {};
      setErrors(fields);
      setFormError(response.error.message);
      const firstStep = Math.min(...Object.keys(fields).map((k) => FIELD_STEP[k] ?? 3));
      if (Number.isFinite(firstStep) && firstStep < 3) setStep(firstStep);
      scrollTop();
      return;
    }
    setResult(response.data);
    scrollTop();
  }

  function startOver() {
    setForm(initialState);
    setErrors({});
    setFormError(null);
    setResult(null);
    setStep(0);
    idempotencyKey.current = null;
    scrollTop();
  }

  if (result) return <Confirmation result={result} onNew={startOver} topRef={topRef} />;

  return (
    <div ref={topRef} className="scroll-mt-24">
      {/* Progress */}
      <div className="sticky top-[66px] z-20 -mx-4 border-y-2 border-ink bg-paper px-4 py-3 sm:static sm:mx-0 sm:rounded-md sm:border-2 sm:bg-surface sm:px-5 sm:shadow-brut-sm">
        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="min-w-0 font-bold text-ink">
            <span className="mr-2 inline-flex rounded-sm border-2 border-ink bg-signal-300 px-1.5 font-mono text-xs">{String(step + 1).padStart(2, "0")}/{String(STEPS.length).padStart(2, "0")}</span>
            {STEPS[step].title}
          </p>
          <p className="shrink-0 font-mono text-[0.66rem] font-bold uppercase tracking-[0.1em] text-ink-muted">~2 min</p>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s.key} className={`h-2.5 rounded-sm border-2 border-ink transition-colors duration-300 ${i < step ? "bg-ink" : i === step ? "bg-brand-500" : "bg-surface"}`} />
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-[var(--radius-card)] border-2 border-ink bg-surface p-5 shadow-brut-lg sm:p-8">
        {step === 0 && (
          <fieldset className="space-y-5">
            <legend className="sr-only">Patient and contact</legend>
            <Field id={f("patient")} label="Patient's name or initials" hint="Initials are enough. Seen only by MarutiX staff verifying the request, never shown on tracking links." error={errors.patientName}>
              <TextInput id={f("patient")} value={form.patientName} maxLength={60} autoComplete="off" onChange={(e) => set("patientName", e.target.value)} error={errors.patientName} />
            </Field>
            <Field id={f("age")} label="Patient's age" optional error={errors.patientAge}>
              <TextInput id={f("age")} type="number" inputMode="numeric" min={0} max={120} value={form.patientAge} onChange={(e) => set("patientAge", e.target.value)} error={errors.patientAge} className="max-w-32" />
            </Field>
            <Field id={f("contact")} label="Contact person's name" error={errors.contactName}>
              <TextInput id={f("contact")} autoComplete="name" value={form.contactName} maxLength={60} onChange={(e) => set("contactName", e.target.value)} error={errors.contactName} />
            </Field>
            <Field id={f("phone")} label="Contact person's mobile number" hint="Never shown publicly. MarutiX may call to verify the request." error={errors.contactPhone}>
              <div className={`flex h-12 items-center overflow-hidden rounded-md border-2 bg-surface shadow-brut-xs transition-[box-shadow,background-color] focus-within:bg-signal-50 focus-within:shadow-brut ${errors.contactPhone ? "border-danger-600" : "border-ink"}`}>
                <span className="flex h-full items-center border-r-2 border-ink bg-signal-300 px-3.5 font-mono font-bold text-ink" aria-hidden="true">{INDIA_COUNTRY_CODE}</span>
                <input
                  id={f("phone")}
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="98765 43210"
                  aria-invalid={Boolean(errors.contactPhone) || undefined}
                  value={formatNationalDigits(form.contactDigits)}
                  onChange={(e) => set("contactDigits", toNationalDigits(e.target.value).slice(0, 10))}
                  className="h-full min-w-0 flex-1 bg-transparent px-3.5 text-[1.05rem] text-ink outline-none placeholder:text-ink-muted/60"
                />
              </div>
            </Field>
          </fieldset>
        )}

        {step === 1 && (
          <fieldset className="space-y-6">
            <legend className="sr-only">Blood requirement</legend>
            <div>
              <p className="text-sm font-bold text-ink">Blood group</p>
              <div role="radiogroup" aria-label="Blood group" className="mt-2 grid grid-cols-4 gap-2">
                {BLOOD_GROUPS.map((group) => {
                  const checked = form.bloodGroup === group;
                  return (
                    <label
                      key={group}
                      className={`flex h-13 cursor-pointer items-center justify-center rounded-md border-2 font-display text-lg font-extrabold transition-[transform,box-shadow,background-color] duration-150 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${
                        group === "unknown" ? "col-span-4 font-sans text-sm font-bold" : ""
                      } ${checked ? "-translate-x-0.5 -translate-y-0.5 border-ink bg-brand-500 text-white shadow-brut" : `${errors.bloodGroup ? "border-danger-600" : "border-ink"} bg-surface text-ink shadow-brut-xs hover:bg-signal-50`}`}
                    >
                      <input type="radio" name="bloodGroup" checked={checked} onChange={() => set("bloodGroup", group)} className="sr-only" />
                      {group === "unknown" ? "Not sure yet" : BLOOD_GROUP_LABELS[group]}
                    </label>
                  );
                })}
              </div>
              {errors.bloodGroup && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errors.bloodGroup}</p>}
            </div>

            <div>
              <p className="text-sm font-bold text-ink">Component</p>
              <p className="mt-0.5 text-xs text-ink-muted">As written by the doctor or blood bank. If unsure, ask the hospital.</p>
              <div className="mt-2">
                <RadioCards name="component" value={form.component} onChange={(v) => set("component", v)} error={errors.component} options={COMPONENTS.map((c) => ({ value: c, label: COMPONENT_LABELS[c] }))} />
              </div>
              {errors.component && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errors.component}</p>}
            </div>

            <div>
              <p id={f("units-label")} className="text-sm font-bold text-ink">Units needed</p>
              <div className="mt-2 inline-flex items-center overflow-hidden rounded-md border-2 border-ink bg-surface shadow-brut-sm" role="group" aria-labelledby={f("units-label")}>
                <button type="button" aria-label="Fewer units" onClick={() => set("unitsRequested", Math.max(1, form.unitsRequested - 1))} className="h-12 w-12 border-r-2 border-ink text-xl font-bold text-ink transition-colors hover:bg-signal-300 active:bg-signal-400">−</button>
                <output aria-live="polite" className="w-16 text-center font-display text-2xl font-extrabold tabular-nums text-ink">{form.unitsRequested}</output>
                <button type="button" aria-label="More units" onClick={() => set("unitsRequested", Math.min(20, form.unitsRequested + 1))} className="h-12 w-12 border-l-2 border-ink text-xl font-bold text-ink transition-colors hover:bg-signal-300 active:bg-signal-400">+</button>
              </div>
              {errors.unitsRequested && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errors.unitsRequested}</p>}
            </div>

            <div>
              <p className="text-sm font-bold text-ink">How urgent is it?</p>
              <div className="mt-2">
                <RadioCards
                  name="priority"
                  columns={3}
                  value={form.priority}
                  onChange={(v) => {
                    set("priority", v);
                    if (!form.requiredByLocal) set("requiredByLocal", hoursFromNow(v === "critical" ? 3 : v === "urgent" ? 12 : 48));
                  }}
                  error={errors.priority}
                  options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p].label, description: PRIORITY_LABELS[p].description }))}
                />
              </div>
              {errors.priority && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errors.priority}</p>}
            </div>

            <Field id={f("by")} label="Needed by" error={errors.requiredBy}>
              <TextInput id={f("by")} type="datetime-local" min={hoursFromNow(-1)} value={form.requiredByLocal} onChange={(e) => set("requiredByLocal", e.target.value)} error={errors.requiredBy} />
              <div className="mt-2 flex flex-wrap gap-2">
                {[["In 2 hours", 2], ["In 6 hours", 6], ["In 24 hours", 24]].map(([label, h]) => (
                  <button key={label} type="button" onClick={() => set("requiredByLocal", hoursFromNow(Number(h)))} className="inline-flex min-h-10 items-center rounded-sm border-2 border-ink bg-surface px-3 font-mono text-xs font-bold uppercase tracking-[0.06em] text-ink shadow-brut-xs transition-colors hover:bg-signal-300">
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </fieldset>
        )}

        {step === 2 && (
          <fieldset className="space-y-5">
            <legend className="sr-only">Hospital and location</legend>
            <Field id={f("hospital")} label="Hospital name" error={errors.hospitalName}>
              <TextInput id={f("hospital")} value={form.hospitalName} maxLength={120} onChange={(e) => set("hospitalName", e.target.value)} error={errors.hospitalName} />
            </Field>
            <Field id={f("address")} label="Hospital address" error={errors.hospitalAddress}>
              <TextInput id={f("address")} autoComplete="street-address" value={form.hospitalAddress} maxLength={200} onChange={(e) => set("hospitalAddress", e.target.value)} error={errors.hospitalAddress} />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id={f("city")} label="City" error={errors.city}>
                <TextInput id={f("city")} autoComplete="address-level2" value={form.city} maxLength={60} onChange={(e) => set("city", e.target.value)} error={errors.city} />
              </Field>
              <Field id={f("locality")} label="Locality or area" error={errors.locality}>
                <TextInput id={f("locality")} autoComplete="address-level3" value={form.locality} maxLength={80} onChange={(e) => set("locality", e.target.value)} error={errors.locality} />
              </Field>
            </div>
            <Field id={f("hphone")} label="Hospital or blood bank phone" optional hint="Helps MarutiX verify the request quickly." error={errors.hospitalPhone}>
              <TextInput id={f("hphone")} type="tel" inputMode="tel" value={form.hospitalPhone} maxLength={20} onChange={(e) => set("hospitalPhone", e.target.value)} error={errors.hospitalPhone} />
            </Field>
            <div>
              <p className="flex items-baseline justify-between text-sm font-bold text-ink">
                Your current location <span className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink-muted">Optional</span>
              </p>
              <div className="mt-2">
                <LocationPicker
                  value={form.location}
                  onChange={(v) => set("location", v)}
                  precision={3}
                  addedLabel="Approximate device location added (about 100 m)"
                  deniedHint="That's fine: the hospital address above is enough."
                  description="Optional. Your device's approximate location helps MarutiX see where help is needed. It isn't the hospital's verified location and is never shown on tracking links."
                />
              </div>
            </div>
          </fieldset>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <ReviewSection title="Patient & contact" onEdit={() => setStep(0)}>
              <Row label="Patient" value={`${form.patientName}${form.patientAge ? `, ${form.patientAge} yrs` : ""}`} />
              <Row label="Contact" value={`${form.contactName} · ${INDIA_COUNTRY_CODE} ${formatNationalDigits(form.contactDigits)}`} />
            </ReviewSection>
            <ReviewSection title="Blood needed" onEdit={() => setStep(1)}>
              <Row label="Blood group" value={form.bloodGroup ? (form.bloodGroup === "unknown" ? "Not sure yet" : BLOOD_GROUP_LABELS[form.bloodGroup]) : "-"} />
              <Row label="Component" value={form.component ? COMPONENT_LABELS[form.component] : "-"} />
              <Row label="Units" value={String(form.unitsRequested)} />
              <Row label="Urgency" value={form.priority ? PRIORITY_LABELS[form.priority].label : "-"} />
              <Row label="Needed by" value={form.requiredByLocal ? formatIST(new Date(form.requiredByLocal).toISOString()) : "-"} />
            </ReviewSection>
            <ReviewSection title="Hospital & location" onEdit={() => setStep(2)}>
              <Row label="Hospital" value={form.hospitalName} />
              <Row label="Address" value={`${form.hospitalAddress}, ${form.locality}, ${form.city}`} />
              {form.hospitalPhone && <Row label="Hospital phone" value={form.hospitalPhone} />}
              <Row label="Your location" value={form.location ? "Approximate device location shared" : "Not shared"} />
            </ReviewSection>

            <Checkbox id={f("wa")} checked={form.whatsappUpdates} onChange={(v) => set("whatsappUpdates", v)}>
              <strong className="font-semibold text-ink">Send me a WhatsApp confirmation</strong> with the request ID and a view-only tracking link, to the contact number above.
              <span className="mt-1 block text-xs text-ink-muted">Optional. Sent from the MarutiX pilot number (WhatsApp Web). Reply STOP any time.</span>
            </Checkbox>
            <Checkbox id={f("consent")} checked={form.consent} onChange={(v) => set("consent", v)} error={errors.consent}>
              <strong className="font-semibold text-ink">I confirm these details are accurate.</strong> MarutiX may contact me and the hospital to verify this request, and may share
              only the blood need, hospital and area (never the patient&apos;s name or my number) with people who can help. See the{" "}
              <Link href="/privacy" target="_blank" className="font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-2">privacy notice</Link>.
            </Checkbox>
            {errors.consent && <p role="alert" className="text-xs font-medium text-danger-600">{errors.consent}</p>}

            <Notice tone="warn" as="p">
              MarutiX doesn&apos;t guarantee blood availability. Blood screening, compatibility and transfusion are decided only by the hospital&apos;s licensed blood centre. Keep working with the hospital while this request is verified.
            </Notice>
          </div>
        )}

        {formError && (
          <Notice tone="danger" role="alert" className="mt-6">
            {formError}
          </Notice>
        )}

        <div className="mt-8 flex flex-col-reverse gap-3 border-t-2 border-ink pt-6 sm:flex-row sm:justify-between">
          {step > 0 ? (
            <Button type="button" variant="ghost" onClick={back} disabled={pending}>
              <ArrowLeftIcon className="size-4" /> Back
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button type="button" size="lg" onClick={next} className="sm:min-w-44">
              Continue <ArrowRightIcon className="size-4.5" />
            </Button>
          ) : (
            <Button type="button" size="lg" onClick={submit} disabled={pending} className="sm:min-w-52">
              {pending ? <Spinner /> : null}
              {pending ? "Submitting…" : "Submit request"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-md border-2 border-ink">
      <div className="flex items-center justify-between border-b-2 border-ink bg-paper-deep px-4 py-1.5 sm:px-5">
        <h3 className="eyebrow text-ink">{title}</h3>
        <button type="button" onClick={onEdit} className="inline-flex min-h-10 items-center px-2 text-sm font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-4 hover:decoration-4">Edit</button>
      </div>
      <dl className="space-y-2 p-4 text-sm sm:p-5">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="break-words font-semibold text-ink sm:text-right">{value}</dd>
    </div>
  );
}

const WHATSAPP_MESSAGES: Record<CreateRequestResponse["whatsappConfirmation"], string | null> = {
  queued: "A WhatsApp confirmation with a view-only tracking link is on its way to your contact number.",
  unavailable: "We couldn't send a WhatsApp confirmation right now, so please save your private link below.",
  suppressed: "This number has opted out of MarutiX WhatsApp messages, so no confirmation was sent. Save your private link below.",
  not_requested: null,
};

function Confirmation({ result, onNew, topRef }: { result: CreateRequestResponse; onNew: () => void; topRef: React.RefObject<HTMLDivElement | null> }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };
  const whatsapp = WHATSAPP_MESSAGES[result.whatsappConfirmation];

  return (
    <div ref={topRef} className="scroll-mt-24 space-y-5">
      <section className="relative rounded-[var(--radius-card)] border-2 border-ink bg-surface p-6 text-center shadow-brut-lg sm:p-10" role="status">
        <span className="animate-pop mx-auto flex size-16 items-center justify-center rounded-md border-2 border-ink bg-mint-400 text-ink shadow-brut-sm [--pop-rotate:-6deg]">
          <CheckIcon className="size-8" strokeWidth={3} />
        </span>
        <h2 className="mt-5 font-display text-4xl font-extrabold tracking-[-0.045em] text-ink">Request received</h2>
        <p className="mt-2 text-ink-soft">Your request ID</p>
        <button
          type="button"
          onClick={() => copy(result.publicRequestId, "id")}
          className="brut-press mt-2 inline-flex max-w-full items-center gap-3 rounded-md border-2 border-ink bg-signal-300 px-4 py-2 font-mono text-xl font-bold tracking-wider text-ink sm:text-2xl"
          aria-label={`Copy request ID ${result.publicRequestId}`}
        >
          {result.publicRequestId}
          <span className="rounded-sm bg-ink px-1.5 py-0.5 font-mono text-[0.65rem] font-bold uppercase tracking-[0.1em] text-white">{copied === "id" ? "Copied" : "Copy"}</span>
        </button>
        <div className="mt-4 flex justify-center">
          <StatusBadge status={result.status} />
        </div>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-soft">
          Your request is <strong>active</strong>. Nearby registered donor matching and hospital coordination have started automatically.
        </p>
        {result.replayed && <p className="mt-2 text-xs text-ink-muted">This request was already submitted; you&apos;re seeing the same confirmation.</p>}
      </section>

      <section className="rounded-[var(--radius-card)] border-2 border-ink bg-brand-50 p-5 shadow-brut sm:p-6">
        <h3 className="font-display text-xl font-extrabold tracking-[-0.02em] text-ink">Save your private tracking link</h3>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          It shows the latest status and lets you update or cancel this request. Anyone with it can manage the request, so share it only with people you trust.
          It works until {formatIST(result.manageLinkExpiresAt)}.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input readOnly value={result.manageUrl} aria-label="Private tracking link" onFocus={(e) => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-md border-2 border-ink bg-surface px-3 font-mono text-xs text-ink" />
          <Button variant="secondary" onClick={() => copy(result.manageUrl, "link")}>
            {copied === "link" ? "Copied" : "Copy link"}
          </Button>
          <a href={result.manageUrl} className={buttonClasses({ className: "text-sm" })}>
            Open tracking page
          </a>
        </div>
        {whatsapp && (
          <p className="mt-4 flex gap-2 text-sm text-ink-soft">
            <ChatIcon className="mt-0.5 size-4 shrink-0 text-success-600" /> {whatsapp}
          </p>
        )}
      </section>

      <section className="rounded-[var(--radius-card)] border-2 border-ink bg-surface p-5 shadow-brut sm:p-6">
        <h3 className="font-display text-xl font-extrabold tracking-[-0.02em] text-ink">While we verify</h3>
        <ul className="mt-3 space-y-2.5 text-sm text-ink-soft">
          <li className="flex gap-2.5"><PhoneIcon className="mt-0.5 size-4 shrink-0 text-brand-600" /><span>Keep talking to the hospital&apos;s blood bank. They decide what&apos;s needed and test compatibility.</span></li>
          <li className="flex gap-2.5"><InfoIcon className="mt-0.5 size-4 shrink-0 text-brand-600" /><span>Check stock at government blood centres on <a href="https://eraktkosh.mohfw.gov.in/" target="_blank" rel="noopener noreferrer" className="font-bold text-ink underline decoration-brand-500 decoration-2 underline-offset-2">e-RaktKosh</a>.</span></li>
          <li className="flex gap-2.5"><AlertIcon className="mt-0.5 size-4 shrink-0 text-brand-600" /><span>If life is at risk, call <a href="tel:112" className="font-semibold text-ink underline">112</a>.</span></li>
        </ul>
        <Button variant="ghost" onClick={onNew} className="mt-5 text-sm">
          Submit a different request
        </Button>
      </section>
    </div>
  );
}
