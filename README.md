# netcup-sdk

Manage Netcup servers from your terminal.

```sh
npx netcup-sdk servers get 12345
```

This prints one server's details as JSON. Sign in first with `npx netcup-sdk login`.

Unofficial tool for Netcup's Server Control Panel API. Requires Node.js 18.3 or newer, or Bun. It manages existing servers, not server orders or customer/DNS settings.

## Start

```sh
npx netcup-sdk login
npx netcup-sdk servers list
```

Login shows a link and a code. Open the link in your browser, sign in to Netcup and approve access. The command waits for approval and saves a refresh token so you do not need to sign in for every call.

Bun works too:

```sh
bunx netcup-sdk login
bunx netcup-sdk servers list
```

The scoped package runs the same command:

```sh
npx @gusnips/netcup --help
bunx @gusnips/netcup servers list
```

To install the `netcup` command once:

```sh
npm install --global netcup-sdk
netcup --help
```

Or use `bun add --global netcup-sdk`. Choose either `netcup-sdk` or `@gusnips/netcup` for a global install, not both: they provide the same `netcup` command. Do not confuse them with the unrelated npm package named `netcup`.

## Commands

Run `netcup GROUP --help` for arguments and examples.

| Group       | Commands                                                             |
| ----------- | -------------------------------------------------------------------- |
| `login`     | Approve access in your browser and save it                           |
| `logout`    | Revoke the saved login and remove its file                           |
| `auth`      | `status`                                                             |
| `servers`   | `list`, `get`, `start`, `stop`, `reboot`, `update`, `logs`, `rescue` |
| `snapshots` | `list`, `get`, `create`, `delete`, `export`, `revert`, `dry-run`     |
| `tasks`     | `list`, `get`, `cancel`                                              |
| `disks`     | `list`, `get`, `supported-drivers`                                   |
| `metrics`   | `cpu`, `disk`, `network`, `network-packets`                          |

Examples after a global install:

```sh
netcup servers get 12345
netcup servers update 12345 --nickname web-1
netcup snapshots create 12345 before-upgrade
netcup tasks list
netcup metrics cpu 12345 --hours 24
```

Server updates accept one of `--nickname` or `--hostname` per call. Other settings, image uploads, firewall writes and advanced API operations are available through the [JavaScript SDK](https://github.com/gusnips/netcup/blob/main/docs/sdk.md). The CLI does not expose all SDK methods.

### Actions that can interrupt service

Stop, reboot, rescue-mode changes, task cancellation and snapshot deletion/restoration ask for confirmation. Scripts must pass `--yes`; otherwise the command exits without sending a request.

`reboot` is a hard reset, not a graceful operating-system reboot. Unsaved data may be lost. `snapshots revert` replaces disk data and discards changes made after the snapshot.

Only run this if you intend to reset that server:

```sh
netcup servers reboot 12345 --yes
```

A returned task means Netcup accepted the work, not that it finished. Check it with `netcup tasks get TASK_ID`. The CLI does not retry changes automatically. Ctrl-C stops local waiting; a request already accepted by Netcup may still run.

## JSON and scripts

Results go to stdout as JSON. Progress, approval instructions, prompts and errors go to stderr. `--compact` prints one-line JSON. An empty successful response prints `null`.

```sh
netcup servers list --limit 20 --offset 0 --compact
```

Lists return one page, not every page. Use `--limit` and `--offset` to request another page. Repeat `--sort` for multiple fields, for example `--sort=name --sort=-nickname`.

Exit codes: `0` for success or help, `1` for an API/login/storage failure, `2` for invalid arguments or a refused action, `130` for cancellation.

For scripts, set either `NETCUP_ACCESS_TOKEN` or `NETCUP_REFRESH_TOKEN`, not both. Environment credentials take precedence over the saved login and are not written to disk. Keep tokens out of command arguments and source control. Access tokens expire; refresh tokens let the SDK obtain new ones.

## Saved login

The CLI stores only the refresh token in a plaintext file:

- Linux/macOS: `$XDG_CONFIG_HOME/netcup-sdk/credentials.json`, or `~/.config/netcup-sdk/credentials.json`.
- Windows: `%APPDATA%/netcup-sdk/credentials.json`.

On Unix, the folder has mode `0700` and the file `0600`, so only its owner can read them. The CLI checks ownership and permissions, then updates the file atomically when tokens change. It refuses to overwrite a login another command has replaced.

A killed process can leave `.credentials.lock` behind. Retry first. Remove the named lock file only after checking that no Netcup command is running.

```sh
netcup auth status
netcup logout
```

Logout revokes access before removing the saved file. If Netcup cannot be reached, the file stays. `netcup logout --local` removes only the local file, without revoking access. Unset environment credentials before logging out of the saved account; the CLI cannot unset variables in your shell.

Netcup says offline refresh tokens must be used at least once every 30 days to stay valid. The CLI does not run a background keepalive.

Only if you use endpoints you trust, `NETCUP_BASE_URL` and `NETCUP_AUTH_URL` can override the API and authentication URLs. Credentials are sent to those endpoints.

## JavaScript and TypeScript

The same package also exports `NetcupClient`, `NetcupAuth`, error classes and generated types. Existing CommonJS and ESM imports still work. The SDK covers all 86 current API operations.

```ts
import { NetcupClient } from "netcup-sdk";
const netcup = new NetcupClient(process.env.NETCUP_ACCESS_TOKEN!);
const server = await netcup.servers.get(12345);
```

[Read the SDK guide](https://github.com/gusnips/netcup/blob/main/docs/sdk.md).

## Development

```sh
bun install
bun run lint
bun run typecheck
bun run build
bun test src/cli.test.ts
```

Tests use mocked requests and temporary login folders, not live servers. CI only typechecks ready PRs; it does not run tests or publish. `bun run generate` updates the types from the checked-in `openapi.json`.

[Netcup API docs](https://www.netcup.com/en/helpcenter/documentation/servercontrolpanel/api)

MIT license. Not affiliated with Netcup.
