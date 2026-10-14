# netcup-sdk

Manage Netcup servers and DNS from your terminal.

```sh
npx netcup-sdk --help
```

Unofficial CLI and JavaScript client. Requires Node.js 22.0.0 or newer. Server commands use the Server Control Panel (SCP). Domain and DNS commands use the current Customer Control Panel (CCP) API for CloudDNS. They do not use Netcup's legacy DNS API.

Version `1.0.0` raises the Node minimum from 18.3 to 22.0.0 and adds read-only access for AI clients through MCP. The scoped alias `@gusnips/netcup@2.0.0` uses the same core release line. Alias `1.2.0` keeps its `<1.0.0` core range, so it does not pick up this runtime change.

## Start

For servers:

```sh
npx netcup-sdk login
npx netcup-sdk servers list
```

Open the login link in your browser, sign in to Netcup and approve the code. The command saves a refresh token so you do not need to approve every call.

For domains and DNS:

```sh
npx netcup-sdk ccp login
npx netcup-sdk ccp domains list
```

Create an API key in **CCP > Master Data > API**, then paste it at the hidden prompt. The command checks the key before saving it. This key is separate from your SCP server login.

Bun and the scoped package work too:

```sh
bunx netcup-sdk ccp domains list
npx @gusnips/netcup --help
bunx @gusnips/netcup servers list
```

To install the `netcup` command once:

```sh
npm install --global netcup-sdk
netcup --help
```

Or use `bun add --global netcup-sdk`. Choose `netcup-sdk` or `@gusnips/netcup` for a global install, not both: they provide the same command. The unrelated npm package named `netcup` is not this tool.

## Server commands

Run `netcup GROUP --help` for arguments and examples.

| Group       | Commands                                                             |
| ----------- | -------------------------------------------------------------------- |
| `login`     | Approve server access in your browser and save it                    |
| `logout`    | Revoke the saved server login and remove its file                    |
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

