import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { version } from "../package.json";
import { NetcupAuth } from "./auth";
import type { NetcupFetch, NetcupTokens } from "./auth";
import { NetcupClient } from "./client";
import { CredentialStore } from "./credentials";
import { CliUsageError, commandHelp, resolveCommand } from "./cli-commands";
import { isRecord, NetcupAuthError, NetcupError } from "./errors";

export interface CliContext {
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: NetcupFetch;
  signal?: AbortSignal;
  confirm?: (question: string) => Promise<boolean>;
}

const help = `netcup ${version}
Manage existing Netcup servers.

Usage: netcup COMMAND [arguments] [options]

Commands:
  login         Approve access in your browser and save the login
  logout        Revoke the saved login and remove it from this machine
  auth status   Show which server account is signed in
  servers       Read servers, change settings and control power or rescue mode
  snapshots     Create, read, export, delete or restore snapshots
  tasks         Read work Netcup has accepted, or cancel a task
  disks         Read server disks and supported drivers
  metrics       Read CPU, disk and network measurements

Examples:
  netcup login
  netcup servers get 12345
  netcup servers list --limit 20
  netcup servers reboot 12345 --yes

Options:
  -h, --help     Show help without signing in
  -v, --version  Show the package version
  -y, --yes      Confirm an action without a prompt
  --compact      Print JSON without indentation

Use netcup GROUP --help for command arguments.
Results go to stdout as JSON. Progress and errors go to stderr.
`;

function authHelp(command: string): string {
  if (command === "login") {
    return "Usage: netcup login\nApprove the device code in your browser. The refresh token is saved in a private plaintext file.\n";
  }
  if (command === "logout") {
    return "Usage: netcup logout [--local]\nRevoke the saved login before removing its file. --local removes only the local file and does not revoke access.\n";
  }
  return "Usage: netcup auth status\nRead the signed-in server account. Environment credentials take precedence over the saved login.\n";
}

function onlyOptions(values: object, allowed: string[]): void {
  for (const key of Object.keys(values)) {
    if (!["help", "version", "compact", "yes", ...allowed].includes(key)) {
      throw new CliUsageError(
        `--${key} does not apply to this command. Run netcup --help for usage.`,
      );
    }
  }
}

class CliCanceledError extends Error {}

async function confirmAction(
  question: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliUsageError(
      `${question}\nNo request was sent. Add --yes if you intend to run this action from a script.`,
    );
  }
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  input.once("SIGINT", cancel);
  try {
    return (
      (
        await input.question(`${question} Type yes to continue: `, {
          signal: controller.signal,
        })
      )
        .trim()
        .toLowerCase() === "yes"
    );
  } catch (error) {
    if (controller.signal.aborted) throw new CliCanceledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    input.close();
  }
}

function taskId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.uuid === "string") return result.uuid;
  if (isRecord(result.taskInfo) && typeof result.taskInfo.uuid === "string")
    return result.taskInfo.uuid;
  return undefined;
}

