# MCP launch research

Checked on 2026-10-14. `netcup-sdk@0.3.0` and `@gusnips/netcup@1.2.0` are published. Neither includes MCP. This document proposes a later MCP release, not commands you can use today.

## Recommendation

Add `netcup mcp` to the existing binary. Use stdio: the AI app starts a local process and exchanges protocol messages through its input and output streams. The app manages that process. There is no web server to deploy or port to open.

Use the existing package over a separate MCP package because the executable, typed API clients and private credential files already exist. The scoped alias can forward the same command. Keep one executable so `npx netcup-sdk` can still choose it.

After MCP is published, the proposed launch is:

```sh
npx --yes netcup-sdk@latest mcp
```

The Bun equivalent is `bunx netcup-sdk@latest mcp`. Both download published JavaScript; users would not clone the repository or compile it. The first launch needs registry access. Later launches may use the package manager's cache.

For a reviewed setup, replace `latest` with the exact core version that includes MCP. Pin the core package, not only the alias: the alias's current dependency range allows newer core versions. A core version pin does not freeze every dependency.

A hosted HTTP MCP service is a different product. It would need hosting, user authentication and a policy for storing or forwarding Netcup credentials. Do not add it just to avoid saying "local process".

## Runtime

Use the stable v2 TypeScript SDK, not the legacy v1 package. On the check date, `@modelcontextprotocol/server` and `@modelcontextprotocol/core` are `2.3.1` and require Node 20 or newer. Stdio uses `McpServer` and `serveStdio`; it does not need an HTTP framework. Keep the SDK's built-in support for older clients rather than writing a compatibility layer.

Target Node 22 or newer for the MCP release. This needs an explicit change from Netcup's current Node 18.3 minimum. Today's releases and this documentation change keep that minimum unchanged. Standard `bunx` respects the executable's Node shebang; do not promise a Bun-only MCP setup without testing it.

## Client setup

These examples are proposed only. They will not work until an MCP release is published. Use an exact core version instead of `latest` when reviewing a deployment.

For Claude Code:

```sh
claude mcp add --scope user --transport stdio netcup -- npx --yes netcup-sdk@latest mcp
```

User scope keeps the setup private and makes it available across projects. The command saves the setup; it does not prove the process can start or authenticate. Check the connection and discovered tools afterward. Claude Code does not automatically reconnect a stopped stdio server.

The equivalent command/arguments shape is:

```json
{
  "mcpServers": {
    "netcup": {
      "command": "npx",
      "args": ["--yes", "netcup-sdk@latest", "mcp"]
    }
  }
}
```

For Bun, use `"command": "bunx"` and `"args": ["netcup-sdk@latest", "mcp"]`. Client configuration formats differ; do not assume every app accepts this top-level object or expands shell variables.

Claude Desktop's [current setup guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) favors desktop extensions (`.mcpb` files) and says the app bundles Node. That is a later packaging option for installing this same local integration through the app, not a reason to add a hosted service. Do not present the JSON above as a desktop-extension manifest.

## Credentials

Keep interactive login outside the MCP process. Users would first run the existing login for the API they need:

```sh
npx --yes netcup-sdk@latest login
```

For domains and DNS, use `npx --yes netcup-sdk@latest ccp login` instead. The future MCP process should reuse the matching saved credentials when it runs as the same OS user with the same config folder.

Scripts can already use `NETCUP_ACCESS_TOKEN` or `NETCUP_REFRESH_TOKEN` for SCP, and `NETCUP_CCP_API_KEY` for CCP. A future MCP adapter should preserve those separate credentials and environment precedence. Do not put keys in command arguments, prompts sent to the model or committed client settings.

Missing or unusable credentials must return a clear login instruction, not open a hidden terminal prompt or browser approval flow. GUI apps may not inherit a shell's environment or PATH. A setup error should tell the user to configure the executable path or matching config-folder environment. Claude Code supports `${VAR}` references in its configuration; that is not a portable promise for other clients.

## First scope

Start with explicit read-only tools for server details, task status, domains, DNS revisions and records. Do not turn every SDK method into a tool. Use approved operations and output fields, not an HTTP-method filter: rescue status can return a password, and snapshot/image/ISO reads can return signed download or upload access. Known-token redaction will not hide these other secrets.

Keep writes out of the first MCP release. Later write tools need a person to enable them at setup and the client's approval flow. Tool annotations describe risk; they do not enforce permission or prove that a person approved a call. A model-supplied `confirm:true` is not human approval.

DNS writes must retain exact revision IDs, a complete review before commit, `autoCommit:false`, `strict:true` and no automatic retries. Review does not lock a revision, and a successful commit does not prove DNS propagation. Cancellation after a request is sent does not undo it.

## Adapter boundary

Call `NetcupClient` and `NetcupCcpClient` directly. Do not shell out to the CLI and parse its output. Reuse `CredentialStore` and extract only the noninteractive credential selection both entrypoints need. Keep one shared SCP auth/client per process so its existing refresh coordination and awaited token persistence still apply. File locks do not serialize token refreshes across processes.

The SDK's named methods generally lack per-call cancellation signals. Settle that boundary before implementation: canceling one tool must not abort another tool or lose a rotated refresh token. Reuse pure DNS input checks and the revision review helper, not arbitrary file reads or CLI prompts.

Netcup's existing `misc.openapiMcp()` endpoint only explores SCP documentation. The [provider specification](../openapi.json) says it does not execute API calls, so it does not replace this account integration.

The MCP process must reserve stdout for protocol messages. Diagnostics belong on stderr. CLI JSON printing and terminal confirmations are not an MCP transport. Preserve pagination and provider warnings. Return useful tool errors without exposing credentials, and treat API text as data, not instructions.

Shut down cleanly when the client closes the connection. Before release, test a real subprocess for startup, tool discovery, one mocked read, safe authentication failure, cancellation and shutdown. Then check each supported client's setup. No MCP server or client registration was run for this research, and no real DNS or server mutation belongs in its smoke tests.

## Evidence

Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp#readme) uses `npx @playwright/mcp@latest`. Google's [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp#readme) uses `npx -y chrome-devtools-mcp@latest`. Both distribute a ready-to-run stdio process through npm. Their documentation and package metadata were inspected; neither server was installed or run.

- [Official stdio guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html): process transport, output rules, lifecycle and older clients.
- [Current server SDK metadata](https://registry.npmjs.org/@modelcontextprotocol/server/latest) and [core metadata](https://registry.npmjs.org/@modelcontextprotocol/core/latest): versions, dependencies and Node minimum. These links move as new versions ship.
- [Claude Code MCP guide](https://code.claude.com/docs/en/mcp): command syntax, user scope, environment references and reconnection limits.
- [Tool specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): annotations are hints, not permission checks.
- [Existing credential store](../src/credentials.ts), [SCP auth](../src/auth.ts) and [CCP review/validation](../src/cli-ccp-commands.ts): code to reuse, not duplicate.
