"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { AlertIcon, ChatIcon, CheckIcon, InfoIcon, PhoneIcon, ShieldIcon, XIcon } from "@/components/ui/icons";
import { whatsappAdminApi } from "@/features/whatsapp/api-client";
import {
  MESSAGE_TEXT_MAX_LENGTH,
  type MessageLogEntry,
  type MessageStatus,
  type WhatsAppQrResponse,
  type WhatsAppStatusResponse,
} from "@/features/whatsapp/types";
import { formatNationalDigits, INDIA_COUNTRY_CODE, normalizeIndianMobile, toNationalDigits } from "@/lib/validation/phone";

const STATUS_POLL_MS = 3_000;
const QR_POLL_MS = 5_000;
const LOG_POLL_MS = 10_000;

const dateTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const timeOnly = new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" });
const DISCONNECT_REASONS: Record<string, string> = {
  LOGGED_OUT_BY_ADMIN: "Disconnected by an admin",
  LOGOUT: "Unlinked from the phone",
  WORKER_STOPPED: "Worker stopped",
  PAIRING_TIMEOUT: "QR code not scanned in time",
  AUTH_FAILURE: "Authentication failed",
  INITIALIZE_FAILED: "WhatsApp Web failed to start",
  CONFLICT: "Opened elsewhere (session conflict)",
  UNPAIRED: "Device unpaired",
};
const reasonLabel = (reason: string) => DISCONNECT_REASONS[reason] ?? reason;

const fmt = (iso: string | null) => (iso ? `${dateTime.format(new Date(iso))} IST` : "Never");

type Display = { label: "Connected" | "Connecting" | "Disconnected" | "Authentication failed"; detail: string; tone: "success" | "progress" | "idle" | "danger" };

function describe(status: WhatsAppStatusResponse | null): Display {
  if (!status) return { label: "Disconnected", detail: "Loading status…", tone: "idle" };
  if (!status.workerOnline) return { label: "Disconnected", detail: "The WhatsApp worker isn't running.", tone: "idle" };
  switch (status.state) {
    case "connected":
      return { label: "Connected", detail: "Ready to send pilot messages.", tone: "success" };
    case "qr_required":
      return { label: "Connecting", detail: "Waiting for the QR code to be scanned.", tone: "progress" };
    case "connecting":
      return { label: "Connecting", detail: "Starting WhatsApp Web and restoring the session…", tone: "progress" };
    case "auth_failed":
      return { label: "Authentication failed", detail: "WhatsApp rejected the session. Reconnect to pair again.", tone: "danger" };
    default:
      return { label: "Disconnected", detail: "Not linked to WhatsApp.", tone: "idle" };
  }
}

const TONE_CLASSES: Record<Display["tone"], string> = {
  success: "bg-success-50 text-success-600 ring-success-600/20",
  progress: "bg-warning-50 text-warning-800 ring-warning-200",
  idle: "bg-paper-deep text-ink-soft ring-line-strong",
  danger: "bg-danger-50 text-danger-600 ring-danger-600/20",
};

const DOT_CLASSES: Record<Display["tone"], string> = {
  success: "bg-success-600",
  progress: "bg-warning-800 animate-pulse",
  idle: "bg-ink-muted",
  danger: "bg-danger-600",
};