export async function runCli(
  args: string[],
  context: CliContext = {},
): Promise<number> {
  const env = context.env ?? process.env;
  const out =
    context.stdout ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const err =
    context.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const secrets: string[] = [
    env.NETCUP_ACCESS_TOKEN,
    env.NETCUP_REFRESH_TOKEN,
  ].flatMap((value) =>
    value
      ? [value, value.trim(), JSON.stringify(value.trim()).slice(1, -1)]
      : [],
  );
  const rememberSecrets = (tokens: NetcupTokens): void => {
    secrets.push(tokens.access_token, tokens.refresh_token);
  };
  const json = (value: unknown, compact?: boolean): void => {
    out(`${JSON.stringify(value ?? null, null, compact ? undefined : 2)}\n`);
  };
  try {
    context.signal?.throwIfAborted();
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        yes: { type: "boolean", short: "y" },
        compact: { type: "boolean" },
        local: { type: "boolean" },
        limit: { type: "string" },
        offset: { type: "string" },
        search: { type: "string" },
        sort: { type: "string", multiple: true },
        nickname: { type: "string" },
        hostname: { type: "string" },
        disk: { type: "string" },
        description: { type: "string" },
        online: { type: "boolean" },
        offline: { type: "boolean" },
        hours: { type: "string" },
      },
    });
    if (values.version) {
      out(`${version}\n`);
      return 0;
    }
    const group = positionals[0];
    if (values.help || positionals.length === 0) {
      if (!group) {
        onlyOptions(values, []);
        out(help);
      } else if (["login", "logout", "auth"].includes(group))
        out(authHelp(group));
      else {
        const text = commandHelp(group);
        if (!text)
          throw new CliUsageError(
            `Unknown command ${JSON.stringify(group)}. Run netcup --help for commands.`,
          );
        out(text);
      }
      return 0;
    }

    const login = group === "login";
    const logout = group === "logout";
    const status = group === "auth" && positionals[1] === "status";
    if (group === "auth" && !status)
      throw new CliUsageError(
        "Use netcup auth status to read the signed-in account.",
      );
    if (login || logout || status) {
      const expected = status ? 2 : 1;
      if (positionals.length !== expected)
        throw new CliUsageError(authHelp(group));
      onlyOptions(values, logout ? ["local"] : []);
    }
    const command =
      login || logout || status
        ? undefined
        : resolveCommand(positionals, values);
    if (command?.confirmation && !values.yes) {
      const accepted = await (context.confirm
        ? context.confirm(command.confirmation)
        : confirmAction(command.confirmation, context.signal));
      if (!accepted) throw new CliUsageError("Canceled. No request was sent.");
    }

    const store = new CredentialStore(env);
    const transport = context.fetch ?? globalThis.fetch;
    const fetch: NetcupFetch = (request) =>
      transport(
        context.signal
          ? new Request(request, { signal: context.signal })
          : request,
      );
    const common = {
      fetch,
      authUrl: env.NETCUP_AUTH_URL,
      baseUrl: env.NETCUP_BASE_URL,
    };
    if (login) {
      let previous = (await store.read())?.refreshToken ?? null;
      const auth = new NetcupAuth({
        ...common,
        onTokens: async (tokens) => {
          rememberSecrets(tokens);
          await store.save(tokens.refresh_token, previous);
          previous = tokens.refresh_token;
        },
      });
      err("Requesting a login code...\n");
      const device = await auth.startDeviceAuthorization(context.signal);
      err(
        `Open ${device.verification_uri_complete ?? device.verification_uri}\nEnter code: ${device.user_code}\nWaiting for browser approval. Press Ctrl-C to cancel.\n`,
      );
      await auth.waitForDeviceAuthorization(device, context.signal);
      err(
        `Login saved in ${JSON.stringify(store.path)}. This file contains a plaintext refresh token.\n`,
      );
      if (env.NETCUP_ACCESS_TOKEN || env.NETCUP_REFRESH_TOKEN)
        err(
          "Environment credentials are still set and take precedence. Unset them to use the saved login.\n",
        );
      json({ authenticated: true }, values.compact);
      return 0;
    }

    const accessToken = env.NETCUP_ACCESS_TOKEN?.trim();
    const refreshToken = env.NETCUP_REFRESH_TOKEN?.trim();
    for (const [name, token] of [
      ["NETCUP_ACCESS_TOKEN", accessToken],
      ["NETCUP_REFRESH_TOKEN", refreshToken],
    ]) {
      if (token && !/^[!-~]+$/.test(token)) {
        throw new CliUsageError(
          `${name} contains spaces, line breaks or unsupported characters. Copy it again, or unset it and run netcup login.`,
        );
      }
    }
    if (accessToken && refreshToken)
      throw new CliUsageError(
        "Both NETCUP_ACCESS_TOKEN and NETCUP_REFRESH_TOKEN are set. Unset one before running this command.",
      );
    if (logout) {
      if (accessToken || refreshToken)
        throw new CliUsageError(
          "Environment credentials are active. Unset NETCUP_ACCESS_TOKEN and NETCUP_REFRESH_TOKEN before logging out of the saved account.",
        );
      const saved = await store.read();
      if (!saved) {
        err("No saved login was found. Use netcup login to sign in.\n");
        json({ authenticated: false, revoked: false }, values.compact);
        return 0;
      }
      secrets.push(saved.refreshToken);
      if (!values.local) {
        err("Revoking the saved login...\n");
        try {
          await new NetcupAuth({
            ...common,
            refreshToken: saved.refreshToken,
          }).revoke(undefined, context.signal);
        } catch {
          throw new Error(
            "Could not revoke the saved login. Its file was kept. Try again, or use netcup logout --local to remove only the local file without revoking access.",
          );
        }
      }
      await store.remove(saved.refreshToken);
      err(
        values.local
          ? "Removed the local login file. Netcup access was not revoked.\n"
          : "Revoked the saved login and removed its file.\n",
      );
      json({ authenticated: false, revoked: !values.local }, values.compact);
      return 0;
    }

    let client: NetcupClient;
    if (accessToken) client = new NetcupClient({ ...common, accessToken });
    else if (refreshToken)
      client = new NetcupClient({
        ...common,
        refreshToken,
        onTokens: rememberSecrets,
      });
    else {
      const saved = await store.read();
      if (!saved)
        throw new Error(
          "No login was found. Run netcup login, or set NETCUP_ACCESS_TOKEN or NETCUP_REFRESH_TOKEN for a script.",
        );
      secrets.push(saved.refreshToken);
      let previous = saved.refreshToken;
      client = new NetcupClient({
        ...common,
        refreshToken: previous,
        onTokens: async (tokens) => {
          rememberSecrets(tokens);
          await store.save(tokens.refresh_token, previous);
          previous = tokens.refresh_token;
        },
      });
    }
    if (status) {
      err("Checking the signed-in account...\n");
      json(
        {
          authenticated: true,
          user: await client.auth.userInfo(context.signal),
        },
        values.compact,
      );
      return 0;
    }
    if (!command)
      throw new CliUsageError("Choose a command. Run netcup --help for usage.");
    err(`${command.label}\n`);
    const result = await command.execute(client);
    json(result, values.compact);
    if (Array.isArray(result) && result.length === 0 && command.emptyMessage)
      err(`${command.emptyMessage}\n`);
    const task = taskId(result);
    if (task && command.mutation)
      err(
        `Netcup accepted the request. Check its progress with netcup tasks get ${JSON.stringify(task)}.\n`,
      );
    else if (result === undefined)
      err(
        command.mutation
          ? "Netcup accepted the request. An empty response does not confirm that server work has finished.\n"
          : "Netcup returned no data. Check the ID and your account permissions, then try again.\n",
      );
    return 0;
  } catch (error) {
    if (context.signal?.aborted || error instanceof CliCanceledError) {
      err(
        error instanceof CliCanceledError
          ? "Canceled. No request was sent.\n"
          : "Canceled. A request already sent to Netcup may still run.\n",
      );
      return 130;
    }
    let message =
      error instanceof Error
        ? error.message
        : "The command failed. Try again or run netcup --help.";
    if (error instanceof NetcupAuthError) {
      message =
        error.code === "token_storage_failed"
          ? "Could not save the refreshed login. Check the login folder's permissions, then run netcup login again."
          : `${message} Use netcup login to approve access again if needed.`;
    } else if (error instanceof NetcupError) {
      if (error.status === 401)
        message =
          "Netcup rejected the access token. Run netcup login again, or replace the token provided by your environment.";
      else if (error.status === 403)
        message =
          "Netcup denied this request. Check the account permissions and the API IP allowlist in the Server Control Panel.";
    }
    for (const secret of secrets)
      if (secret) message = message.split(secret).join("[redacted]");
    err(`${message}\n`);
    if (
      error instanceof CliUsageError ||
      (isRecord(error) &&
        typeof error.code === "string" &&
        error.code.startsWith("ERR_PARSE_ARGS"))
    ) {
      if (!(error instanceof CliUsageError))
        err("Run netcup --help to see the supported flags.\n");
      return 2;
    }
    return 1;
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}
