# Netcup terminal design

## Surface

A command-line tool, not an interactive dashboard. Commands work the same from a terminal and a script. No banner art, animation or color-only status.

## Output

Help starts with what the tool does, then shows commands and one useful example. Group help lists exact arguments and supported flags. JSON results go to stdout, indented by default; `--compact` removes indentation. Empty successes are `null`.

Progress and prompts go to stderr. Errors say what failed and name the command or setting that fixes it. An empty list is not an error and includes a useful next step on stderr.

## Actions

Show progress before waiting on the network. Use explicit confirmation text that names the target and effect for interrupting or destructive changes. Require `--yes` without a terminal. Never claim a server change finished just because Netcup accepted a task.

Device login prints the approval URL and user code, never access/refresh tokens or the internal device token. Ctrl-C stops local waiting and reports that an already-sent server request may still run.

## Implementation

`src/cli.ts` owns parsing, login and terminal output. `src/cli-commands.ts` binds validated arguments to the SDK. `src/credentials.ts` owns private atomic token storage. Keep the executables as forwarding files, not separate implementations.
