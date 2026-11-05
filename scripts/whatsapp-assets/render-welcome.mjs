#!/usr/bin/env node
/**
 * Renders the MarutiX WhatsApp welcome image:
 *
 *   node scripts/whatsapp-assets/render-welcome.mjs [--out public/whatsapp/welcome.png]
 *
 * Source: scripts/whatsapp-assets/welcome.html (plain HTML/CSS/SVG, no network).
 * Output: a 1080 x 1350 PNG (4:5, WhatsApp's tallest uncropped image ratio).
 * Fonts: Geist and Geist Mono, taken from the installed `next` package so the render
 * doesn't depend on fonts installed on this machine. Uses the Chromium that Puppeteer
 * installed (`npx puppeteer browsers install chrome` if it's missing) or
 * PUPPETEER_EXECUTABLE_PATH.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outArg = process.argv.indexOf("--out");
const out = path.resolve(root, outArg > -1 ? process.argv[outArg + 1] : "public/whatsapp/welcome.png");

const WIDTH = 1080;
const HEIGHT = 1350;

const fontDir = path.join(root, "node_modules/next/dist/next-devtools/server/font");
const fontFace = (family, file) => {
  const p = path.join(fontDir, file);
  return existsSync(p) ? `@font-face { font-family: "${family}"; src: url("${pathToFileURL(p).href}") format("woff2"); font-weight: 100 900; font-display: block; }` : "";
};
const fonts = [fontFace("MarutiX Geist", "geist-latin.woff2"), fontFace("MarutiX Geist", "geist-latin-ext.woff2"), fontFace("MarutiX Geist Mono", "geist-mono-latin.woff2")].join("\n");
if (!fonts.trim()) console.warn("Geist fonts not found in node_modules/next; falling back to system fonts.");

const html = readFileSync(path.join(here, "welcome.html"), "utf8").replace("</style>", `${fonts}\n</style>`);

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage();
  // Rendered at 1x: WhatsApp recompresses large images, and 1080 px is its native width.
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  // A file:// base so the @font-face URLs load.
  await page.goto(pathToFileURL(path.join(here, "welcome.html")).href);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  // Guard against layout regressions: nothing may overflow the canvas or its box.
  const overflow = await page.evaluate(() => {
    const problems = [];
    for (const el of document.querySelectorAll(".page *")) {
      const r = el.getBoundingClientRect();
      if (r.right > 1080 + 0.5 || r.bottom > 1350 + 0.5 || r.left < -0.5 || r.top < -0.5) problems.push(`${el.className || el.tagName} outside the canvas`);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") problems.push(`${el.className || el.tagName} clips its text`);
    }
    const page = document.querySelector(".page");
    if (page.scrollHeight > 1350) problems.push(`content is ${page.scrollHeight}px tall`);
    const families = [...new Set([...document.querySelectorAll("*")].map((e) => getComputedStyle(e).fontFamily.split(",")[0]))];
    return { problems, geist: document.fonts.check('900 40px "MarutiX Geist"'), families };
  });
  if (overflow.problems.length) {
    console.error(`Layout problems:\n  ${overflow.problems.join("\n  ")}`);
    process.exitCode = 1;
  }
  if (!overflow.geist) console.warn("Geist didn't load; the image uses a fallback font.");

  mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  console.log(`Wrote ${path.relative(root, out)} (${WIDTH}x${HEIGHT}, ${Math.round(statSync(out).size / 1024)} KB)`);
} finally {
  await browser.close();
}
