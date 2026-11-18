/**
 * Renders the toolbar icons (blue = page uses WebRTC, gray = it doesn't) to PNG
 * with a local Chrome. Run once after changing the artwork; the PNGs are committed.
 * The 128 px icon also serves as the Chrome Web Store listing icon.
 *   node scripts/make-icons.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(import.meta.dirname, "../public/icons");
mkdirSync(out, { recursive: true });

const FILL = { active: "#2b7de9", inactive: "#8b9099" };
// Two peers joined by a link, on a rounded square.
const svg = (fill) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="${fill}"/>
  <path d="M42 86 L86 42" stroke="#fff" stroke-width="11" stroke-linecap="round"/>
  <circle cx="38" cy="90" r="17" fill="#fff"/>
  <circle cx="90" cy="38" r="17" fill="#fff"/>
</svg>`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [state, fill] of Object.entries(FILL)) {
  for (const size of [16, 32, 48, 128]) {
    // Chrome Web Store guideline: the 128 px icon is 96 px of artwork with 16 px of transparent padding.
    const pad = size === 128 ? 16 : 0;
    await page.setContent(`<html><body style="margin:0;background:transparent"><div id="i" style="width:${size}px;height:${size}px;padding:${pad}px;box-sizing:border-box">${svg(fill)}</div></body></html>`);
    await page.locator("#i").screenshot({ path: `${out}/${state}-${size}.png`, omitBackground: true });
  }
}
await browser.close();
console.log("icons written to", out);
