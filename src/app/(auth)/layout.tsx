import Link from "next/link";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col bg-grid">
      <header className="border-b-2 border-ink bg-paper">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:h-[4.5rem]">
        <Logo />
        <Link href="/" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border-2 border-transparent px-3 py-2 text-sm font-semibold text-ink transition-colors hover:border-ink hover:bg-signal-300">
          <ArrowLeftIcon className="size-4" /> Home
        </Link>
        </div>
      </header>
      <main id="main" className="flex flex-1">
        {children}
      </main>
    </div>
  );
}
