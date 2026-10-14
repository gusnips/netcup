# Netcup terminal design

## Surface

A command-line tool, not an interactive dashboard. Commands work the same from a terminal and a script. No banner art, animation or color-only status.

## Output

Help starts with what the tool does, then shows commands and one useful example. Group help lists exact arguments and supported flags. JSON results go to stdout, indented by default; `--compact` removes indentation. Empty successes are `null`.

Progress, previews and prompts go to stderr. Errors say what failed and how to fix it. An empty list names what was not found and gives a next step. CCP results keep the provider's full envelope, including pagination and messages.

Hide known credentials in both streams without breaking JSON. Escape terminal control characters from API content. Never turn a load failure into an empty state.

## Actions

Show progress before waiting on the network. Use confirmation text that names the exact target and effect. Require `--yes` without a terminal. A DNS commit preview happens before confirmation; `--yes` skips the prompt, not the preview. Incomplete record metadata blocks review and commit.

Prepare sends a remote change set with automatic commit off. Do not call it a dry run or claim undocumented state/propagation guarantees. Use exact revision UUIDs, not latest/current guesses. Avoid automatic write retries.

Device login shows the approval URL and user code, never tokens. CCP key input is hidden. Login, status and logout explain which API family they affect. Local CCP logout must not claim remote key revocation.

Ctrl-C stops local waiting. Say whether no request, only reads or a possible change request was sent. Do not claim server work finished because Netcup accepted a task.

## MCP

`netcup mcp` is a separate stdio mode of the same executable. The AI client starts and owns the local process. There is no port, hosted service or interactive login. Setup uses a published, exact core version; it does not require a clone or build. Login happens through the normal CLI before connecting.

Stdout contains protocol messages only. Diagnostics go to stderr. Normal CLI JSON output stays unchanged. Missing credentials name the matching login command and tell the person to reconnect; MCP never opens a prompt or exposes auth tools.

Expose only the nine approved read tools and their selected nested fields. Do not expose raw responses, passwords, signed download or upload access, arbitrary HTTP requests, shell commands or local files. Results keep page information and provider warnings. Missing DNS record metadata means completeness is unknown, not that every record was returned.

Use object-root structured results and matching JSON text for older clients. The official v2 SDK handles client compatibility and stdio. A canceled tool stops its own read, not another tool or a shared token refresh. Save received rotated tokens before making cached access available. Refresh sharing is per process, not a cross-process lock.

## Implementation

`src/cli.ts` owns CLI parsing and interactive authentication. `src/cli-commands.ts` binds SCP arguments; `src/cli-ccp-commands.ts` binds CCP arguments. Both use the typed SDK and common command descriptor. Its preview hook serves DNS commit without another dispatcher.

`src/cli-credentials.ts` shares noninteractive credential selection between the CLI and MCP. `src/cli-output.ts` shares known-secret registration and redaction without changing protocol keys or request IDs. `src/credentials.ts` owns one private atomic secret store per API namespace. `src/cli-prompts.ts` owns native terminal input and cleanup. Executables stay forwarding files, not separate implementations.
