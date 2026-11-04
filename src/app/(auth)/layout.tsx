import Link from "next/link";
import { ArrowLeftIcon } from "@/components/ui/icons";
import { Logo } from "@/components/ui/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:h-[4.5rem]">
        <Logo />
        <Link href="/" className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-ink-soft hover:bg-ink/5 hover:text-ink">
          <ArrowLeftIcon className="size-4" /> Home
        </Link>
      </header>
      <main id="main" className="flex flex-1">
        {children}
      </main>
    </div>
  );
}
