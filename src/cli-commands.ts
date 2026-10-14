import type { NetcupClient } from "./client";
import type { ServerUpdate } from "./modules/servers";
import type { components } from "./schema";

export class CliUsageError extends Error {
  readonly name = "CliUsageError";
}

export interface CommandOptions {
  limit?: string;
  offset?: string;
  search?: string;
  sort?: string[];
  nickname?: string;
  hostname?: string;
  disk?: string;
  description?: string;
  online?: boolean;
  offline?: boolean;
  hours?: string;
  yes?: boolean;
  help?: boolean;
  version?: boolean;
  compact?: boolean;
}

export interface CliCommand {
  label: string;
  execute(client: NetcupClient): Promise<unknown>;
  confirmation?: string;
  emptyMessage?: string;
  mutation?: boolean;
}

const commandUsage: Readonly<Record<string, string>> = {
  "servers list": "[--limit N] [--offset N] [--search TEXT] [--sort FIELD]",
  "servers get": "SERVER_ID",
  "servers start": "SERVER_ID",
  "servers stop": "SERVER_ID",
  "servers reboot": "SERVER_ID",
  "servers update": "SERVER_ID (--nickname TEXT | --hostname TEXT)",
  "servers logs": "SERVER_ID [--limit N] [--offset N]",
  "servers rescue": "SERVER_ID [status | on | off]",
  "tasks list": "[--limit N] [--offset N] [--search TEXT]",
  "tasks get": "TASK_ID",
  "tasks cancel": "TASK_ID",
  "snapshots list": "SERVER_ID",
  "snapshots get": "SERVER_ID NAME",
  "snapshots create":
    "SERVER_ID NAME [--description TEXT] [--disk NAME] [--online | --offline]",
  "snapshots delete": "SERVER_ID NAME",
  "snapshots export": "SERVER_ID NAME",
  "snapshots revert": "SERVER_ID NAME",
  "snapshots dry-run": "SERVER_ID [--disk NAME] [--online | --offline]",
  "disks list": "SERVER_ID",
  "disks get": "SERVER_ID DISK_NAME",
  "disks supported-drivers": "SERVER_ID",
  "metrics cpu": "SERVER_ID [--hours N]",
  "metrics disk": "SERVER_ID [--hours N]",
  "metrics network": "SERVER_ID [--hours N]",
  "metrics network-packets": "SERVER_ID [--hours N]",
};

function fail(message: string, usage: string): never {
  throw new CliUsageError(`${message}\nUsage: ${usage}`);
}

function validateArgs(
  args: string[],
  options: CommandOptions,
  usage: string,
  count: number,
  allowedOptions: readonly (keyof CommandOptions)[] = [],
  maximumCount = count,
): void {
  if (args.length < count || args.length > maximumCount) {
    const expected =
      count === maximumCount ? count : `${count} or ${maximumCount}`;
    const noun = count === 1 && maximumCount === 1 ? "argument" : "arguments";
    fail(`Expected ${expected} ${noun}, got ${args.length}.`, usage);
  }
  if (args.some((value) => value.trim().length === 0)) {
    fail("Arguments cannot be blank. Pass the ID or name shown below.", usage);
  }
  const entries: [string, unknown][] = Object.entries(options);
  for (const [name, value] of entries) {
    if (
      value !== undefined &&
      !["help", "version", "yes", "compact"].includes(name) &&
      !allowedOptions.some((allowed) => allowed === name)
    ) {
      fail(
        `The flag ${JSON.stringify(`--${name}`)} is not supported here.`,
        usage,
      );
    }
  }
}

function integer(
  value: string,
  label: string,
  minimum: number,
  usage: string,
  maximum = 2147483647,
): number {
  const number = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    fail(
      `${label} must be a whole number from ${minimum} to ${maximum}.`,
      usage,
    );
  }
  return number;
}

function pagination(options: CommandOptions, usage: string) {
  return {
    ...(options.limit === undefined
      ? {}
      : { limit: integer(options.limit, "--limit", 0, usage) }),
    ...(options.offset === undefined
      ? {}
      : { offset: integer(options.offset, "--offset", 0, usage) }),
  };
}

function snapshotOptions(
  options: CommandOptions,
  usage: string,
): components["schemas"]["ServerSnapshotCreateCheck"] {
  if (options.online && options.offline) {
    fail("Choose either --online or --offline, not both.", usage);
  }
  if (options.disk !== undefined && options.disk.trim().length === 0) {
    fail(
      "--disk needs a disk name. Run netcup disks list SERVER_ID to find it.",
      usage,
    );
  }
  return {
    ...(options.disk === undefined ? {} : { diskName: options.disk }),
    ...(options.online ? { onlineSnapshot: true } : {}),
    ...(options.offline ? { onlineSnapshot: false } : {}),
  };
}

