# MCP launch research

Research checked on 2026-10-14, when `netcup-sdk@0.3.0` and `@gusnips/netcup@1.2.0` were published without MCP. The same-binary design below is implemented in core `1.0.0` and alias `2.0.0`. See the [README](../README.md#use-with-an-ai-client) for setup and the current tool catalog. The sources and research limits below describe the original investigation, not completed release verification.

## One executable, local stdio

`netcup mcp` uses stdio: the AI app starts a local process and exchanges protocol messages through its input and output streams. The app owns that process. There is no web server to deploy or port to open.

Use the existing package over a separate MCP package because the executable, typed API clients and private credential files already exist. The scoped alias forwards the same command. One executable keeps the normal CLI as the main product and lets `npx netcup-sdk` choose it without a second binary name.

The versioned launch is:

```sh
npx --yes netcup-sdk@1.0.0 mcp
```

The Bun equivalent is `bunx netcup-sdk@1.0.0 mcp`. Both download published JavaScript; users do not clone the repository or compile it. The first launch needs registry access. Later launches may use the package manager's cache.

Pin the core package for a reviewed setup, not only the alias: the alias's dependency range allows newer core versions. A core version pin does not freeze every dependency.

A hosted HTTP MCP service is a different product. It would need hosting, user authentication and a policy for storing or forwarding Netcup credentials. It is not part of this release.

## Runtime and version boundary

The implementation uses the stable v2 TypeScript SDK, not the legacy v1 package. On the research date, `@modelcontextprotocol/server` and `@modelcontextprotocol/core` were `2.3.1` and required Node 20 or newer. Stdio uses `McpServer` and `serveStdio`, with built-in support for older clients. No HTTP framework or custom protocol compatibility layer is needed.

The Netcup release requires Node.js 22.0.0 or newer. This is a breaking change from the previous Node 18.3 minimum. Standard `bunx` respects the executable's Node shebang; it is not a Bun-only runtime setup.

Core `1.0.0` and alias `2.0.0` make that runtime change explicit. Publishing it as core `0.4.0` would put the higher Node minimum inside the old alias `1.2.0` range of `>=0.3.0 <1.0.0`. The new alias uses `>=1.0.0 <2.0.0` and declares Node `>=22.0.0`. Older aliases keep their prior range.

## Client setup

First run the login for the API family you need, outside the MCP process. For servers:

```sh
npx --yes netcup-sdk@1.0.0 login
```

For domains and DNS, use `npx --yes netcup-sdk@1.0.0 ccp login`. The public DNS record-type tool needs neither login.

For Claude Code:

```sh
claude mcp add --scope user --transport stdio netcup -- npx --yes netcup-sdk@1.0.0 mcp
```

User scope keeps the setup private and makes it available across projects. The command saves the setup; it does not prove the process can start or authenticate. Reconnect and check the connection and discovered tools afterward. Claude Code does not automatically reconnect a stopped stdio server.

Clients that accept `mcpServers` can use this command/arguments shape:

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

For Bun, use `"command": "bunx"` and `"args": ["netcup-sdk@1.0.0", "mcp"]`. Client configuration formats differ; not every app accepts this top-level object or expands shell variables. No credentials belong in this example.

Claude Desktop's [setup guide inspected during research](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) favors desktop extensions (`.mcpb` files) and says the app bundles Node. A desktop extension is a later packaging option for this same local integration. This release does not include one, and the JSON above is not an extension manifest or a claim about Desktop's manual configuration.

## Credentials and privacy

The MCP process reuses the matching saved credentials when it runs as the same OS user with the same config folder. These are the existing plaintext `credentials.json` and `ccp-credentials.json` files, not a new credential store. See [saved credentials](../README.md#saved-credentials) for paths and permissions.

`NETCUP_ACCESS_TOKEN` or `NETCUP_REFRESH_TOKEN` takes precedence over the saved SCP login. `NETCUP_CCP_API_KEY` takes precedence over the saved CCP key. SCP and CCP credentials, endpoints and recovery instructions remain separate. Public DNS record types use a keyless client without reading saved credentials.

Missing or unusable credentials return the matching versioned login instruction and a reminder to reconnect. MCP has no auth tools, hidden terminal prompts or browser approval flow. GUI apps may not inherit a shell's environment or `PATH`; check the executable path and matching config-folder environment if setup fails. Claude Code supports `${VAR}` references in its configuration; that is not a portable promise for other clients.

Do not put keys in command arguments, messages sent to the model or committed client settings. Selected server addresses, hostnames, domain names and DNS records can also be private. The AI client receives them, so its data policy still matters after credential fields have been excluded.

## Read-only scope

The first release has nine fixed tools for selected server details, task status, domains, DNS record types, exact DNS revisions and records. The [README catalog](../README.md#available-tools) names each tool. There are no writes, auth, shell, local file-read or arbitrary HTTP tools.

Approved operations and output fields define the boundary, not an HTTP-method filter. Rescue status can return a password, and snapshot/image/ISO reads can return signed download or upload access. Known-token redaction would not hide these other secrets. Those capabilities are excluded. Task output also excludes executing-user details, messages, results and error text.

SCP lists preserve `X-Total-Count` when present. CCP results keep selected envelope fields, pagination and provider notices. DNS record listing has no documented paging arguments. Explicitly incomplete metadata stays visible with a warning; absent metadata means completeness is unknown. The adapter does not invent paging controls or silently fetch every page.

Later write tools would need a person to enable them at setup and the client's approval flow. Tool annotations describe risk; they do not enforce permission or prove that a person approved a call. A model-supplied `confirm:true` is not human approval.

DNS writes in the CLI retain exact revision IDs, a complete review before commit when metadata permits that check, `autoCommit:false`, `strict:true` and no automatic retries. Review does not lock a revision, and a successful commit does not prove DNS propagation. MCP does not expose these writes.

## Adapter boundary

The adapter uses `NetcupClient` and `NetcupCcpClient`, not shell commands or parsed CLI output. Fixed typed `.api.GET` calls retain access to response headers and per-call cancellation signals. It reuses `CredentialStore` and the shared noninteractive credential selection and known-secret redaction helpers.

One lazily loaded SCP auth/client and one protected CCP client are shared per process. A failed initial credential load can be retried after the person fixes it. Public record types use a separate keyless client. Existing file locks protect credential updates; they do not serialize token refreshes across processes.

Canceling a tool stops its data read and its wait for authentication, not another tool's work or the underlying shared refresh. A received rotated refresh token is still saved. Cached access is published only after the save succeeds, so a failed save cannot be bypassed by a later cached read. This does not guarantee persistence if the operating system kills the process during a save.

Strict input objects reject unlisted arguments before I/O. Nested output schemas validate and select allowed fields, then known-secret values are redacted. Structured results have an object root and matching JSON text for older clients. Protocol keys and request IDs stay intact. Tool errors give a next step without forwarding raw response bodies, headers or unselected fields.

Netcup's existing `misc.openapiMcp()` endpoint only explores SCP documentation. The [provider specification](../openapi.json) says it does not execute API calls, so it does not replace this account integration.

MCP reserves stdout for protocol messages. Diagnostics belong on stderr. Normal CLI JSON printing stays separate and unchanged. API text is data, not instructions.

The official SDK's stdio runner handles protocol discovery and older clients. Its factory is synchronous and side-effect-free; session state lives outside it. Stdin EOF and process signals own shutdown. A discarded discovery candidate must not stop the process, and shutdown must observe outstanding refresh persistence rather than silently discard it.

## Research limits

The original research inspected documentation and package metadata. It did not install or run the reference MCP servers, register a client, log in to a real account or change DNS or servers. Release testing and registry verification are separate from this research note.

## Evidence

Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp#readme) uses `npx @playwright/mcp@latest`. Google's [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp#readme) uses `npx -y chrome-devtools-mcp@latest`. Both distribute a ready-to-run stdio process through npm. Their documentation and package metadata were inspected; neither server was installed or run.

- [Official stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html): process transport, output rules, lifecycle and older clients.
- [Server SDK metadata](https://registry.npmjs.org/@modelcontextprotocol/server/latest) and [core metadata](https://registry.npmjs.org/@modelcontextprotocol/core/latest): versions, dependencies and Node minimum. These links move as new versions ship; the versions above are the 2026-10-14 snapshot.
- [Claude Code MCP guide](https://code.claude.com/docs/en/mcp): command syntax, user scope, environment references and reconnection limits.
- [Tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): annotations are hints, not permission checks.
- [Credential store](../src/credentials.ts), [SCP auth](../src/auth.ts) and [CCP review/validation](../src/cli-ccp-commands.ts): existing code reused rather than replaced.
