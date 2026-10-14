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

## Implementation

`src/cli.ts` owns parsing, authentication and common output. `src/cli-commands.ts` binds SCP arguments; `src/cli-ccp-commands.ts` binds CCP arguments. Both use the typed SDK and common command descriptor. Its preview hook serves DNS commit without another dispatcher.

`src/credentials.ts` owns one private atomic secret store per API namespace. `src/cli-prompts.ts` owns native terminal input and cleanup. Executables stay forwarding files, not separate implementations.
