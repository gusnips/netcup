# Netcup

## Who it is for

People managing their Netcup servers from a terminal or a script. The CLI is the main product, as the user confirmed. The JavaScript SDK supports it and remains available for integrations.

## What it does

Sign in through Netcup's device approval, inspect existing servers and request server changes. Read tasks to find out whether accepted work finished. Current commands cover power, basic settings, rescue mode, snapshots, disks and metrics.

The complete SDK supports more of the Server Control Panel API than the CLI. Neither surface orders servers or manages the separate Customer Control Panel/DNS API yet.

## Rules

- Put a runnable terminal command before SDK setup in the docs.
- Reuse the typed SDK for API calls and OAuth. Keep SDK imports free of CLI side effects.
- Keep JSON on stdout and instructions/errors on stderr.
- Never print tokens. Say that local login storage is plaintext and keep it private.
- Confirm actions that interrupt service or replace/delete data. Scripts must opt in with `--yes`.
- A task is accepted work, not proof that the work finished.
