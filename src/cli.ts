import { parseArgs } from "node:util";
import { version } from "../package.json";
import { NetcupAuth } from "./auth";
import type { NetcupFetch } from "./auth";
import { NetcupClient } from "./client";
import { CredentialStore } from "./credentials";
import { CliUsageError, commandHelp, resolveCommand } from "./cli-commands";
import type { CliCommand } from "./cli-commands";
import { ccpCommandHelp, resolveCcpCommand } from "./cli-ccp-commands";
import { CliCanceledError, confirmAction, promptSecret } from "./cli-prompts";
import {
  apiKey,
  loadCcpKey,
  loadScpAuth,
  scpEnvironment,
} from "./cli-credentials";
import { createRedactor, terminalSafe } from "./cli-output";
import { isRecord, NetcupAuthError, NetcupError } from "./errors";

export interface CliContext {
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: NetcupFetch;
  signal?: AbortSignal;
  confirm?: (question: string) => Promise<boolean>;
  promptSecret?: (question: string) => Promise<string>;
}

const help = `netcup ${version}
Manage Netcup servers and DNS.

Usage: netcup COMMAND [arguments] [options]

Commands:
  login         Approve server access in your browser and save the login
  logout        Revoke the saved server login and remove it from this machine
  auth status   Show which server account is signed in
  servers       Read servers, change settings and control power or rescue mode
  snapshots     Create, read, export, delete or restore snapshots
  tasks         Read work Netcup has accepted, or cancel a task
  disks         Read server disks and supported drivers
  metrics       Read CPU, disk and network measurements
  ccp           Read domains and prepare, review or publish DNS changes

Examples:
  netcup login
  netcup servers get 12345
  netcup ccp login
  netcup ccp domains list

Options:
  -h, --help     Show help without signing in
  -v, --version  Show the package version
  -y, --yes      Confirm an action without a prompt
  --compact      Print JSON without indentation

Use netcup GROUP --help for command arguments.
Results go to stdout as JSON. Progress and errors go to stderr.
`;

function authHelp(command: string, ccp = false): string {
  if (ccp) {
    if (command === "login")
      return "Usage: netcup ccp login\nPaste an API key from CCP > Master Data > API. Input is hidden. The key is checked and saved in a private plaintext file.\n";
    if (command === "logout")
      return "Usage: netcup ccp logout\nRemove the local saved key. To revoke it at Netcup, delete the key in CCP > Master Data > API.\n";
    return "Usage: netcup ccp auth status\nCheck the configured key with a read-only domain request. NETCUP_CCP_API_KEY takes precedence over the saved key.\n";
  }
  if (command === "login")
    return "Usage: netcup login\nApprove the device code in your browser. The refresh token is saved in a private plaintext file.\n";
  if (command === "logout")
    return "Usage: netcup logout [--local]\nRevoke the saved login before removing its file. --local removes only the local file and does not revoke access.\n";
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

function taskId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.uuid === "string") return result.uuid;
  if (isRecord(result.taskInfo) && typeof result.taskInfo.uuid === "string")
    return result.taskInfo.uuid;
  return undefined;
}

