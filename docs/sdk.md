# netcup-sdk

Manage Netcup servers from JavaScript or TypeScript.

```ts
const server = await netcup.servers.get(12345);
```

Unofficial SDK for Netcup's Server Control Panel (SCP) REST API and current Customer Control Panel (CCP) domain/DNS API. It covers 86 current SCP operations in API release `2026.1012.092426` and 17 current CCP operations in `2026.0921.153936`. It does not order servers, manage invoices or use the legacy CCP JSON API. Requires Node.js 22.0.0 or newer.

Version `1.0.0` raises the Node minimum from 18.3 to 22.0.0. The matching scoped alias is `@gusnips/netcup@2.0.0`; alias `1.2.0` keeps its core dependency below `1.0.0`.

## Install

```sh
npm install netcup-sdk
```

You can also install `@gusnips/netcup`. Both names export the same code and types. CommonJS `require` works too.

## Connect

If you already have an access token:

```ts
import { NetcupClient } from "netcup-sdk";

const netcup = new NetcupClient(process.env.NETCUP_ACCESS_TOKEN!);
const servers = await netcup.servers.list();
```

Access tokens expire. For scripts that run more than once, use an offline refresh token. This token gets a new access token without storing your account password.

### Approve access once

Netcup uses device login: your script gets a code, and you approve it in your browser.

```ts
import { NetcupAuth } from "netcup-sdk";

const auth = new NetcupAuth();
const device = await auth.startDeviceAuthorization();
console.log(device.verification_uri_complete ?? device.verification_uri);
console.log("Enter this code:", device.user_code);

const tokens = await auth.waitForDeviceAuthorization(device);
// Save tokens.refresh_token in your secret store, not in source control or logs.
```

`waitForDeviceAuthorization` follows Netcup's polling interval, waits longer after `slow_down` and stops when the code expires or access is denied. Pass an `AbortSignal` as the second argument to cancel. You can call `exchangeDeviceCode(device.device_code)` yourself if you want to manage polling.

### Use the saved refresh token

```ts
import { NetcupClient } from "netcup-sdk";

const netcup = new NetcupClient({
  refreshToken: process.env.NETCUP_REFRESH_TOKEN!,
  onTokens: async (tokens) => {
    // Save tokens.refresh_token if Netcup replaces it.
    await saveRefreshToken(tokens.refresh_token);
  },
});

const servers = await netcup.servers.list();
```

`saveRefreshToken` is your secret-store function. The SDK awaits `onTokens` before the request continues and does not publish cached access until saving succeeds. It shares concurrent refresh requests on that auth instance, not across separate processes. The latest token is also available at `netcup.auth.refreshToken`. If saving fails, the SDK keeps that refresh token in memory, clears cached access and throws `NetcupAuthError` with code `token_storage_failed`. A later call cannot bypass the failed save with a cached access token. Save the latest refresh token before restarting.

Netcup says offline refresh tokens must be used at least once every 30 days to stay valid. The SDK does not run a background keepalive.

If another service manages your tokens, pass `accessToken: async () => getCurrentToken()` instead. Do not pass both `accessToken` and `refreshToken`.

## Domains and DNS

CCP uses a separate API key, not an SCP login token:

```ts
import { NetcupCcpClient } from "netcup-sdk";

const ccp = new NetcupCcpClient("your-ccp-api-key");
const domains = await ccp.domains.list();
console.log(domains.result);
```

Create the key in **CCP > Master Data > API**. The client sends it as `Authorization: Bearer <key>` to `https://api.netcup.com`. It does not use legacy customer-number/password sessions. A client without a key can call the public `ccp.dns.recordTypes()` method; protected calls fail before a request if the key is missing.

All named CCP methods return the complete API envelope: `success`, `errors`, `messages`, `meta` and `result`. Keep `meta` for page information and `messages` for provider notices. Domain and revision lists use `page`/`perPage`; they do not use SCP's offset/limit. Component fields such as a revision's `identifier` are optional in the specification and remain optional in TypeScript.

