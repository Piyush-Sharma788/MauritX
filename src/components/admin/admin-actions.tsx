"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ActionButton } from "@/components/admin/action-button";
import { Button, Spinner } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { inputClasses } from "@/components/ui/form";
import { coordinationApi } from "@/features/coordination/api-client";
import { CONTACT_ROLES, INSTITUTION_TYPES, type ContactStatus, type InstitutionStatus } from "@/features/coordination/schemas";

/** Client-side admin actions. Each takes only IDs from the server page and calls the admin API. */

export function BotSwitches({ botEnabled, alertsPaused }: { botEnabled: boolean; alertsPaused: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border-2 border-ink bg-paper p-3">
        <div>
          <p className="text-sm font-bold text-ink">Bot processing: {botEnabled ? "On" : "Off"}</p>
          <p className="text-xs text-ink-muted">{botEnabled ? "Replies to registrations, requests and commands." : "Only STOP is processed; other messages get no reply."}</p>
        </div>
        <ActionButton
          label={botEnabled ? "Switch bot off" : "Switch bot on"}
          variant={botEnabled ? "danger" : "primary"}
          confirm={botEnabled ? "Stop replying to everyone except STOP?" : "Start replying again?"}
          action={() => coordinationApi.setSettings({ botEnabled: !botEnabled })}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border-2 border-ink bg-paper p-3">
        <div>
          <p className="text-sm font-bold text-ink">Emergency alerts: {alertsPaused ? "Paused" : "Running"}</p>
          <p className="text-xs text-ink-muted">{alertsPaused ? "No alerts are sent or queued. Queued ones expire unsent." : "Admin-sent alert batches are delivered."}</p>
        </div>
        <ActionButton
          label={alertsPaused ? "Resume alerts" : "Pause all alerts"}
          variant={alertsPaused ? "primary" : "danger"}
          confirm={alertsPaused ? "Resume emergency alerts?" : "Pause every emergency alert now?"}
          action={() => coordinationApi.setSettings({ alertsPaused: !alertsPaused })}
        />
      </div>
    </div>
  );
}

export function RetryMessageButton({ messageId }: { messageId: string }) {
  return <ActionButton label="Retry" confirm="Send this alert again?" action={() => coordinationApi.retryMessage(messageId)} />;
}

const NEXT_INSTITUTION: Record<InstitutionStatus, { to: InstitutionStatus; label: string; danger?: boolean }[]> = {
  pending: [{ to: "verified", label: "Verify" }, { to: "rejected", label: "Reject", danger: true }],
  verified: [{ to: "suspended", label: "Suspend", danger: true }],
  rejected: [{ to: "pending", label: "Reopen" }],
  suspended: [{ to: "verified", label: "Reinstate" }],
};

export function InstitutionStatusButtons({ id, status }: { id: string; status: InstitutionStatus }) {
  return (
    <div className="flex flex-wrap gap-2">
      {NEXT_INSTITUTION[status].map((n) => (
        <ActionButton
          key={n.to}
          label={n.label}
          variant={n.danger ? "danger" : "primary"}
          confirm={n.to === "verified" ? "Licence and identity checked? Verify this institution?" : `${n.label} this institution? Its contacts lose access while it isn't verified.`}
          action={() => coordinationApi.setInstitutionStatus(id, n.to)}
        />
      ))}
    </div>
  );
}

export function ContactStatusButtons({ institutionId, contactId, status }: { institutionId: string; contactId: string; status: ContactStatus }) {
  if (status === "revoked") return <span className="text-xs text-ink-muted">Access revoked</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {status === "pending" && (
        <ActionButton label="Verify" variant="primary" confirm="Confirmed this person works there?" action={() => coordinationApi.setContactStatus(institutionId, contactId, "verified")} />
      )}
      <ActionButton label="Revoke" variant="danger" confirm="Remove this number's access now?" action={() => coordinationApi.setContactStatus(institutionId, contactId, "revoked")} />
    </div>
  );
}

