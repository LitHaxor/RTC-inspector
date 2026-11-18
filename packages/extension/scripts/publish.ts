/**
 * Uploads the store zip to the Chrome Web Store and submits it for review,
 * through the Chrome Web Store API v2:
 *
 *   node scripts/publish.ts [--zip path] [--tag v1.2.3] [--staged] [--dry-run]
 *   node scripts/publish.ts --tag v1.2.3 --check-version   (only checks the tag against both version fields)
 *
 * Environment:
 *   CWS_PUBLISHER_ID          Developer Dashboard > Publisher > Settings
 *   CWS_ITEM_ID               the extension's ID (dashboard > Package)
 *   CWS_SERVICE_ACCOUNT_KEY   JSON key of the service account added in the dashboard's Account section
 *   CWS_ACCESS_TOKEN          instead of a key: a token with the chromewebstore scope, e.g. from
 *                             gcloud auth print-access-token --impersonate-service-account=... --scopes=...
 *
 * Before uploading it checks the item: the new version must be higher than the
 * published one, and nothing may be waiting in review. --staged publishes only
 * after you press Publish in the dashboard once the review passes. --dry-run
 * signs in and reports the item's status without changing anything.
 * The API cannot create an item: the first version is uploaded by hand.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const API = "https://chromewebstore.googleapis.com";
export const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

type Fetch = typeof globalThis.fetch;

export type UploadState = "UPLOAD_STATE_UNSPECIFIED" | "SUCCEEDED" | "IN_PROGRESS" | "UPLOAD_IN_PROGRESS" | "FAILED" | "NOT_FOUND";
export type ItemState = "ITEM_STATE_UNSPECIFIED" | "PENDING_REVIEW" | "STAGED" | "PUBLISHED" | "PUBLISHED_TO_TESTERS" | "REJECTED" | "CANCELLED";

export interface ItemRevisionStatus {
  state?: ItemState;
  distributionChannels?: { deployPercentage?: number; crxVersion?: string }[];
}

export interface ItemStatus {
  itemId?: string;
  publishedItemRevisionStatus?: ItemRevisionStatus;
  submittedItemRevisionStatus?: ItemRevisionStatus;
  lastAsyncUploadState?: UploadState;
  takenDown?: boolean;
  warned?: boolean;
}

export interface UploadResponse {
  itemId?: string;
  crxVersion?: string;
  uploadState?: UploadState;
}

export interface PublishResponse {
  itemId?: string;
  state?: ItemState;
  warningInfo?: { warnings?: { reason?: string; description?: string }[] };
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The signed assertion a service account exchanges for an access token (RFC 7523). */
export function signJwt(key: ServiceAccountKey, scope = SCOPE, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope, aud: key.token_uri ?? TOKEN_URL, iat, exp: iat + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

/** Google's error text from a failed response body, without echoing anything we sent. */
function errorText(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: string | { message?: string; status?: string }; error_description?: string };
    if (typeof json.error === "object" && json.error) return [json.error.status, json.error.message].filter(Boolean).join(": ");
    if (typeof json.error === "string") return [json.error, json.error_description].filter(Boolean).join(": ");
  } catch {
    // not JSON
  }
  return body.slice(0, 500) || "(empty response)";
}

