import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function runScenario(page: Page, id: string) {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Scenario", exact: true }).selectOption(id);
  await page.getByRole("button", { name: "Run scenario" }).click();
}

const diagnosis = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Diagnosis" }) });

test("happy path: connects, explains each step and draws flows between peers", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await runScenario(page, "happy-path");

  const focus = page.getByRole("region", { name: /^Connection alice/ });
  await expect(focus.getByText("connected", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(focus.getByText("Done", { exact: true })).toHaveCount(6, { timeout: 10_000 });
  await expect(diagnosis(page).getByText("No problems found")).toBeVisible();

  await page.getByRole("tab", { name: "Timeline" }).click();
  const sequence = page.getByLabel("Event sequence");
  await sequence.evaluate((el) => (el.scrollTop = 0));
  await expect(sequence.getByText("Offer sent via signaling")).toBeVisible();
  await expect(sequence.getByText("Offer received via signaling")).toBeVisible();
  await expect(page.locator("line.seq-flow").first()).toBeAttached();

  // Selecting an event explains it and links to the other side.
  await sequence.getByText("Offer sent via signaling").click();
  const detail = page.getByRole("complementary", { name: "Event detail" });
  await expect(detail.getByText(/Arrived at bob/)).toBeVisible();

  // Sending a message shows up on both sides with a delivery time.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("tab", { name: "Data channels" }).click();
  await expect(page.getByRole("cell", { name: /hello/ }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("candidates never forwarded: diagnosis names the cause and the fix", async ({ page }) => {
  await runScenario(page, "candidates-dropped");
  await expect(diagnosis(page).getByText("Remote ICE candidates never arrived").first()).toBeVisible({ timeout: 15_000 });
  await expect(diagnosis(page).getByText(/Forward every 'icecandidate' event/).first()).toBeVisible();
});

test("data channel created after the offer is detected", async ({ page }) => {
  await runScenario(page, "channel-after-offer");
  await expect(diagnosis(page).getByText('DataChannel "chat" was created after negotiation')).toBeVisible({ timeout: 15_000 });
});

test("candidates overtaking the offer surface addIceCandidate failures", async ({ page }) => {
  await runScenario(page, "early-candidates");
  await expect(diagnosis(page).getByText("addIceCandidate() failed").first()).toBeVisible({ timeout: 15_000 });
  await expect(diagnosis(page).getByText("Remote ICE candidates never arrived")).toHaveCount(0);
});

test("exported trace opens in the viewer", async ({ page }) => {
  await runScenario(page, "happy-path");
  await expect(page.getByRole("region", { name: /^Connection alice/ }).getByText("Done", { exact: true })).toHaveCount(6, { timeout: 15_000 });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export trace" }).click();
  const file = await (await download).path();
  const trace = JSON.parse(await readFile(file, "utf8"));
  expect(trace.format).toBe("rtc-inspector-trace");
  expect(JSON.stringify(trace)).not.toMatch(/a=ice-pwd:(?!\[redacted\])/);

  await page.goto("/viewer");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("recorded trace")).toBeVisible();
  await expect(page.getByRole("region", { name: /^Connection alice/ }).getByText("Done", { exact: true })).toHaveCount(6);

  await page.goto("/viewer");
  await page.locator('input[type="file"]').setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"format":"nope"}') });
  await expect(page.getByRole("alert").filter({ hasText: "Could not open" })).toContainText('Unknown format "nope"');
});

test("embedded mode observes an app that never calls the inspector", async ({ page }) => {
  await page.goto("/embedded");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Chat log")).toContainText("caller got: echo: ping");
  const sequence = page.getByLabel("Event sequence");
  await expect(sequence.getByText(/Message received/).first()).toBeVisible();
  await expect(page.getByText("2 connections", { exact: false })).toBeVisible();
});