Server updates accept one of `--nickname` or `--hostname` per call. Firewall writes, image uploads and other advanced calls are available through the [SDK](https://github.com/gusnips/netcup/blob/main/docs/sdk.md).

Stop, reboot, rescue-mode changes, task cancellation and snapshot deletion/restoration ask for confirmation. Scripts must pass `--yes`. `reboot` is a hard reset, not a graceful operating-system reboot. Unsaved data may be lost. `snapshots revert` replaces disk data.

A returned task means Netcup accepted work, not that it finished. Check it with `netcup tasks get TASK_ID`.

## Domains and DNS

Run `netcup ccp --help` for the full syntax.

| Command                                         | What it does                                             |
| ----------------------------------------------- | -------------------------------------------------------- |
| `ccp login`                                     | Check and save an API key using hidden input             |
| `ccp logout`                                    | Remove only the local key, without revoking it at Netcup |
| `ccp auth status`                               | Check the configured key with a read-only request        |
| `ccp domains list`                              | List domains, with name/ID filters and page/sort options |
| `ccp dns types`                                 | Read supported record types without a key                |
| `ccp dns revisions DOMAIN_ID`                   | List a domain's DNS revisions                            |
| `ccp dns records DOMAIN_ID REVISION_UUID`       | Read records in an exact revision                        |
| `ccp dns prepare DOMAIN_ID --file CHANGES.json` | Submit changes with automatic commit disabled            |
| `ccp dns review DOMAIN_ID REVISION_UUID`        | Read that revision and its records                       |
| `ccp dns commit DOMAIN_ID REVISION_UUID`        | Show the revision again, then ask before publishing it   |

Find a domain by name:

```sh
netcup ccp domains list --fqdn example.com
```

Domain and revision lists use `--page` and `--per-page`, starting at 1. Domain filters are `--fqdn` and `--domain-id`. Use `--field fqdn --direction asc` to sort domains. Domain IDs are not SCP server IDs.

### Prepare, review and publish

These steps send DNS changes to Netcup. Use the domain ID from `ccp domains list`, not a server ID. Back up the records you need before publishing a change.

Save this example as `changes.json`. Replace `192.0.2.10` with the intended IP; it is an example address, not a working server.

```json
{
  "create": [{ "name": "www", "type": "A", "rdata": "192.0.2.10", "ttl": 300 }]
}
```

`name` is relative to the domain; use `@` for the domain itself. `rdata` is the record's value. `ttl` is how many seconds a DNS resolver may cache it. MX and SRV priority belongs inside `rdata`, not in another field.

```sh
netcup ccp dns prepare DOMAIN_ID --file changes.json
netcup ccp dns review DOMAIN_ID REVISION_UUID
netcup ccp dns commit DOMAIN_ID REVISION_UUID
```

Replace `REVISION_UUID` with the identifier returned by prepare. There is no `latest` or `current` shortcut. To remove a record, put its full `name`, `type`, `rdata` and `ttl` in a `delete` array. A record ID alone is not valid change-set input.

Prepare sends `autoCommit: false` and `strict: true`; the file cannot override them. It is a remote write, not a dry run, and requires confirmation or `--yes`. It does not call the commit endpoint.

Commit reads the exact revision and its records again and prints the preview on stderr before asking for approval. `--yes` skips the prompt, not the preview. Review shows Netcup's responses, not a local before/after diff. If metadata says records are missing from the response, review and commit stop; Netcup documents no paging controls for that record-list endpoint.

Netcup does not document an atomic check for edits made after review. Avoid changing the same revision in another client while publishing. A successful response does not confirm that every DNS resolver is serving the new records.

Neither the CLI nor SDK retries changes automatically. If a change request fails or you cancel after sending it, check the control panel before trying it again.

## JSON and scripts

Results go to stdout as JSON. Progress, previews, prompts and errors go to stderr. `--compact` prints one-line JSON. An empty successful response prints `null`. Known credentials are hidden from output.

SCP lists use `--limit` and `--offset`, not CCP's page numbers. Repeat `--sort` for multiple SCP fields, for example `--sort=name --sort=-nickname`. Lists return one page. CCP output keeps its `result`, `meta`, `messages` and `errors` fields so page information and warnings are not lost.

Exit codes: `0` for success or help, `1` for an API/login/storage failure, `2` for invalid arguments or a refused action, `130` for cancellation. Ctrl-C stops local waiting; a request already sent may still run.

For scripts:

- Servers: set either `NETCUP_ACCESS_TOKEN` or `NETCUP_REFRESH_TOKEN`, not both.
- Domains/DNS: set `NETCUP_CCP_API_KEY`. SCP tokens do not work here.

Environment credentials take precedence over the matching saved login and are not written to disk. Keep them out of command arguments and source control. A CCP command does not refresh or use your SCP login.

## Saved credentials

Files are plaintext in the `netcup-sdk` config folder:

- Linux/macOS: `$XDG_CONFIG_HOME/netcup-sdk`, or `~/.config/netcup-sdk`.
- Windows: `%APPDATA%/netcup-sdk`.

`credentials.json` contains the SCP refresh token. `ccp-credentials.json` contains the separate CCP API key. On Unix, the folder has mode `0700` and files `0600`. The CLI checks ownership and permissions, writes atomically and refuses to overwrite credentials another command has replaced.

A killed process can leave `.credentials.lock` or `.ccp-credentials.lock` behind. Retry first. Remove the named lock only after checking that no Netcup command is updating that file.

`netcup logout` revokes the saved SCP login before removing it. If revocation fails, the file stays. `netcup logout --local` removes only that file, without revoking access.

`netcup ccp logout` removes only the saved CCP key. To revoke the key, delete it in **CCP > Master Data > API**. Unset the matching environment variables before local logout; the CLI cannot unset variables in your shell.

Netcup says offline SCP refresh tokens must be used at least once every 30 days to stay valid. The CLI does not run a background keepalive.

Only override endpoints you trust: `NETCUP_BASE_URL` and `NETCUP_AUTH_URL` control SCP endpoints; `NETCUP_CCP_BASE_URL` controls the current CCP API. Your credentials are sent to those endpoints.

## Use with an AI client

MCP (Model Context Protocol) lets an AI client read selected Netcup data. It cannot change servers or DNS.

First, run the matching login outside the AI client. For servers:

```sh
npx --yes netcup-sdk@1.0.0 login
```

For domains and DNS, run `npx --yes netcup-sdk@1.0.0 ccp login`. You need only the login for the tools you use. Skip login if you already supply matching environment credentials. Reading supported DNS record types needs no key.

Use a local stdio connection, which sends messages through the process's input and output streams. Set your client's launch command to:

```sh
npx --yes netcup-sdk@1.0.0 mcp
```

Or use `bunx netcup-sdk@1.0.0 mcp`. Standard `bunx` uses Node for this executable, so Node.js 22.0.0 or newer is still required. There is no repository to clone, build step or server port. The client starts and owns a local process. If you run the command in a terminal by itself, it waits for MCP messages, not typed commands.

For Claude Code:

```sh
claude mcp add --scope user --transport stdio netcup -- npx --yes netcup-sdk@1.0.0 mcp
```

Clients that accept a `mcpServers` configuration can use this command and arguments:

```json
{
  "mcpServers": {
    "netcup": {
      "command": "npx",
      "args": ["--yes", "netcup-sdk@1.0.0", "mcp"]
    }
  }
}
```

For Bun, use `"command": "bunx"` and `"args": ["netcup-sdk@1.0.0", "mcp"]`. Client formats differ; use your client's local stdio instructions. This release does not include a Claude Desktop extension (`.mcpb`) or a hosted MCP service.

Reconnect the client after saving its setup, then ask it to list your Netcup servers or domains. Check that it finds the tools below. Saving a setup does not prove the process can start or log in.

### Login and privacy

MCP uses the same plaintext files and environment precedence described above. Run it as the same OS user with the same config folder as your prior CLI login. `NETCUP_ACCESS_TOKEN` or `NETCUP_REFRESH_TOKEN` overrides the saved SCP login; `NETCUP_CCP_API_KEY` overrides the saved CCP key. The two API families stay separate.

MCP never opens a login prompt or browser flow and has no auth tools. If credentials are missing or unusable, run the matching versioned login command above, then reconnect your AI client. If a desktop app cannot find `npx` or the saved login, check its executable path, `PATH` and config-folder environment. Apps may not inherit your terminal's environment.

Do not put credentials in command arguments, messages to the model or committed client settings. Server IPs, hostnames, domain names and DNS values can also be private. Your AI client receives the selected results; check its data policy before connecting.

### Available tools

| Tool                        | What it reads                             |
| --------------------------- | ----------------------------------------- |
| `scp_servers_list`          | One page of servers                       |
| `scp_servers_get`           | Selected details for one server           |
| `scp_tasks_list`            | One page of server tasks                  |
| `scp_tasks_get`             | Status of one task                        |
| `ccp_domains_list`          | One page of domains                       |
| `ccp_dns_record_types_list` | Supported DNS record types, without a key |
| `ccp_dns_revisions_list`    | One page of a domain's DNS revisions      |
| `ccp_dns_revisions_get`     | One exact DNS revision                    |
| `ccp_dns_records_list`      | Records in one exact DNS revision         |

The tools return only selected fields, not raw API responses. There are no write, shell, file-read or arbitrary HTTP tools. Passwords and signed download/upload access are excluded. Use exact DNS revision UUIDs; there is no `latest` or `current` shortcut.

SCP lists keep the total from `X-Total-Count` when Netcup returns it. CCP results keep selected response fields, page metadata and provider notices. Lists do not fetch every page for you. DNS record listing has no documented paging arguments. Metadata can report missing records; without metadata, completeness is unknown. Do not treat such a result as a full DNS backup.

Canceling a tool stops its read, not another tool or a shared SCP token refresh. A refresh already in progress can still finish and save a rotated token. Separate Netcup processes do not share refresh requests. MCP keeps stdout for protocol messages; normal CLI commands still print JSON.

## JavaScript and TypeScript

The package also exports typed clients. CommonJS and ESM imports work under either package name.

```ts
import { NetcupClient } from "netcup-sdk";
const netcup = new NetcupClient("your-scp-access-token");
const server = await netcup.servers.get(12345);
```

The SDK covers 86 current SCP operations and all 17 operations in the checked-in CCP specification, including DNS revision/record methods and ACME certificate challenges. The CLI exposes the commands listed above, not every SDK method.

[Read the SDK guide](https://github.com/gusnips/netcup/blob/main/docs/sdk.md).

Server ordering, invoices and the legacy CCP JSON API are not included. MCP is limited to the selected read tools above; the SDK and normal CLI support more operations.

## Development

```sh
bun install
bun run lint
bun run typecheck
bun run build
bun test src/mcp.test.ts
```

Run only the test file you change. Tests use mocked requests and temporary config folders, not live accounts. CI only typechecks ready PRs; it does not run tests or publish. `bun run generate` reads `openapi.json` for SCP and `openapi-ccp.json` for CCP.

[Server API docs](https://www.netcup.com/en/helpcenter/documentation/server/rest-api) · [Current CCP API docs](https://www.netcup.com/en/helpcenter/documentation/netcup-api)

MIT license. Not affiliated with Netcup.
