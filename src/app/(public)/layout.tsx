import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";

export default function PublicLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-brand-400 focus:bg-signal-100 focus:px-4 focus:py-2 focus:font-bold focus:text-ink"
      >
        Skip to content
      </a>
      <div className="on-dark border-b border-line bg-brand-500 text-white">
        <p className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 py-1.5 text-center text-[0.8rem] font-semibold sm:px-6">
          <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-white" />
          <span>
            Medical emergency? Call{" "}
            <a href="tel:112" className="font-semibold underline underline-offset-2">112</a>{" "}
            now and contact the treating hospital.
          </span>
        </p>
      </div>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
