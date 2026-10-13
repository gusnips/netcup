# netcup-sdk

Manage Netcup servers from JavaScript or TypeScript.

```ts
const server = await netcup.servers.get(12345);
```

Unofficial SDK for Netcup's Server Control Panel (SCP) REST API. It covers all 86 current operations in the supplied API release `2026.1012.092426`. It does not order servers or manage DNS zones through Netcup's separate customer API. Requires Node.js 18 or newer, or Bun.

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

`saveRefreshToken` is your secret-store function. The SDK awaits `onTokens` before the request continues. It caches access tokens and shares concurrent refresh requests. The latest token is also available at `netcup.auth.refreshToken`. If saving fails, the SDK keeps that token in memory and throws `NetcupAuthError` with code `token_storage_failed`. Save it before restarting.

Netcup says offline refresh tokens must be used at least once every 30 days to stay valid. The SDK does not run a background keepalive.

If another service manages your tokens, pass `accessToken: async () => getCurrentToken()` instead. Do not pass both `accessToken` and `refreshToken`.

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

Named methods throw `NetcupError` for failed HTTP responses. It exposes `status` and the original `body`, which can be an object, an array, text or an empty value.

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

`NetcupClient` accepts an access-token string or an object with `accessToken`, `refreshToken`, `onTokens`, `baseUrl`, `authUrl` and `fetch`. `fetch` receives a `Request` and returns a `Response`; use it for tests or a custom transport.

Default API URL: `https://servercontrolpanel.de/scp-core`.
Default authentication URL: `https://servercontrolpanel.de/realms/scp/protocol/openid-connect`.

Only override those URLs with endpoints you trust: the SDK sends credentials to them.

## Development

```sh
bun install
bun run generate
bun run lint
bun run typecheck
bun run build
bun test src/client.test.ts
```

Types are generated from the checked-in `openapi.json`. Tests use mocked requests, not live servers. CI typechecks ready PRs; it does not run tests or publish.

[Netcup API docs](https://www.netcup.com/en/helpcenter/documentation/servercontrolpanel/api)

MIT license. Not affiliated with Netcup.