export function WhatsAppPanel() {
  const [status, setStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [qr, setQr] = useState<WhatsAppQrResponse | null>(null);
  const [messages, setMessages] = useState<MessageLogEntry[]>([]);
  const [action, setAction] = useState<"connect" | "reconnect" | "logout" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const refreshStatus = useCallback(async () => {
    const result = await whatsappAdminApi.status();
    if (result.ok) {
      setStatus(result.data);
      setStatusError(null);
    } else {
      setStatusError(result.error.message);
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    const result = await whatsappAdminApi.messages();
    if (result.ok) setMessages(result.data.messages);
  }, []);

  useEffect(() => {
    const tick = () => void refreshStatus();
    tick();
    const id = window.setInterval(tick, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    const tick = () => void refreshMessages();
    tick();
    const id = window.setInterval(tick, LOG_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshMessages]);

  const needsQr = status?.workerOnline === true && status.state === "qr_required";
  useEffect(() => {
    if (!needsQr) return;
    let cancelled = false;
    const tick = async () => {
      const result = await whatsappAdminApi.qr();
      if (!cancelled) setQr(result.ok ? result.data : null);
    };
    void tick();
    const id = window.setInterval(() => void tick(), QR_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [needsQr]);

  async function run(kind: "connect" | "reconnect" | "logout") {
    setAction(kind);
    setActionError(null);
    const result = kind === "logout" ? await whatsappAdminApi.logout() : await whatsappAdminApi.connect(kind === "reconnect");
    setAction(null);
    setConfirmLogout(false);
    if (!result.ok) setActionError(result.error.message);
    await refreshStatus();
  }

  const visibleQr = needsQr ? qr : null;
  const display = describe(status);
  const online = status?.workerOnline === true;
  const running = online && (status.state === "connected" || status.state === "connecting" || status.state === "qr_required");
  const disabled = action !== null || Boolean(status?.busy);

  return (
    <div className="space-y-5">
      <aside className="flex gap-3 rounded-2xl border border-warning-200 bg-warning-50 p-4 text-sm leading-relaxed text-warning-800 sm:p-5">
        <AlertIcon className="mt-0.5 size-5 shrink-0" />
        <div>
          <p>
            <strong className="font-semibold">Controlled pilot.</strong> This integration uses{" "}
            <code className="rounded bg-warning-200/50 px-1">whatsapp-web.js</code>, an unofficial WhatsApp Web client. It
            is not the official WhatsApp Business Platform and has no delivery guarantee. WhatsApp may restrict or ban the
            linked number.
          </p>
          <p className="mt-1.5">
            Messages go only to consented donors or configured test numbers
            {status ? `, at most ${status.limits.maxMessagesPerHour} per hour` : ""}. Bulk or unsolicited messaging is not
            supported.
          </p>
        </div>
      </aside>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        {/* Connection */}
        <section aria-labelledby="wa-connection" className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <ChatIcon className="size-5" />
              </span>
              <h2 id="wa-connection" className="font-semibold text-ink">
                Connection
              </h2>
            </div>
            <span
              role="status"
              aria-live="polite"
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ring-1 ${TONE_CLASSES[display.tone]}`}
            >
              <span className={`size-2 rounded-full ${DOT_CLASSES[display.tone]}`} />
              {display.label}
            </span>
          </div>
          <p className="mt-4 text-ink-soft">{display.detail}</p>

          {statusError && <Notice tone="danger">{statusError}</Notice>}
          {online && status?.lastError && status.state !== "connected" && <Notice tone="danger">{status.lastError}</Notice>}

          <dl className="mt-5 divide-y divide-line text-sm">
            <Row label="Linked account" value={status?.account ? `${status.account.maskedNumber}${status.account.pushName ? ` · ${status.account.pushName}` : ""}` : "None"} />
            <Row label="Last successful connection" value={fmt(status?.lastReadyAt ?? null)} />
            <Row
              label="Last disconnect"
              value={status?.lastDisconnectedAt ? `${fmt(status.lastDisconnectedAt)}${status.lastDisconnectReason ? ` · ${reasonLabel(status.lastDisconnectReason)}` : ""}` : "Never"}
            />
            <Row label="Send pacing" value={status ? `≥ ${status.limits.minSendIntervalMs / 1000}s apart · max ${status.limits.maxMessagesPerHour}/hour` : "…"} />
          </dl>

          <div className="mt-6 flex flex-wrap gap-3">
            {!running && (
              <Button onClick={() => run("connect")} disabled={disabled || !online}>
                {action === "connect" && <Spinner />}
                {status?.state === "auth_failed" ? "Pair again" : "Connect"}
              </Button>
            )}
            {running && (
              <Button variant="secondary" onClick={() => run("reconnect")} disabled={disabled}>
                {action === "reconnect" && <Spinner />}
                Reconnect
              </Button>
            )}
            {running && !confirmLogout && (
              <Button variant="danger" onClick={() => setConfirmLogout(true)} disabled={disabled}>
                Disconnect
              </Button>
            )}
          </div>

          {confirmLogout && (
            <div className="mt-4 rounded-2xl border border-danger-600/20 bg-danger-50 p-4 text-sm text-danger-600" role="alertdialog" aria-labelledby="wa-logout-title">
              <p id="wa-logout-title" className="font-semibold">Disconnect WhatsApp?</p>
              <p className="mt-1 leading-relaxed">
                This unlinks the device from the phone and deletes the saved session on the server. Queued messages wait
                until it is paired again (or expire).
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="danger-solid" onClick={() => run("logout")} disabled={action !== null} className="h-10 px-4 text-sm">
                  {action === "logout" && <Spinner />}
                  Yes, disconnect
                </Button>
                <Button variant="ghost" onClick={() => setConfirmLogout(false)} disabled={action !== null} className="h-10 px-4 text-sm">
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {actionError && <Notice tone="danger">{actionError}</Notice>}
        </section>

        {/* Pairing */}
        <section aria-labelledby="wa-pairing" className="flex flex-col rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft sm:p-7">
          <h2 id="wa-pairing" className="font-semibold text-ink">
            Pairing
          </h2>
          <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-2xl bg-paper-deep/60 p-5 text-center">
            {!online ? (
              <>
                <InfoIcon className="size-7 text-ink-muted" />
                <p className="mt-3 font-medium text-ink">Worker offline</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Start it in a terminal with <code className="rounded bg-surface px-1.5 py-0.5 text-ink">npm run whatsapp:worker</code>.
                </p>
              </>
            ) : status?.state === "qr_required" ? (
              visibleQr ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- server-generated SVG data URL */}
                  <img
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(visibleQr.svg)}`}
                    alt="WhatsApp pairing QR code"
                    className="aspect-square w-full max-w-64 rounded-xl bg-white p-2"
                  />
                  <p className="mt-4 text-sm leading-relaxed text-ink-soft">
                    On the pilot phone, open WhatsApp → <strong>Settings</strong> → <strong>Linked devices</strong> →{" "}
                    <strong>Link a device</strong>, then scan this code. It refreshes automatically.
                  </p>
                </>
              ) : (
                <Spinner className="size-6 text-ink-muted" />
              )
            ) : status?.state === "connected" ? (
              <>
                <span className="flex size-12 items-center justify-center rounded-full bg-success-50 text-success-600">
                  <CheckIcon className="size-6" />
                </span>
                <p className="mt-3 font-medium text-ink">Paired</p>
                <p className="mt-1 text-sm text-ink-soft">The session is saved and restored automatically after a restart.</p>
              </>
            ) : status?.state === "connecting" ? (
              <>
                <Spinner className="size-6 text-ink-muted" />
                <p className="mt-3 text-sm text-ink-soft">Starting WhatsApp Web…</p>
              </>
            ) : (
              <>
                <ShieldIcon className="size-7 text-ink-muted" />
                <p className="mt-3 font-medium text-ink">Not paired</p>
                <p className="mt-1 text-sm text-ink-soft">Press Connect to show a QR code. It is visible only to administrators.</p>
              </>
            )}
          </div>
        </section>
      </div>

      <TestMessageForm disabled={!online || status?.state !== "connected"} onQueued={refreshMessages} />
      <MessageLog messages={messages} onRefresh={refreshMessages} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-medium text-ink sm:text-right">{value}</dd>
    </div>
  );
}

function Notice({ tone, children }: { tone: "danger" | "success"; children: React.ReactNode }) {
  const classes = tone === "danger" ? "bg-danger-50 text-danger-600" : "bg-success-50 text-success-600";
  return (
    <p role={tone === "danger" ? "alert" : "status"} className={`mt-4 flex gap-2 rounded-xl px-3.5 py-3 text-sm leading-snug ${classes}`}>
      {tone === "danger" ? <InfoIcon className="mt-px size-4 shrink-0" /> : <CheckIcon className="mt-px size-4 shrink-0" />}
      {children}
    </p>
  );
}

function TestMessageForm({ disabled, onQueued }: { disabled: boolean; onQueued: () => Promise<void> }) {
  const ids = { phone: useId(), text: useId(), hint: useId() };
  const [digits, setDigits] = useState("");
  const [text, setText] = useState("This is a MarutiX WhatsApp pilot test message. No action is needed.");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    const phone = normalizeIndianMobile(digits);
    if (!phone) return setResult({ tone: "danger", message: "Enter a valid 10-digit Indian mobile number." });
    if (!text.trim()) return setResult({ tone: "danger", message: "Enter a message." });
    setPending(true);
    const response = await whatsappAdminApi.sendTest(phone, text, crypto.randomUUID());
    setPending(false);
    if (!response.ok) return setResult({ tone: "danger", message: response.error.message });
    setResult({ tone: "success", message: "Queued. The worker will send it shortly; watch the log below." });
    await onQueued();
  }

  return (
    <section aria-labelledby="wa-test" className="rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-soft sm:p-7">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          <PhoneIcon className="size-5" />
        </span>
        <h2 id="wa-test" className="font-semibold text-ink">
          Send a test message
        </h2>
      </div>
      <p id={ids.hint} className="mt-3 text-sm leading-relaxed text-ink-soft">
        Allowed only for numbers listed in <code className="rounded bg-paper-deep px-1">WHATSAPP_WEB_TEST_RECIPIENTS</code> or donors who
        have consented to WhatsApp alerts. Opted-out numbers are always blocked.
      </p>
      <form onSubmit={submit} noValidate className="mt-5 grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div>
          <label htmlFor={ids.phone} className="text-sm font-semibold text-ink">
            Recipient
          </label>
          <div className="mt-2 flex h-12 items-center overflow-hidden rounded-xl border border-line-strong bg-surface focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-100">
            <span className="flex h-full items-center border-r border-line bg-paper-deep/70 px-3 text-sm font-semibold text-ink">{INDIA_COUNTRY_CODE}</span>
            <input
              id={ids.phone}
              type="tel"
              inputMode="numeric"
              placeholder="98765 43210"
              aria-describedby={ids.hint}
              value={formatNationalDigits(digits)}
              onChange={(e) => setDigits(toNationalDigits(e.target.value).slice(0, 10))}
              className="h-full min-w-0 flex-1 bg-transparent px-3 text-ink outline-none placeholder:text-ink-muted/60"
            />
          </div>
        </div>
        <div>
          <label htmlFor={ids.text} className="flex justify-between text-sm font-semibold text-ink">
            Message
            <span className={`font-normal tabular-nums ${text.length > MESSAGE_TEXT_MAX_LENGTH ? "text-danger-600" : "text-ink-muted"}`}>
              {text.length}/{MESSAGE_TEXT_MAX_LENGTH}
            </span>
          </label>
          <textarea
            id={ids.text}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-2 w-full resize-y rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-ink outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
          />
        </div>
        <div className="md:col-span-2">
          <Button type="submit" disabled={disabled || pending}>
            {pending && <Spinner />}
            Queue test message
          </Button>
          {disabled && <span className="ml-3 text-sm text-ink-muted">Connect WhatsApp first.</span>}
          {result && <Notice tone={result.tone}>{result.message}</Notice>}
        </div>
      </form>
    </section>
  );
}

const STATUS_STYLES: Record<MessageStatus, string> = {
  queued: "bg-paper-deep text-ink-soft",
  sending: "bg-warning-50 text-warning-800",
  sent: "bg-brand-50 text-brand-700",
  delivered: "bg-success-50 text-success-600",
  read: "bg-success-50 text-success-600",
  failed: "bg-danger-50 text-danger-600",
  suppressed: "bg-paper-deep text-ink-muted",
};

const KIND_LABELS: Record<MessageLogEntry["kind"], string> = {
  admin_test: "Admin test",
  donor_text: "Donor message",
  emergency_request: "Emergency alert",
  opt_out_confirmation: "STOP confirmation",
  help_reply: "HELP reply",
  bot_reply: "Bot reply",
  request_confirmation: "Request confirmation",
};

function MessageLog({ messages, onRefresh }: { messages: MessageLogEntry[]; onRefresh: () => Promise<void> }) {
  return (
    <section aria-labelledby="wa-log" className="rounded-[var(--radius-card)] border border-line bg-surface shadow-soft">
      <div className="flex items-center justify-between gap-3 p-6 pb-4 sm:px-7">
        <h2 id="wa-log" className="font-semibold text-ink">
          Recent messages
        </h2>
        <Button variant="ghost" onClick={() => void onRefresh()} className="h-9 px-3 text-sm">
          Refresh
        </Button>
      </div>
      {messages.length === 0 ? (
        <p className="px-6 pb-7 text-sm text-ink-muted sm:px-7">No messages yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="border-y border-line bg-paper-deep/50 text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th scope="col" className="px-6 py-2.5 font-semibold sm:px-7">Queued</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Recipient</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Type</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-6 py-2.5 font-semibold sm:px-7">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {messages.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap px-6 py-3 text-ink-soft sm:px-7">{dateTime.format(new Date(m.createdAt))}</td>
                  <td className="whitespace-nowrap px-3 py-3 font-medium text-ink">{m.recipient}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-ink-soft">{KIND_LABELS[m.kind]}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[m.status]}`}>
                      {m.status === "failed" && <XIcon className="size-3" />}
                      {m.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-xs text-ink-muted sm:px-7">
                    {m.failureCode
                      ? `${m.failureCode}${m.attempts > 1 ? ` · ${m.attempts} attempts` : ""}`
                      : m.readAt
                        ? `Read ${timeOnly.format(new Date(m.readAt))}`
                        : m.deliveredAt
                          ? `Delivered ${timeOnly.format(new Date(m.deliveredAt))}`
                          : m.sentAt
                            ? `Sent ${timeOnly.format(new Date(m.sentAt))}`
                            : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