| Property      | Methods                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccp.domains` | `list`, `listAcmeChallenges`, `createAcmeChallenge`, `getAcmeChallenge`, `deleteAcmeChallenge`                                                                                                          |
| `ccp.dns`     | `recordTypes`, `listRevisions`, `createRevision`, `getRevision`, `deleteRevision`, `applyChanges`, `applyRevisionChanges`, `commitRevision`, `listRecords`, `createRecord`, `getRecord`, `deleteRecord` |

ACME challenges prove domain ownership for TLS certificates. Their deletion returns `undefined` for HTTP 204. DNS record/revision deletion instead returns an envelope with `result: null`. There is no record PATCH method; a change set can delete an old record and create its replacement.

### Prepare and review a DNS change

This sends a change request. Use the intended CCP domain ID, not an SCP server ID:

```ts
const prepared = await ccp.dns.applyChanges(42, {
  autoCommit: false,
  strict: true,
  create: [{ name: "www", type: "A", rdata: "192.0.2.10", ttl: 300 }],
});
const revisionId = prepared.result.identifier;
if (!revisionId) {
  throw new Error(
    "Netcup returned no revision ID. List revisions before trying again.",
  );
}
const records = await ccp.dns.listRecords(42, revisionId);
console.log(records);
```

`42` and `192.0.2.10` are example values. Use a real domain ID and the intended IP. The SDK does not prompt for approval. Only after reviewing the exact revision, request publication explicitly:

```ts
await ccp.dns.commitRevision(42, revisionId);
```

Change-set deletion requires the full input tuple `name/type/rdata/ttl`, not a record UUID. Individual `deleteRecord` calls use the record UUID. Output TTL can be `null`; do not turn it into an invented input TTL. The API exposes an `immutable` field but does not document client-side modification rules for it.

Netcup does not document active/draft state enums, which records revision creation copies, atomic conflict preconditions or idempotency. Do not guess a current revision from list order, automatically retry a write or treat a commit response as proof of DNS propagation. Record listing has no documented paging controls; check its metadata before relying on a complete review. The CLI refuses review/commit when metadata explicitly reports missing records.

### Use both API families

You can also configure CCP under the existing client:

```ts
const netcup = new NetcupClient({
  accessToken: "your-scp-access-token",
  ccp: { apiKey: "your-ccp-api-key" },
});
const domains = await netcup.ccp.domains.list();
```

The `ccp` getter requires explicit `ccp` configuration. It never borrows the root SCP credentials, URLs or fetch function. Pass a CCP-specific `fetch` in that configuration if needed. A CCP-only client can use `new NetcupClient({ ccp: { apiKey: "your-key" } })` without an SCP token.

`ccp.api` is the separate raw `openapi-fetch` client for CCP. Raw calls expose `{ data, error, response }`; unlike named methods, they do not reject an HTTP-200 envelope with `success: false` for you. Do not share SCP headers with it.

Types include `CcpPaths`, `CcpComponents`, `CcpDomainListQuery`, `CcpDnsRecordInput` and `CcpDnsChangeSet`. The existing SCP `paths` and `components` exports have not changed.

## Server actions

```ts
await netcup.servers.update(12345, { nickname: "web-1" });
await netcup.servers.update(12345, { state: "ON" });
```

Change one setting per call. The SDK checks this and uses `application/merge-patch+json`, the format Netcup expects. For a reset, use `{ state: "ON" }` with a third argument `{ stateOption: "RESET" }`. Stopping or resetting a server can interrupt its work.

Server updates can return an immediate response or a task. The OpenAPI file leaves the immediate response unspecified, so the return type is `unknown`. Use the raw API when you need its HTTP status.

Many other actions return task data. A task means Netcup accepted the work, not that it finished. Use `netcup.tasks.get(uuid)` to check it. The SDK does not retry mutations or choose a polling policy for you.

Formatting disks, installing images and restoring snapshots replace data. Back up what you need before calling `disks.format`, `images.setup`, `images.setupUserImage` or `snapshots.revert`.

## API groups

| Property     | What it does                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| `servers`    | List servers, change settings, power state, rescue mode and storage optimization |
| `disks`      | Read disks, change drivers and format disks                                      |
| `firewall`   | Configure interface firewalls and manage user policies                           |
| `isos`       | Attach ISOs and manage uploaded ISO files                                        |
| `images`     | Install images and manage uploaded image files                                   |
| `metrics`    | Read CPU, disk, network and packet metrics                                       |
| `networking` | Manage interfaces, reverse DNS, failover IPs and VLANs                           |
| `snapshots`  | Create, export, restore and delete snapshots                                     |
| `tasks`      | List, read and cancel tasks                                                      |
| `users`      | Read users and logs, update settings and manage SSH keys                         |
| `misc`       | Ping the API and read its API documentation                                      |

Methods follow the API: `get`, `list`, `create`, `update`, `delete` and named actions. Your editor shows their parameters from the generated types. Upload methods return Netcup's signed URLs and multipart details; send file bytes to those URLs yourself.

User-scoped methods need your numeric SCP user ID, not your customer number:

```ts
const { id } = await netcup.auth.userInfo();
const keys = await netcup.users.listSshKeys(id);
```

Empty responses return `undefined`. `tasks.cancel` and `networking.updateInterface` may return task data or no body. VLAN updates return no body. The deprecated maintenance endpoint has no named method. Use `exportCount` rather than the deprecated `snapshotCount` field.

## Pagination and raw responses

The API uses `offset` and `limit`. List data stays an array; the SDK does not wrap it or fetch every page for you. Netcup returns the total in the `X-Total-Count` header.

```ts
const { data, error, response } = await netcup.api.GET("/api/v1/servers", {
  params: { query: { offset: 0, limit: 20, sort: ["name", "-nickname"] } },
});
if (error !== undefined || !response.ok) {
  throw new Error(`Netcup request failed: HTTP ${response.status}`);
}
console.log(data, response.headers.get("X-Total-Count"));
```

`netcup.api` is the full typed `openapi-fetch` client. Unlike named methods, it returns `{ data, error, response }` for HTTP responses. Network and login failures still throw. It uses the same authentication as the named methods.

Types are exported as `components`, `paths`, query types and `ServerUpdate`:

```ts
import type { components } from "netcup-sdk";
type Server = components["schemas"]["Server"];
```

## Errors

Named methods throw `NetcupError` for failed HTTP responses. CCP methods also reject `success: false` inside a successful HTTP response and malformed required envelopes. The error exposes `status` and the original `body`, including the provider's structured error codes. CCP authentication failures can use HTTP 400, not only 401.

```ts
import { NetcupError } from "netcup-sdk";