function useSubmit() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit(run: () => ReturnType<typeof coordinationApi.addContact>, onOk?: () => void) {
    setPending(true);
    setError(null);
    setFields({});
    const result = await run();
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      setFields((result.error.details?.fields as Record<string, string>) ?? {});
      return;
    }
    onOk?.();
    router.refresh();
  }
  return { pending, error, fields, submit };
}

const label = "block text-xs font-bold text-ink";
const input = `${inputClasses} mt-1 h-11 border-line-strong text-sm`;

function FieldError({ message }: { message?: string }) {
  return message ? <span className="mt-1 block text-xs text-danger-600">{message}</span> : null;
}

export function AddContactForm({ institutionId }: { institutionId: string }) {
  const { pending, error, fields, submit } = useSubmit();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    await submit(
      () => coordinationApi.addContact(institutionId, { name: String(data.get("name") ?? ""), phone: String(data.get("phone") ?? ""), role: data.get("role") === "coordinator" ? "coordinator" : "staff" }),
      () => form.reset(),
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
      <label className={label}>Name<input name="name" required maxLength={60} className={input} /><FieldError message={fields.name} /></label>
      <label className={label}>WhatsApp number<input name="phone" required inputMode="tel" placeholder="98765 43210" className={input} /><FieldError message={fields.phone} /></label>
      <label className={label}>Role
        <select name="role" defaultValue="staff" className={input}>
          {CONTACT_ROLES.map((r) => <option key={r} value={r}>{r === "coordinator" ? "Coordinator (can confirm fulfilment)" : "Staff"}</option>)}
        </select>
      </label>
      <Button type="submit" className="h-11 px-5 text-sm" disabled={pending}>{pending && <Spinner />}Add as pending</Button>
      {error && <p role="alert" className="flex gap-1.5 text-xs text-danger-600 sm:col-span-4"><InfoIcon className="mt-px size-3.5 shrink-0" />{error}</p>}
    </form>
  );
}

export function CreateInstitutionForm() {
  const { pending, error, fields, submit } = useSubmit();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const value = (k: string) => String(d.get(k) ?? "").trim();
    await submit(
      () =>
        coordinationApi.createInstitution({
          type: value("type"),
          legalName: value("legalName"),
          displayName: value("displayName"),
          address: value("address"),
          city: value("city"),
          locality: value("locality"),
          publicPhone: value("publicPhone") || null,
          licenceReference: value("licenceReference") || null,
        }) as ReturnType<typeof coordinationApi.addContact>,
      () => form.reset(),
    );
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className={label}>Type
        <select name="type" defaultValue="hospital" className={input}>
          {INSTITUTION_TYPES.map((t) => <option key={t} value={t}>{t === "blood_bank" ? "Blood bank" : "Hospital"}</option>)}
        </select>
      </label>
      <label className={label}>Display name<input name="displayName" required maxLength={80} className={input} /><FieldError message={fields.displayName} /></label>
      <label className={`${label} lg:col-span-2`}>Legal name<input name="legalName" required maxLength={120} className={input} /><FieldError message={fields.legalName} /></label>
      <label className={`${label} lg:col-span-2`}>Address<input name="address" required maxLength={200} className={input} /><FieldError message={fields.address} /></label>
      <label className={label}>City<input name="city" required maxLength={60} className={input} /><FieldError message={fields.city} /></label>
      <label className={label}>Locality<input name="locality" required maxLength={80} className={input} /><FieldError message={fields.locality} /></label>
      <label className={label}>Public phone (optional)<input name="publicPhone" maxLength={24} className={input} /><FieldError message={fields.publicPhone} /></label>
      <label className={label}>Licence reference (optional)<input name="licenceReference" maxLength={80} className={input} /><FieldError message={fields.licenceReference} /></label>
      <div className="flex items-end lg:col-span-2">
        <Button type="submit" className="h-11 px-5 text-sm" disabled={pending}>{pending && <Spinner />}Add institution (pending)</Button>
      </div>
      {error && <p role="alert" className="flex gap-1.5 text-xs text-danger-600 sm:col-span-2 lg:col-span-4"><InfoIcon className="mt-px size-3.5 shrink-0" />{error}</p>}
    </form>
  );
}