export function resolveCommand(
  args: string[],
  options: CommandOptions,
): CliCommand {
  const [group, action, ...positionals] = args;
  const command = [group, action].filter(Boolean).join(" ");
  const suffix = Object.hasOwn(commandUsage, command)
    ? commandUsage[command]
    : undefined;
  if (suffix === undefined) {
    const help =
      commandHelp(group) === undefined
        ? "netcup --help"
        : `netcup ${group} --help`;
    return fail(
      `${command ? `Unknown command ${JSON.stringify(command)}.` : "Choose a command."} Run ${help} to see the commands.`,
      "netcup GROUP COMMAND [ARGS] [FLAGS]",
    );
  }
  const usage = `netcup ${command} ${suffix}`;

  switch (command) {
    case "servers list": {
      validateArgs(positionals, options, usage, 0, [
        "limit",
        "offset",
        "search",
        "sort",
      ]);
      if (options.sort?.some((field) => !/^-?(name|nickname)$/.test(field))) {
        fail(
          "--sort accepts name, nickname, -name or -nickname. Repeat it to sort by more than one field.",
          usage,
        );
      }
      const query = {
        ...pagination(options, usage),
        ...(options.search === undefined ? {} : { q: options.search }),
        ...(options.sort === undefined ? {} : { sort: options.sort }),
      };
      return {
        label: "Listing servers",
        execute: (client) => client.servers.list(query),
        emptyMessage:
          "No servers returned. Check --limit, remove any --search or --offset filters, or check the Netcup account used for login.",
      };
    }
    case "servers get": {
      validateArgs(positionals, options, usage, 1);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      return {
        label: `Getting server ${serverId}`,
        execute: (client) => client.servers.get(serverId),
      };
    }
    case "servers start":
    case "servers stop":
    case "servers reboot": {
      validateArgs(positionals, options, usage, 1);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      if (action === "start") {
        return {
          mutation: true,
          label: `Starting server ${serverId}`,
          execute: (client) => client.servers.update(serverId, { state: "ON" }),
        };
      }
      if (action === "stop") {
        return {
          mutation: true,
          label: `Stopping server ${serverId}`,
          execute: (client) =>
            client.servers.update(serverId, { state: "OFF" }),
          confirmation: `Stop server ${serverId}? This interrupts service and may lose unsaved data.`,
        };
      }
      return {
        mutation: true,
        label: `Resetting server ${serverId}`,
        execute: (client) =>
          client.servers.update(
            serverId,
            { state: "ON" },
            { stateOption: "RESET" },
          ),
        confirmation: `Hard reset server ${serverId}? This is not a graceful reboot. It interrupts service and may lose unsaved data.`,
      };
    }
    case "servers update": {
      validateArgs(positionals, options, usage, 1, ["nickname", "hostname"]);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      let body: ServerUpdate;
      if (options.nickname !== undefined && options.hostname === undefined) {
        if ([...options.nickname].length > 255) {
          fail(
            "--nickname is limited to 255 characters. Use a shorter name.",
            usage,
          );
        }
        body = { nickname: options.nickname };
      } else if (
        options.hostname !== undefined &&
        options.nickname === undefined
      ) {
        body = { hostname: options.hostname };
      } else {
        fail(
          "Change one setting. Pass exactly one of --nickname or --hostname.",
          usage,
        );
      }
      return {
        mutation: true,
        label: `Updating server ${serverId}`,
        execute: (client) => client.servers.update(serverId, body),
      };
    }
    case "servers logs": {
      validateArgs(positionals, options, usage, 1, ["limit", "offset"]);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      const query = pagination(options, usage);
      return {
        label: `Getting logs for server ${serverId}`,
        execute: (client) => client.servers.logs(serverId, query),
        emptyMessage: `No logs returned for server ${serverId}. Check --limit, try a smaller --offset or check the server ID.`,
      };
    }
    case "servers rescue": {
      validateArgs(positionals, options, usage, 1, [], 2);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      const mode = positionals[1] ?? "status";
      if (mode === "status") {
        return {
          label: `Getting rescue status for server ${serverId}`,
          execute: (client) => client.servers.rescueStatus(serverId),
        };
      }
      if (mode === "on") {
        return {
          mutation: true,
          label: `Activating rescue mode for server ${serverId}`,
          execute: (client) => client.servers.activateRescue(serverId),
          confirmation: `Turn rescue mode on for server ${serverId}? This may interrupt service.`,
        };
      }
      if (mode === "off") {
        return {
          mutation: true,
          label: `Deactivating rescue mode for server ${serverId}`,
          execute: (client) => client.servers.deactivateRescue(serverId),
          confirmation: `Turn rescue mode off for server ${serverId}? This may interrupt service.`,
        };
      }
      return fail("Rescue mode must be status, on or off.", usage);
    }
    case "tasks list": {
      validateArgs(positionals, options, usage, 0, [
        "limit",
        "offset",
        "search",
      ]);
      const query = {
        ...pagination(options, usage),
        ...(options.search === undefined ? {} : { q: options.search }),
      };
      return {
        label: "Listing tasks",
        execute: (client) => client.tasks.list(query),
        emptyMessage:
          "No tasks returned. Check --limit, remove any --search or --offset filters, or check the Netcup account used for login.",
      };
    }
    case "tasks get":
    case "tasks cancel": {
      validateArgs(positionals, options, usage, 1);
      const taskId = positionals[0];
      if (action === "get") {
        return {
          label: `Getting task ${JSON.stringify(taskId)}`,
          execute: (client) => client.tasks.get(taskId),
        };
      }
      return {
        mutation: true,
        label: `Canceling task ${JSON.stringify(taskId)}`,
        execute: (client) => client.tasks.cancel(taskId),
        confirmation: `Cancel task ${JSON.stringify(taskId)}? This may interrupt work on its server.`,
      };
    }
    case "snapshots list": {
      validateArgs(positionals, options, usage, 1);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      return {
        label: `Listing snapshots for server ${serverId}`,
        execute: (client) => client.snapshots.list(serverId),
        emptyMessage: `No snapshots found for server ${serverId}. Create one with netcup snapshots create ${serverId} NAME.`,
      };
    }
    case "snapshots get":
    case "snapshots delete":
    case "snapshots export":
    case "snapshots revert": {
      validateArgs(positionals, options, usage, 2);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      const name = positionals[1];
      const quotedName = JSON.stringify(name);
      if (action === "get") {
        return {
          label: `Getting snapshot ${quotedName} on server ${serverId}`,
          execute: (client) => client.snapshots.get(serverId, name),
        };
      }
      if (action === "delete") {
        return {
          mutation: true,
          label: `Deleting snapshot ${quotedName} on server ${serverId}`,
          execute: (client) => client.snapshots.delete(serverId, name),
          confirmation: `Delete snapshot ${quotedName} from server ${serverId}? You cannot restore it after deletion.`,
        };
      }
      if (action === "export") {
        return {
          mutation: true,
          label: `Exporting snapshot ${quotedName} on server ${serverId}`,
          execute: (client) => client.snapshots.export(serverId, name),
        };
      }
      return {
        mutation: true,
        label: `Restoring snapshot ${quotedName} on server ${serverId}`,
        execute: (client) => client.snapshots.revert(serverId, name),
        confirmation: `Restore snapshot ${quotedName} on server ${serverId}? This replaces disk data and discards changes made since the snapshot.`,
      };
    }
    case "snapshots create": {
      validateArgs(positionals, options, usage, 2, [
        "description",
        "disk",
        "online",
        "offline",
      ]);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      const name = positionals[1];
      if ([...name].length > 255) {
        fail(
          "Snapshot names are limited to 255 characters. Use a shorter name.",
          usage,
        );
      }
      if (
        options.description !== undefined &&
        [...options.description].length > 255
      ) {
        fail(
          "--description is limited to 255 characters. Use a shorter description.",
          usage,
        );
      }
      const body: components["schemas"]["ServerSnapshotCreate"] = {
        name,
        ...snapshotOptions(options, usage),
        ...(options.description === undefined
          ? {}
          : { description: options.description }),
      };
      return {
        mutation: true,
        label: `Creating snapshot ${JSON.stringify(name)} on server ${serverId}`,
        execute: (client) => client.snapshots.create(serverId, body),
      };
    }
    case "snapshots dry-run": {
      validateArgs(positionals, options, usage, 1, [
        "disk",
        "online",
        "offline",
      ]);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      if (options.offline && options.disk === undefined) {
        fail(
          "--offline needs --disk NAME for dry-run. Run netcup disks list SERVER_ID to find it.",
          usage,
        );
      }
      const body = snapshotOptions(options, usage);
      return {
        label: `Checking snapshot settings for server ${serverId}`,
        execute: (client) => client.snapshots.dryRun(serverId, body),
        emptyMessage: `Netcup found no problems with these snapshot settings. Create one with netcup snapshots create ${serverId} NAME and the same flags.`,
      };
    }
    case "disks list":
    case "disks supported-drivers": {
      validateArgs(positionals, options, usage, 1);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      if (action === "list") {
        return {
          label: `Listing disks for server ${serverId}`,
          execute: (client) => client.disks.list(serverId),
          emptyMessage: `No disks found for server ${serverId}. Check the server ID and its disks in Netcup's Server Control Panel.`,
        };
      }
      return {
        label: `Getting supported disk drivers for server ${serverId}`,
        execute: (client) => client.disks.supportedDrivers(serverId),
        emptyMessage: `No supported disk drivers returned for server ${serverId}. Check this server in Netcup's Server Control Panel.`,
      };
    }
    case "disks get": {
      validateArgs(positionals, options, usage, 2);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      const diskName = positionals[1];
      return {
        label: `Getting disk ${JSON.stringify(diskName)} on server ${serverId}`,
        execute: (client) => client.disks.get(serverId, diskName),
      };
    }
    case "metrics cpu":
    case "metrics disk":
    case "metrics network":
    case "metrics network-packets": {
      validateArgs(positionals, options, usage, 1, ["hours"]);
      const serverId = integer(positionals[0], "Server ID", 1, usage);
      const query =
        options.hours === undefined
          ? undefined
          : { hours: integer(options.hours, "--hours", 1, usage, 1440) };
      if (action === "cpu") {
        return {
          label: `Getting CPU metrics for server ${serverId}`,
          execute: (client) => client.metrics.cpu(serverId, query),
        };
      }
      if (action === "disk") {
        return {
          label: `Getting disk metrics for server ${serverId}`,
          execute: (client) => client.metrics.disk(serverId, query),
        };
      }
      if (action === "network") {
        return {
          label: `Getting network metrics for server ${serverId}`,
          execute: (client) => client.metrics.network(serverId, query),
        };
      }
      return {
        label: `Getting network packet metrics for server ${serverId}`,
        execute: (client) => client.metrics.networkPackets(serverId, query),
      };
    }
    default:
      return fail(
        "This command is not supported. Run netcup --help to see the commands.",
        usage,
      );
  }
}

