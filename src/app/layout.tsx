import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Noto_Sans_Devanagari } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"], display: "swap" });
const body = Geist({ variable: "--font-geist", subsets: ["latin"], display: "swap" });
const devanagari = Noto_Sans_Devanagari({
  variable: "--font-noto-devanagari",
  subsets: ["devanagari"],
  weight: ["500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "MarutiX — Every Drop Matters. Every Life Counts.", template: "%s · MarutiX" },
  description:
    "MarutiX helps families in India reach nearby voluntary blood donors and verified blood centres faster, with consent and privacy built in.",
  applicationName: "MarutiX",
};

export const viewport: Viewport = {
  themeColor: "#fbf8f5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${display.variable} ${body.variable} ${devanagari.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
