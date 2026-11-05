import type { Metadata } from "next";
import { RequestForm } from "@/components/requests/request-form";
import { Notice, PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Request blood",
  description: "Create an emergency blood request on MarutiX. No account needed.",
  robots: { index: false },
};

export default function RequestBloodPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <PageHeader
        eyebrow="Emergency request"
        title="Request blood"
        description="No account needed. MarutiX verifies every request with the hospital before marking it verified."
      />
      <Notice tone="danger" className="mt-6">
        <strong>If life is at risk, call <a href="tel:112" className="underline decoration-2 underline-offset-2">112</a> now</strong> and speak to the hospital&apos;s blood bank. Don&apos;t wait on this request.
      </Notice>
      <div className="mt-8">
        <RequestForm />
      </div>
    </div>
  );
}
