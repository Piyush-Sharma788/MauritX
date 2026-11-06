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
  const box = tone === "ink" ? "bg-surface text-ink-soft" : "bg-paper text-ink-soft";
  const star = "bg-brand-300";
  const row = (
    <ul className="flex shrink-0 items-center">
      {ITEMS.map((item) => (
        <li key={item} className="flex items-center">
          <span lang={/[ऀ-ॿ]/.test(item) ? "hi" : undefined} className={`whitespace-nowrap px-5 ${/[ऀ-ॿ]/.test(item) ? "font-deva text-base font-medium text-brand-600" : "font-display text-[0.95rem] font-medium"}`}>
            {item}
          </span>
          <span className={`size-1.5 rounded-full ${star}`} />
        </li>
      ))}
    </ul>
  );
  return (
    <div aria-hidden="true" className={`relative flex overflow-hidden border-b border-line py-3.5 ${box}`}>
      <div className="flex w-max animate-marquee motion-reduce:animate-none">
        {row}
        {row}
      </div>
    </div>
  );
}