try {
  await netcup.servers.get(12345);
} catch (error) {
  if (error instanceof NetcupError) {
    console.error(error.status, error.message);
  } else {
    throw error;
  }
}
```

Login failures throw `NetcupAuthError` with `code` and optional HTTP `status`. OAuth error messages never include tokens or Netcup's raw login response. To disconnect, call `await netcup.auth.revoke()`, then delete the saved refresh token from your secret store.

## Options

`NetcupClient` accepts an access-token string or an object with `accessToken`, `refreshToken`, `onTokens`, `baseUrl`, `authUrl`, `fetch` and optional `ccp`. `NetcupCcpClient` accepts an API-key string or its own `{ apiKey, baseUrl, fetch }` options. A `fetch` function receives a `Request` and returns a `Response`; use it for tests or a custom transport.

Default SCP API URL: `https://servercontrolpanel.de/scp-core`.
Default SCP authentication URL: `https://servercontrolpanel.de/realms/scp/protocol/openid-connect`.
Default CCP API URL: `https://api.netcup.com`.

Only override those URLs with endpoints you trust: the SDK sends credentials to them.

## Use with an AI client

The same package provides a read-only MCP mode:

```sh
npx --yes netcup-sdk@1.0.0 mcp
```

The AI client starts and owns this local stdio process, which exchanges messages through its input and output streams. Run the matching SCP `login` or `ccp login` outside the client first, or supply matching environment credentials. MCP reuses the CLI's existing plaintext files and environment precedence. It never starts an interactive login.

MCP exposes nine fixed tools with selected safe fields, not every SDK method or raw API output. It has no write, auth, shell, local file-read or arbitrary HTTP tools. Imports remain free of CLI and MCP startup side effects. Standard `bunx netcup-sdk@1.0.0 mcp` uses Node and requires the same Node minimum.

See the [client setup and privacy limits](../README.md#use-with-an-ai-client). Normal CLI JSON output is unchanged; MCP reserves stdout for protocol messages.

## Development

```sh
bun install
bun run generate
bun run lint
bun run typecheck
bun run build
bun test src/client.test.ts
```

Types are generated from the separate checked-in `openapi.json` (SCP) and `openapi-ccp.json` (CCP). Tests use mocked requests, not live accounts. Run only the test file you change, such as `bun test src/ccp.test.ts`. CI typechecks ready PRs; it does not run tests or publish.

[Netcup API docs](https://www.netcup.com/en/helpcenter/documentation/servercontrolpanel/api)

MIT license. Not affiliated with Netcup.
