import { describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { API, SCOPE, TOKEN_URL, accessToken, checkVersions, compareVersions, configFromEnv, release, signJwt, storeClient, type ItemStatus, type StoreClient } from "../scripts/publish";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { client_email: "ci@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);

describe("signJwt", () => {
  it("signs an RS256 assertion for the store scope that the key's public half verifies", () => {
    const jwt = signJwt(key, SCOPE, Date.UTC(2026, 10, 18, 12) + 999);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Date.UTC(2026, 10, 18, 12) / 1000;
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("uses the key's own token_uri as the audience", () => {
    const claims = signJwt({ ...key, token_uri: "https://oauth2.example/token" }).split(".")[1]!;
    expect(JSON.parse(Buffer.from(claims, "base64url").toString()).aud).toBe("https://oauth2.example/token");
  });
});

describe("accessToken", () => {
  it("exchanges the signed assertion for a token", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ access_token: "ya29.token", expires_in: 3599 }));
    expect(await accessToken(key, fetch)).toBe("ya29.token");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(TOKEN_URL);
    const body = new URLSearchParams(String(init!.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")!.split(".")).toHaveLength(3);
  });

  it("reports Google's reason when sign-in is refused, and never echoes the assertion", async () => {
    const fetch = vi.fn(async () => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400));
    const failure = accessToken(key, fetch);
    await expect(failure).rejects.toThrow("Signing in with the service account failed: HTTP 400 invalid_grant: Invalid JWT Signature.");
    await expect(failure).rejects.not.toThrow(/eyJ/);
  });

  it("explains a private key that cannot sign, without calling Google", async () => {
    const fetch = vi.fn();
    await expect(accessToken({ ...key, private_key: "not a key" }, fetch)).rejects.toThrow(/^The service account key's private_key could not be used \(.+\); paste the whole key file, unchanged\.$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails when the response has no token", async () => {
    await expect(accessToken(key, vi.fn(async () => json({})))).rejects.toThrow("returned no access token");
  });
});

describe("storeClient", () => {
  it("calls the v2 endpoints for the publisher's item with the bearer token", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ itemId: "abc" }));
    const client = storeClient({ publisherId: "pub-1", itemId: "abc", token: "t0k", fetch });
    await client.fetchStatus();
    await client.upload(zip);
    await client.publish({ publishType: "STAGED_PUBLISH" });
    expect(fetch.mock.calls.map(([url, init]) => [init!.method, url])).toEqual([
      ["GET", `${API}/v2/publishers/pub-1/items/abc:fetchStatus`],
      ["POST", `${API}/upload/v2/publishers/pub-1/items/abc:upload`],
      ["POST", `${API}/v2/publishers/pub-1/items/abc:publish`],
    ]);
    for (const [, init] of fetch.mock.calls) expect((init!.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    expect(fetch.mock.calls[1]![1]!.body).toBe(zip);
    expect(JSON.parse(String(fetch.mock.calls[2]![1]!.body))).toEqual({ publishType: "STAGED_PUBLISH" });
  });

  it("turns API errors into readable messages", async () => {
    const fetch = vi.fn(async () => json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403));
    await expect(storeClient({ publisherId: "p", itemId: "i", token: "t", fetch }).fetchStatus()).rejects.toThrow(
      "Reading the item's status failed: HTTP 403 PERMISSION_DENIED: The caller does not have permission",
    );
    const html = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(storeClient({ publisherId: "p", itemId: "i", token: "t", fetch: html }).upload(zip)).rejects.toThrow("Uploading the package failed: HTTP 502 <html>Bad gateway</html>");
    const empty = vi.fn(async () => new Response("", { status: 500 }));
    await expect(storeClient({ publisherId: "p", itemId: "i", token: "t", fetch: empty }).publish({ publishType: "DEFAULT_PUBLISH" })).rejects.toThrow("HTTP 500 (empty response)");
  });
});

describe("compareVersions", () => {
  it.each([
    ["1.10", "1.9", 1],
    ["0.1.0", "0.1", 0],
    ["0.1.0", "0.1.1", -1],
    ["2", "1.99.99.99", 1],
  ])("%s vs %s → %d", (a, b, expected) => expect(compareVersions(a, b)).toBe(expected));
});

