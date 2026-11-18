# Releasing RTC Inspector

Releases go to the Chrome Web Store from GitHub Actions. Pushing a tag such as `v0.2.0`:

1. checks that the tag matches the version in `packages/extension/public/manifest.json` and `packages/extension/package.json`;
2. runs the full CI: typecheck, unit tests with the coverage gate, build, store packaging, and both end-to-end suites (including one that installs the store zip in Chrome);
3. uploads that exact tested zip to the Chrome Web Store through the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api) and submits it for review;
4. creates a GitHub release with the zip attached.

The workflow is [.github/workflows/release.yml](.github/workflows/release.yml); the upload client is [packages/extension/scripts/publish.ts](packages/extension/scripts/publish.ts).

## One-time setup

### 1. Publish the first version by hand

The API can update an item but cannot create one.

1. Run `pnpm package:extension`.
2. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), click **New item** and upload `packages/extension/release/rtc-inspector-0.1.0.zip`.
3. Fill in the **Store listing**, **Privacy** and **Distribution** tabs from [packages/extension/store/LISTING.md](packages/extension/store/LISTING.md), then submit for review.

Your Google account needs 2-step verification to publish.

Write down two IDs:

- **Item ID**: the 32-character extension ID on the item's **Package** tab.
- **Publisher ID**: on the dashboard's publisher **Settings** page.

### 2. Create a service account

The service account replaces a personal OAuth token. It doesn't expire weekly, and it can only act on this publisher's items.

1. In [Google Cloud](https://console.cloud.google.com), create or pick a project. Enable the **Chrome Web Store API** under **APIs & Services**.
2. Under [IAM > Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), create a service account. Grant it no roles.
3. On the service account, open **Keys > Add key > Create new key > JSON**, and download the key file.
4. In the Developer Dashboard's **Account** section, add the service account's email. A publisher can have one service account.

If your organization blocks key creation, see [Without a key file](#without-a-key-file).

### 3. Give the key to GitHub

Create an environment named `chrome-web-store` that holds the key and the two IDs. Only the publish job can read them.

```sh
gh api -X PUT repos/LitHaxor/RTC-inspector/environments/chrome-web-store
gh secret set CWS_SERVICE_ACCOUNT_KEY --env chrome-web-store < path/to/key.json
gh variable set CWS_PUBLISHER_ID --env chrome-web-store --body "<publisher id>"
gh variable set CWS_ITEM_ID --env chrome-web-store --body "<item id>"
```

Delete the downloaded key file afterwards.

Optional, under **Settings > Environments > chrome-web-store**:

- **Required reviewers**: every submission waits for your approval in the Actions tab.
- **Deployment branches and tags**: allow only `main` and tags matching `v*`.

### 4. Check the setup

Open **Actions > Release > Run workflow** with **dry run** ticked (the default). After CI it signs in, reads the item's status and reports the published version. Nothing is uploaded.

## Each release

1. Bump `version` in both `packages/extension/public/manifest.json` and `packages/extension/package.json`, for example to `0.2.0`, and merge to `main`.
2. Tag the merged commit and push the tag:

   ```sh
   git switch main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Follow the run under **Actions > Release**. Its summary shows the published version, the upload and the submission state (normally `PENDING_REVIEW`).

Review usually takes from a few hours to a few days. Once approved, the version goes live automatically. To decide yourself when it goes live, run the workflow by hand on the tag with **publish type: staged**. Then press **Publish** in the dashboard after approval.

## When a release fails

| Message | What to do |
| --- | --- |
| `Tag v… does not match version …` | Tag the commit whose manifest and package.json carry that version. |
| `Version … is not higher than the published version …` | Bump both version fields; the store only accepts higher versions. |
| `Version … is still in review` | Wait for the review, or cancel that submission in the dashboard, then rerun the workflow. |
| `HTTP 403 PERMISSION_DENIED` | Check that the service account email is added in the dashboard's Account section, and that `CWS_PUBLISHER_ID` and `CWS_ITEM_ID` belong to that publisher. |
| Submission refused after a visibility change | After changing visibility in the dashboard, publish once by hand; the API publishes with the existing visibility only. |
| `Missing CWS_…` | The environment's secret or variables are not set; see step 3. |

To retry a release that failed before the upload (CI, sign-in, a missing secret), rerun the failed jobs, or run the workflow by hand on the same tag with **dry run** unticked. If the upload went through but the submission failed, the new version is waiting as a draft: press **Submit for review** in the dashboard instead of uploading it again.

## Without a key file

`publish.ts` also accepts a ready access token in `CWS_ACCESS_TOKEN` in place of the key. From your own machine:

```sh
pnpm package:extension
cd packages/extension
CWS_PUBLISHER_ID=… CWS_ITEM_ID=… \
CWS_ACCESS_TOKEN="$(gcloud auth print-access-token --impersonate-service-account=SA_EMAIL --scopes=https://www.googleapis.com/auth/chromewebstore)" \
node scripts/publish.ts --dry-run
```

To get keyless publishing in CI, use [Workload Identity Federation](https://github.com/google-github-actions/auth). The `google-github-actions/auth` step with `token_format: access_token` and the scope above produces a token you can pass as `CWS_ACCESS_TOKEN`.
