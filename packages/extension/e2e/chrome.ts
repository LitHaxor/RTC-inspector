import { chromium } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Branded Chrome ignores --load-extension, so use a Chrome for Testing build:
 * CHROME_FOR_TESTING if set, else the newest one Playwright has cached on macOS,
 * else the build this Playwright version installs (`playwright install chromium`, as CI does).
 */
export function chromeForTesting(): string | undefined {
  if (process.env.CHROME_FOR_TESTING) return process.env.CHROME_FOR_TESTING;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const b of builds) {
      const exe = join(cache, b, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(exe)) return exe;
    }
  }
  const bundled = chromium.executablePath();
  return existsSync(bundled) ? bundled : undefined;
}
