import { Hero } from "@/components/landing/hero";
import { SafetyNotice } from "@/components/landing/safety-notice";
import { DonorBand, Faq, HowItWorks, TrustSafety } from "@/components/landing/sections";
import { Ticker } from "@/components/landing/ticker";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Ticker />
      <div className="mx-auto max-w-6xl px-4 pt-12 sm:px-6 sm:pt-16">
        <SafetyNotice />
      </div>
      <HowItWorks />
      <TrustSafety />
      <DonorBand />
      <Faq />
    </>
  );
}