function ccpAuthenticationError(error: NetcupError): boolean {
  return (
    isRecord(error.body) &&
    Array.isArray(error.body.errors) &&
    error.body.errors.some(
      (item) => isRecord(item) && item.code === "authenticationError",
    )
  );
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
  const writeError =
    context.stderr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const secrets = createRedactor(env);
  const { rememberSecret, rememberTokens, redact, redactJson } = secrets;
  const err = (text: string): void => {
    writeError(terminalSafe(redact(text)));
  };
  const json = (value: unknown, compact?: boolean): void => {
    out(
      terminalSafe(
        `${JSON.stringify(redactJson(value ?? null), null, compact ? undefined : 2)}\n`,
      ),
    );
  };
  const confirm = (question: string): Promise<boolean> =>
    context.confirm
      ? context.confirm(question)
      : confirmAction(question, context.signal);
  let ccp = false;
  let requestSent = false;
  let changeRequestSent = false;
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
        fqdn: { type: "string" },
        "domain-id": { type: "string" },
        page: { type: "string" },
        "per-page": { type: "string" },
        field: { type: "string" },
        direction: { type: "string" },
        file: { type: "string" },
      },
    });
    if (values.version) {
      out(`${version}\n`);
      return 0;
    }
    const group = positionals[0];
    ccp = group === "ccp";
    const commandArgs = ccp ? positionals.slice(1) : positionals;
    const authGroup = commandArgs[0];
    if (
      values.help ||
      positionals.length === 0 ||
      (ccp && commandArgs.length === 0)
    ) {
      if (!group) {
        onlyOptions(values, []);
        out(help);
      } else if (ccp) {
        out(
          ["login", "logout", "auth"].includes(authGroup)
            ? authHelp(authGroup, true)
            : ccpCommandHelp(),
        );
      } else if (["login", "logout", "auth"].includes(group)) {
        out(authHelp(group));
      } else {
        const text = commandHelp(group);
        if (!text)
          throw new CliUsageError(
            `Unknown command ${JSON.stringify(group)}. Run netcup --help for commands.`,
          );
        out(text);
      }
      return 0;
    }

    const login = authGroup === "login";
    const logout = authGroup === "logout";
    const status = authGroup === "auth" && commandArgs[1] === "status";
    if (authGroup === "auth" && !status)
      throw new CliUsageError(authHelp("auth", ccp));
    if (login || logout || status) {
      if (commandArgs.length !== (status ? 2 : 1))
        throw new CliUsageError(authHelp(authGroup, ccp));
      onlyOptions(values, logout && !ccp ? ["local"] : []);
    }
    let command: CliCommand | undefined;
    if (!login && !logout && !status) {
      command = ccp
        ? await resolveCcpCommand(commandArgs, values, err)
        : resolveCommand(commandArgs, values);
    }
    if (command?.confirmation && !values.yes) {
      if (command.preview) {
        if (!context.confirm && (!process.stdin.isTTY || !process.stderr.isTTY))
          throw new CliUsageError(
            `${command.confirmation}\nNo request was sent. Add --yes if you intend to run this action from a script.`,
          );
      } else if (!(await confirm(command.confirmation))) {
        throw new CliUsageError("Canceled. No request was sent.");
      }
    }

    const transport = context.fetch ?? globalThis.fetch;
    const fetch: NetcupFetch = (request) => {
      context.signal?.throwIfAborted();
      const outgoing = context.signal
        ? new Request(request, { signal: context.signal })
        : request;
      requestSent = true;
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
        changeRequestSent = true;
      return transport(outgoing);
    };
    const store = new CredentialStore(env, ccp ? "ccp" : "scp");
    let client: NetcupClient;
    if (ccp) {
      const createClient = (key?: string): NetcupClient =>
        new NetcupClient({
          ccp: { apiKey: key, baseUrl: env.NETCUP_CCP_BASE_URL, fetch },
        });
      if (login) {
        const previous = (await store.read()) ?? null;
        rememberSecret(previous);
        err(
          "Create or copy a key in CCP > Master Data > API. Input is hidden.\n",
        );
        const entered = await (context.promptSecret
          ? context.promptSecret("CCP API key: ")
          : promptSecret("CCP API key: ", context.signal));
        rememberSecret(entered);
        const key = apiKey(entered);
        err("Checking the CCP API key...\n");
        await createClient(key).ccp.domains.list({ perPage: 1 });
        context.signal?.throwIfAborted();
        await store.save(key, previous);
        err(
          `CCP key saved in ${JSON.stringify(store.path)}. This file contains a plaintext API key.\n`,
        );
        if (env.NETCUP_CCP_API_KEY?.trim())
          err(
            "NETCUP_CCP_API_KEY still takes precedence. Unset it to use the saved key.\n",
          );
        json({ authenticated: true }, values.compact);
        return 0;
      }
      const environmentKey = env.NETCUP_CCP_API_KEY?.trim();
      if (logout) {
        if (environmentKey)
          throw new CliUsageError(
            "NETCUP_CCP_API_KEY is active. Unset it before removing the saved CCP key.",
          );
        const saved = await store.read();
        if (saved) {
          rememberSecret(saved);
          context.signal?.throwIfAborted();
          await store.remove(saved);
          err(
            "Removed the local CCP key. It was not revoked. Delete it in CCP > Master Data > API to revoke access.\n",
          );
        } else {
          err(
            "No saved CCP key was found. Use netcup ccp login to save one.\n",
          );
        }
        json({ authenticated: false, revoked: false }, values.compact);
        return 0;
      }
      const publicTypes =
        commandArgs[0] === "dns" && commandArgs[1] === "types";
      const key = publicTypes
        ? undefined
        : await loadCcpKey(env, rememberSecret);
      client = createClient(key);
      if (status) {
        err("Checking the CCP API key...\n");
        await client.ccp.domains.list({ perPage: 1 });
        json(
          {
            authenticated: true,
            source: environmentKey ? "environment" : "saved",
          },
          values.compact,
        );
        return 0;
      }
    } else {
      const common = {
        fetch,
        authUrl: env.NETCUP_AUTH_URL,
        baseUrl: env.NETCUP_BASE_URL,
      };
      if (login) {
        let previous = (await store.read()) ?? null;
        rememberSecret(previous);
        const auth = new NetcupAuth({
          ...common,
          onTokens: async (tokens) => {
            rememberTokens(tokens);
            context.signal?.throwIfAborted();
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
      if (logout) {
        const { accessToken, refreshToken } = scpEnvironment(env);
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
        rememberSecret(saved);
        if (!values.local) {
          err("Revoking the saved login...\n");
          try {
            await new NetcupAuth({ ...common, refreshToken: saved }).revoke(
              undefined,
              context.signal,
            );
          } catch {
            throw new Error(
              "Could not revoke the saved login. Its file was kept. Try again, or use netcup logout --local to remove only the local file without revoking access.",
            );
          }
        }
        await store.remove(saved);
        err(
          values.local
            ? "Removed the local login file. Netcup access was not revoked.\n"
            : "Revoked the saved login and removed its file.\n",
        );
        json({ authenticated: false, revoked: !values.local }, values.compact);
        return 0;
      }
      client = new NetcupClient({
        ...common,
        ...(await loadScpAuth(env, secrets)),
      });
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
    }

    if (!command)
      throw new CliUsageError("Choose a command. Run netcup --help for usage.");
    err(`${command.label}\n`);
    if (command.preview) {
      const preview = await command.preview(client);
      err(`${JSON.stringify(redactJson(preview), null, 2)}\n`);
      if (
        command.confirmation &&
        !values.yes &&
        !(await confirm(command.confirmation))
      )
        throw new CliUsageError("Canceled. No change request was sent.");
    }
    context.signal?.throwIfAborted();
    const result = await command.execute(client);
    json(result, values.compact);
    const rows = ccp && isRecord(result) ? result.result : result;
    if (Array.isArray(rows) && rows.length === 0 && command.emptyMessage)
      err(`${command.emptyMessage}\n`);
    if (!ccp) {
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
    }
    return 0;
  } catch (error) {
    if (context.signal?.aborted || error instanceof CliCanceledError) {
      if (changeRequestSent)
        err("Canceled. A request already sent to Netcup may still run.\n");
      else if (requestSent)
        err(
          "Canceled. Only read requests were sent. No change request was sent.\n",
        );
      else err("Canceled. No request was sent.\n");
      return 130;
    }
    let message =
      error instanceof Error
        ? error.message
        : "The command failed. Try again or run netcup --help.";
    if (error instanceof NetcupAuthError) {
      if (ccp)
        message = `${message} Run netcup ccp login or check NETCUP_CCP_API_KEY.`;
      else
        message =
          error.code === "token_storage_failed"
            ? "Could not save the refreshed login. Check the login folder's permissions, then run netcup login again."
            : `${message} Use netcup login to approve access again if needed.`;
    } else if (error instanceof NetcupError) {
      if (ccp) {
        if (error.status === 401 || ccpAuthenticationError(error))
          message =
            "Netcup rejected the CCP API key. Run netcup ccp login again, or replace NETCUP_CCP_API_KEY if it is set. SCP login tokens do not work with this API.";
        else if (error.status === 403)
          message =
            "Netcup denied this CCP request. Check that the API key and domain belong to the intended account in the Customer Control Panel.";
      } else if (error.status === 401)
        message =
          "Netcup rejected the access token. Run netcup login again, or replace the token provided by your environment.";
      else if (error.status === 403)
        message =
          "Netcup denied this request. Check the account permissions and the API IP allowlist in the Server Control Panel.";
    } else if (error instanceof TypeError && requestSent) {
      message = `Could not complete the Netcup request: ${message}. Check your connection and the API address.${changeRequestSent ? " Check the control panel before retrying a change; the request may have been accepted." : " Try the read again once the connection works."}`;
    }
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