async function call<T>(fetch: Fetch, what: string, url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status} ${errorText(body)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

export async function accessToken(key: ServiceAccountKey, fetch: Fetch = globalThis.fetch): Promise<string> {
  let assertion: string;
  try {
    assertion = signJwt(key);
  } catch (error) {
    throw new Error(`The service account key's private_key could not be used (${(error as Error).message}); paste the whole key file, unchanged.`);
  }
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const token = await call<{ access_token?: string }>(fetch, "Signing in with the service account", key.token_uri ?? TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!token.access_token) throw new Error("Signing in with the service account returned no access token");
  return token.access_token;
}

export interface StoreClient {
  fetchStatus(): Promise<ItemStatus>;
  upload(zip: Uint8Array<ArrayBuffer>): Promise<UploadResponse>;
  publish(body: { publishType: "DEFAULT_PUBLISH" | "STAGED_PUBLISH" }): Promise<PublishResponse>;
}

export function storeClient({ publisherId, itemId, token, fetch = globalThis.fetch }: { publisherId: string; itemId: string; token: string; fetch?: Fetch }): StoreClient {
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const auth = { authorization: `Bearer ${token}` };
  return {
    fetchStatus: () => call(fetch, "Reading the item's status", `${API}/v2/${name}:fetchStatus`, { method: "GET", headers: auth }),
    upload: (zip) =>
      call(fetch, "Uploading the package", `${API}/upload/v2/${name}:upload`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/zip" },
        body: zip,
      }),
    publish: (body) =>
      call(fetch, "Submitting for review", `${API}/v2/${name}:publish`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

/** Compares dotted Chrome extension versions numerically: 1.10 > 1.9, 1.0 == 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const versionOf = (revision?: ItemRevisionStatus) => revision?.distributionChannels?.find((c) => c.crxVersion)?.crxVersion;
const IN_PROGRESS = new Set<UploadState | undefined>(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);

export interface ReleaseOptions {
  client: StoreClient;
  zip: Uint8Array<ArrayBuffer>;
  version: string;
  staged?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

export interface ReleaseResult {
  published?: string;
  uploaded: boolean;
  state?: ItemState;
}

export async function release({ client, zip, version, staged = false, dryRun = false, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5_000, timeoutMs = 300_000 }: ReleaseOptions): Promise<ReleaseResult> {
  const status = await client.fetchStatus();
  const published = versionOf(status.publishedItemRevisionStatus);
  const submitted = status.submittedItemRevisionStatus;
  log(`Published: ${published ?? "nothing yet"}${status.publishedItemRevisionStatus?.state ? ` (${status.publishedItemRevisionStatus.state})` : ""}`);
  if (submitted?.state) log(`Last submission: ${versionOf(submitted) ?? "unknown version"} (${submitted.state})`);
  if (status.warned) log("Warning: the item has a policy warning; see the Developer Dashboard.");

  if (status.takenDown) throw new Error("The item was taken down for a policy violation; resolve it in the Developer Dashboard first.");
  if (submitted?.state === "PENDING_REVIEW") {
    throw new Error(`Version ${versionOf(submitted) ?? "(unknown)"} is still in review. Wait for the review, or cancel that submission in the Developer Dashboard, then release again.`);
  }
  for (const [label, other] of [["published", published], ["submitted", versionOf(submitted)]] as const) {
    if (other && compareVersions(version, other) <= 0) {
      throw new Error(`Version ${version} is not higher than the ${label} version ${other}. Bump the version in public/manifest.json and package.json.`);
    }
  }
  if (dryRun) {
    log(`Dry run: would upload version ${version} (${zip.length} bytes) and ${staged ? "stage it for a manual publish" : "publish it once approved"}.`);
    return { ...(published && { published }), uploaded: false };
  }

  const upload = await client.upload(zip);
  let state = upload.uploadState;
  const deadline = Date.now() + timeoutMs;
  while (IN_PROGRESS.has(state)) {
    if (Date.now() > deadline) throw new Error(`The upload was still processing after ${Math.round(timeoutMs / 1000)} s; check the Developer Dashboard.`);
    log("Upload is processing...");
    await sleep(pollMs);
    state = (await client.fetchStatus()).lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`The upload failed (${state ?? "no state"}): ${JSON.stringify(upload)}`);
  log(`Uploaded version ${upload.crxVersion ?? version}.`);

  const result = await client.publish({ publishType: staged ? "STAGED_PUBLISH" : "DEFAULT_PUBLISH" });
  for (const w of result.warningInfo?.warnings ?? []) log(`Warning: ${w.reason ?? ""} ${w.description ?? ""}`.trim());
  log(`Submitted: ${result.state ?? "unknown state"}${staged ? " (staged: press Publish in the dashboard after approval)" : ""}.`);
  return { ...(published && { published }), uploaded: true, ...(result.state && { state: result.state }) };
}

export interface Config {
  publisherId: string;
  itemId: string;
  key?: ServiceAccountKey;
  token?: string;
}

export function configFromEnv(env: Record<string, string | undefined>): Config {
  const missing = ["CWS_PUBLISHER_ID", "CWS_ITEM_ID"].filter((name) => !env[name]?.trim());
  if (!env.CWS_SERVICE_ACCOUNT_KEY?.trim() && !env.CWS_ACCESS_TOKEN?.trim()) missing.push("CWS_SERVICE_ACCOUNT_KEY (or CWS_ACCESS_TOKEN)");
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. See RELEASING.md.`);
  if (env.CWS_ACCESS_TOKEN?.trim()) return { publisherId: env.CWS_PUBLISHER_ID!.trim(), itemId: env.CWS_ITEM_ID!.trim(), token: env.CWS_ACCESS_TOKEN.trim() };
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(env.CWS_SERVICE_ACCOUNT_KEY!) as Partial<ServiceAccountKey>;
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_KEY is not valid JSON; paste the whole key file downloaded from Google Cloud.");
  }
  if (!key.client_email || !key.private_key) throw new Error("CWS_SERVICE_ACCOUNT_KEY has no client_email or private_key; is it a service account key?");
  return { publisherId: env.CWS_PUBLISHER_ID!.trim(), itemId: env.CWS_ITEM_ID!.trim(), key: key as ServiceAccountKey };
}

/** A release tag must name the version being shipped, in both files that carry it. */
export function checkVersions({ tag, manifest, pkg }: { tag?: string; manifest: string; pkg: string }): string {
  if (manifest !== pkg) throw new Error(`public/manifest.json says ${manifest} but package.json says ${pkg}; bump both.`);
  if (tag !== undefined && tag.replace(/^refs\/tags\//, "") !== `v${manifest}`) throw new Error(`Tag ${tag} does not match version ${manifest}; tag the release v${manifest}.`);
  return manifest;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const { values } = parseArgs({ options: { zip: { type: "string" }, tag: { type: "string" }, staged: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, "check-version": { type: "boolean", default: false } } });
  const summary = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`);
  };
  try {
    const read = (file: string) => (JSON.parse(readFileSync(join(root, file), "utf8")) as { version: string }).version;
    const version = checkVersions({ ...(values.tag && { tag: values.tag }), manifest: read("public/manifest.json"), pkg: read("package.json") });
    if (values["check-version"]) {
      console.log(`Version ${version}${values.tag ? ` matches ${values.tag}` : ""}.`);
      process.exit(0);
    }
    const zipPath = values.zip ?? join(root, "release", `rtc-inspector-${version}.zip`);
    const zip = readFileSync(zipPath);
    const config = configFromEnv(process.env);
    const token = config.token ?? (await accessToken(config.key!));
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
    summary(`### Chrome Web Store: RTC Inspector ${version}${values["dry-run"] ? " (dry run)" : ""}`);
    await release({ client: storeClient({ publisherId: config.publisherId, itemId: config.itemId, token }), zip, version, staged: values.staged, dryRun: values["dry-run"], log: summary });
  } catch (error) {
    summary(`Not published: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
