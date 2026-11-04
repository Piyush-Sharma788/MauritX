import { Hero } from "@/components/landing/hero";
import { SafetyNotice } from "@/components/landing/safety-notice";
import { DonorBand, Faq, HowItWorks, TrustSafety } from "@/components/landing/sections";

export default function HomePage() {
  return (
    <>
      <Hero />
      <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
        <SafetyNotice />
      </div>
      <HowItWorks />
      <TrustSafety />
      <DonorBand />
      <Faq />
    </>
  );
}
