# Netcup

## Who it is for

People managing Netcup servers and DNS from a terminal or a script. The CLI is the main product. The typed JavaScript SDK powers it and supports other integrations.

## What it does

Server commands use SCP device approval to inspect existing servers and request changes. Current commands cover power, basic settings, rescue mode, snapshots, disks and metrics. Tasks show whether accepted server work finished.

The separate `ccp` group uses an API key for the current domain/DNS API. List domains, inspect exact DNS revisions, prepare changes with automatic commit off, then review and publish explicitly. The CLI does not guess which revision is active.

The SDK covers more operations than the CLI, including ACME DNS challenges for certificate issuance. Neither surface orders servers, manages invoices or uses the legacy CCP JSON API.

`netcup mcp` lets an AI client read selected server, task, domain and DNS data. The client starts and owns a local stdio process, not a hosted service. It reuses a prior SCP login or CCP API key, with environment credentials taking precedence. It has nine fixed read-only tools, no login prompts and no write tools. Node.js 22.0.0 or newer is required.

## Rules

- Put a runnable terminal command before SDK setup in the docs.
- Reuse typed SDK methods. Keep imports free of CLI side effects.
- Keep SCP tokens and CCP keys separate, including their files, endpoints and recovery instructions.
- Keep JSON on stdout and instructions, previews and errors on stderr. Preserve CCP metadata and messages.
- Never print credentials. State that saved credentials are plaintext and keep them private.
- Confirm changes that can interrupt service or replace data. Scripts opt in with `--yes`.
- DNS commit must show the exact revision's records before approval. Stop if metadata reports missing records.
- Accepted work is not proof of completion or DNS propagation. Never retry changes automatically.
- MCP uses fixed read tools and selected output fields, not a generic CLI, HTTP or file interface. Keep passwords and signed capabilities out of results.
- MCP reserves stdout for protocol messages. Missing auth points to the matching CLI login and reconnection, never an interactive prompt.
- Keep MCP page metadata and provider warnings. Without DNS record metadata, completeness is unknown.
- A canceled tool must not cancel shared refresh work or discard a received rotated token. Do not claim refresh coordination across processes.