export function commandHelp(group?: string): string | undefined {
  let details: string;
  switch (group) {
    case "servers":
      details = `\n--limit and --offset: whole numbers from 0 to 2147483647.\n--search: match a server name, nickname or IPv4 address, ignoring case.\n--sort: name or nickname; use --sort=-name for descending order. Repeat to sort by more than one field. No sort is sent by default.\nupdate changes one setting per call. Nicknames are limited to 255 characters.\nreboot performs a hard reset, not a graceful reboot. Unsaved data may be lost.\nrescue defaults to status. Turning it on or off may interrupt service.\n\nExamples:\n  netcup servers get 12345\n  netcup servers list --search web --sort=name --sort=-nickname\n  netcup servers update 12345 --nickname web-1`;
      break;
    case "tasks":
      details = `\n--limit and --offset: whole numbers from 0 to 2147483647.\n--search: match a task name, task ID or server name, ignoring case.\nA task response means the work was accepted, not that it finished. Use get to check its state.\n\nExamples:\n  netcup tasks list\n  netcup tasks get TASK_ID`;
      break;
    case "snapshots":
      details = `\nNAME: the snapshot name, not its UUID. Quote names that contain spaces.\n--description: up to 255 characters. Snapshot names have the same limit.\n--online: request an online snapshot.\n--offline: request an offline snapshot. dry-run also requires --disk NAME. Find disk names with netcup disks list SERVER_ID.\nWith neither mode flag, Netcup chooses its default.\ndry-run checks whether a snapshot can be created. It takes no snapshot name or description.\nrevert replaces disk data with the snapshot and discards later changes.\n\nExamples:\n  netcup snapshots list 12345\n  netcup snapshots create 12345 before-upgrade\n  netcup snapshots dry-run 12345 --offline --disk vda`;
      break;
    case "disks":
      details = `\nDISK_NAME: use the name returned by list.\n\nExamples:\n  netcup disks list 12345\n  netcup disks get 12345 vda`;
      break;
    case "metrics":
      details = `\n--hours: a whole number from 1 to 1440 (up to 60 days). Omit it to use Netcup's default.\n\nExamples:\n  netcup metrics cpu 12345\n  netcup metrics network 12345 --hours 24`;
      break;
    default:
      return undefined;
  }
  const usages = Object.entries(commandUsage)
    .filter(([command]) => command.startsWith(`${group} `))
    .map(([command, suffix]) => `  netcup ${command} ${suffix}`)
    .join("\n");
  return `Usage:\n${usages}\n${details}\n\nGlobal flags: --help, --version, --compact (one-line JSON), --yes (skip confirmation).`;
}
