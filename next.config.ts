import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Development only: let this machine's own LAN addresses (e.g. opening the dev
 * server from a phone on the same Wi-Fi) load dev resources such as HMR, plus
 * any hostnames in DEV_ALLOWED_ORIGINS (comma-separated, no scheme or port).
 */
function devOrigins(): string[] {
  const own = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  const extra = (process.env.DEV_ALLOWED_ORIGINS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return [...new Set([...own, ...extra])];
}

/**
 * Baseline CSP without nonces, so pages can stay statically prerendered.
 * 'unsafe-inline' scripts are needed for Next's inline bootstrap; move to a
 * nonce-based policy in proxy.ts if a stricter policy is required.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Map tiles (Leaflet + OpenStreetMap) on the tracking page and admin maps.
  "img-src 'self' blob: data: https://tile.openstreetmap.org",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  // The Docker build sets NEXT_OUTPUT=standalone; local `npm start` keeps the default output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  ...(isDev ? { allowedDevOrigins: devOrigins() } : {}),
  turbopack: {
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // /admin has no page of its own. Redirecting here (before any rendering) avoids calling
  // redirect() inside a page, which logs "Could not validate instant" with cacheComponents.
  async redirects() {
    return [{ source: "/admin", destination: "/admin/operations", permanent: false }];
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // Tracking URLs carry a bearer token: never leak them in Referer headers, never index them.
      {
        source: "/respond/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/track/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