/** A store that records what was asked of it. */
function fakeStore(status: ItemStatus, overrides: Partial<StoreClient> = {}) {
  const calls: string[] = [];
  const client: StoreClient = {
    fetchStatus: vi.fn(async () => (calls.push("status"), status)),
    upload: vi.fn(async () => (calls.push("upload"), { uploadState: "SUCCEEDED" as const, crxVersion: "0.2.0" })),
    publish: vi.fn(async (body) => (calls.push(`publish ${body.publishType}`), { state: "PENDING_REVIEW" as const })),
    ...overrides,
  };
  return { client, calls };
}

const published = (v: string): ItemStatus => ({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ deployPercentage: 100, crxVersion: v }] } });

describe("release", () => {
  it("uploads and submits a newer version for review", async () => {
    const { client, calls } = fakeStore(published("0.1.0"));
    const log: string[] = [];
    const result = await release({ client, zip, version: "0.2.0", log: (l) => log.push(l) });
    expect(calls).toEqual(["status", "upload", "publish DEFAULT_PUBLISH"]);
    expect(result).toEqual({ published: "0.1.0", uploaded: true, state: "PENDING_REVIEW" });
    expect(log).toEqual(["Published: 0.1.0 (PUBLISHED)", "Uploaded version 0.2.0.", "Submitted: PENDING_REVIEW."]);
  });

  it("stages the release when asked", async () => {
    const { client, calls } = fakeStore({});
    const log: string[] = [];
    await release({ client, zip, version: "0.1.0", staged: true, log: (l) => log.push(l) });
    expect(calls).toEqual(["status", "upload", "publish STAGED_PUBLISH"]);
    expect(log.at(-1)).toBe("Submitted: PENDING_REVIEW (staged: press Publish in the dashboard after approval).");
  });

  it("waits for an upload that is still processing", async () => {
    const statuses: ItemStatus[] = [published("0.1.0"), { lastAsyncUploadState: "IN_PROGRESS" }, { lastAsyncUploadState: "SUCCEEDED" }];
    const sleep = vi.fn(async () => {});
    const { client, calls } = fakeStore({}, {
      fetchStatus: vi.fn(async () => statuses.shift()!),
      upload: vi.fn(async () => ({ uploadState: "UPLOAD_IN_PROGRESS" as const })),
    });
    const result = await release({ client, zip, version: "0.2.0", sleep, pollMs: 10, log: () => {} });
    expect(result.uploaded).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["publish DEFAULT_PUBLISH"]);
  });

  it("gives up on an upload that never finishes processing", async () => {
    const { client } = fakeStore({}, { upload: vi.fn(async () => ({ uploadState: "IN_PROGRESS" as const })) });
    await expect(release({ client, zip, version: "0.2.0", sleep: async () => {}, timeoutMs: -1, log: () => {} })).rejects.toThrow("still processing");
  });

  it("stops when the upload fails, without submitting", async () => {
    const { client, calls } = fakeStore({}, { upload: vi.fn(async () => (calls.push("upload"), { uploadState: "FAILED" as const })) });
    await expect(release({ client, zip, version: "0.2.0", log: () => {} })).rejects.toThrow('The upload failed (FAILED): {"uploadState":"FAILED"}');
    expect(calls).toEqual(["status", "upload"]);
  });

  it.each([
    ["the published version", published("0.2.0"), "is not higher than the published version 0.2.0"],
    ["a staged version", { submittedItemRevisionStatus: { state: "STAGED", distributionChannels: [{ crxVersion: "0.3.0" }] } } as ItemStatus, "is not higher than the submitted version 0.3.0"],
  ])("refuses a version that is not higher than %s", async (_label, status, message) => {
    const { client, calls } = fakeStore(status);
    await expect(release({ client, zip, version: "0.2.0", log: () => {} })).rejects.toThrow(message);
    expect(calls).toEqual(["status"]);
  });

  it("refuses while another version is in review, or the item was taken down", async () => {
    const inReview = fakeStore({ submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.1.5" }] } });
    await expect(release({ client: inReview.client, zip, version: "0.2.0", log: () => {} })).rejects.toThrow("Version 0.1.5 is still in review");
    const takenDown = fakeStore({ takenDown: true, warned: true });
    const log: string[] = [];
    await expect(release({ client: takenDown.client, zip, version: "0.2.0", log: (l) => log.push(l) })).rejects.toThrow("taken down");
    expect(log).toContain("Warning: the item has a policy warning; see the Developer Dashboard.");
  });

  it("dry run: checks the item and changes nothing", async () => {
    const { client, calls } = fakeStore({ ...published("0.1.0"), submittedItemRevisionStatus: { state: "REJECTED", distributionChannels: [{ crxVersion: "0.1.1" }] } });
    const log: string[] = [];
    expect(await release({ client, zip, version: "0.2.0", dryRun: true, log: (l) => log.push(l) })).toEqual({ published: "0.1.0", uploaded: false });
    expect(calls).toEqual(["status"]);
    expect(log).toEqual(["Published: 0.1.0 (PUBLISHED)", "Last submission: 0.1.1 (REJECTED)", "Dry run: would upload version 0.2.0 (4 bytes) and publish it once approved."]);
  });

  it("logs publish warnings", async () => {
    const { client } = fakeStore({}, { publish: vi.fn(async () => ({ state: "PENDING_REVIEW" as const, warningInfo: { warnings: [{ reason: "BROAD_HOST_PERMISSIONS", description: "May take longer to review." }] } })) });
    const log: string[] = [];
    await release({ client, zip, version: "0.2.0", log: (l) => log.push(l) });
    expect(log).toContain("Warning: BROAD_HOST_PERMISSIONS May take longer to review.");
  });
});

describe("configFromEnv", () => {
  const base = { CWS_PUBLISHER_ID: " pub ", CWS_ITEM_ID: "item" };

  it("reads a service account key", () => {
    expect(configFromEnv({ ...base, CWS_SERVICE_ACCOUNT_KEY: JSON.stringify(key) })).toEqual({ publisherId: "pub", itemId: "item", key });
  });

  it("prefers a ready access token", () => {
    expect(configFromEnv({ ...base, CWS_ACCESS_TOKEN: "tok", CWS_SERVICE_ACCOUNT_KEY: "{}" })).toEqual({ publisherId: "pub", itemId: "item", token: "tok" });
  });

  it("names everything that is missing", () => {
    expect(() => configFromEnv({ CWS_ITEM_ID: " " })).toThrow("Missing CWS_PUBLISHER_ID, CWS_ITEM_ID, CWS_SERVICE_ACCOUNT_KEY (or CWS_ACCESS_TOKEN). See RELEASING.md.");
  });

  it("rejects keys that are not service account JSON", () => {
    expect(() => configFromEnv({ ...base, CWS_SERVICE_ACCOUNT_KEY: "not json" })).toThrow("not valid JSON");
    expect(() => configFromEnv({ ...base, CWS_SERVICE_ACCOUNT_KEY: '{"type":"authorized_user"}' })).toThrow("no client_email or private_key");
  });
});

describe("checkVersions", () => {
  it("accepts a tag that names the version in both files", () => {
    expect(checkVersions({ tag: "v1.2.3", manifest: "1.2.3", pkg: "1.2.3" })).toBe("1.2.3");
    expect(checkVersions({ tag: "refs/tags/v1.2.3", manifest: "1.2.3", pkg: "1.2.3" })).toBe("1.2.3");
    expect(checkVersions({ manifest: "1.2.3", pkg: "1.2.3" })).toBe("1.2.3");
  });

  it("rejects a mismatched tag or files", () => {
    expect(() => checkVersions({ tag: "v1.2.4", manifest: "1.2.3", pkg: "1.2.3" })).toThrow("Tag v1.2.4 does not match version 1.2.3; tag the release v1.2.3.");
    expect(() => checkVersions({ tag: "v1.2.3", manifest: "1.2.3", pkg: "1.2.2" })).toThrow("public/manifest.json says 1.2.3 but package.json says 1.2.2; bump both.");
  });
});
