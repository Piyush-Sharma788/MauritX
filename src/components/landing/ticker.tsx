/** Decorative scrolling band of MarutiX promises. Static under prefers-reduced-motion. */
const ITEMS = [
  "Consent before contact",
  "Verified by people, not algorithms",
  "No payments, ever",
  "हर बूँद मायने रखती है",
  "Clinicians decide",
  "Your number stays encrypted",
  "Life at risk? Call 112",
];

export function Ticker({ tone = "ink" }: { tone?: "ink" | "signal" }) {
  const box = tone === "ink" ? "bg-ink text-white" : "bg-signal-300 text-ink";
  const star = tone === "ink" ? "text-signal-300" : "text-brand-500";
  const row = (
    <ul className="flex shrink-0 items-center">
      {ITEMS.map((item) => (
        <li key={item} className="flex items-center">
          <span lang={/[ऀ-ॿ]/.test(item) ? "hi" : undefined} className={`whitespace-nowrap px-5 ${/[ऀ-ॿ]/.test(item) ? "font-deva text-lg font-bold" : "font-display text-lg font-extrabold uppercase tracking-[-0.01em]"}`}>
            {item}
          </span>
          <span className={`text-xl ${star}`}>✱</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div aria-hidden="true" className={`relative flex overflow-hidden border-b-2 border-ink py-3 ${box}`}>
      <div className="flex w-max animate-marquee motion-reduce:animate-none">
        {row}
        {row}
      </div>
    </div>
  );
}
