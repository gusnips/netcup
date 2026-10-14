import { readFile } from "node:fs/promises";
import type { NetcupClient } from "./client";
import {
  CliUsageError,
  integer,
  validateArgs,
  type CliCommand,
  type CommandOptions,
} from "./cli-commands";
import { isRecord } from "./errors";
import type { CcpDomainListQuery } from "./modules/ccp/domains";
import type {
  CcpDnsChangeSet,
  CcpDnsRecordInput,
  CcpDnsRevisionListQuery,
} from "./modules/ccp/dns";

const commandUsage: Readonly<Record<string, string>> = {
  "domains list":
    "[--fqdn HOSTNAME] [--domain-id N] [--page N] [--per-page N] [--field domainId|fqdn] [--direction asc|desc]",
  "dns types": "",
  "dns revisions":
    "DOMAIN_ID [--page N] [--per-page N] [--field FIELD] [--direction asc|desc]",
  "dns records": "DOMAIN_ID REVISION_UUID",
  "dns prepare": "DOMAIN_ID --file CHANGES.json",
  "dns review": "DOMAIN_ID REVISION_UUID",
  "dns commit": "DOMAIN_ID REVISION_UUID",
};

const revisionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(message: string, usage: string): never {
  throw new CliUsageError(`${message}\nUsage: ${usage}`);
}

function positiveInteger(value: string, label: string, usage: string): number {
  return integer(value, label, 1, usage, Number.MAX_SAFE_INTEGER);
}

function listOptions(
  options: CommandOptions,
  usage: string,
): Omit<NonNullable<CcpDnsRevisionListQuery>, "field"> {
  const direction = options.direction;
  if (direction !== undefined && direction !== "asc" && direction !== "desc") {
    fail("--direction must be asc or desc.", usage);
  }
  return {
    ...(options.page === undefined
      ? {}
      : { page: positiveInteger(options.page, "--page", usage) }),
    ...(options["per-page"] === undefined
      ? {}
      : {
          perPage: positiveInteger(options["per-page"], "--per-page", usage),
        }),
    ...(direction === undefined ? {} : { direction }),
  };
}

function revisionId(value: string, usage: string): string {
  if (!revisionIdPattern.test(value)) {
    fail(
      "Revision ID must be a UUID. Run netcup ccp dns revisions DOMAIN_ID to find one.",
      usage,
    );
  }
  return value;
}

function isRecordType(value: unknown): value is CcpDnsRecordInput["type"] {
  return (
    value === "A" ||
    value === "AAAA" ||
    value === "CAA" ||
    value === "CNAME" ||
    value === "DS" ||
    value === "MX" ||
    value === "NS" ||
    value === "OPENPGPKEY" ||
    value === "SRV" ||
    value === "SMIMEA" ||
    value === "SSHFP" ||
    value === "TLSA" ||
    value === "TXT"
  );
}

function records(
  value: unknown,
  label: string,
  usage: string,
): CcpDnsRecordInput[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of DNS records.`, usage);
  }
  return value.map((record: unknown, index: number): CcpDnsRecordInput => {
    const entry = `${label}[${index}]`;
    if (
      !isRecord(record) ||
      Object.keys(record).some(
        (key) => !["name", "type", "rdata", "ttl"].includes(key),
      )
    ) {
      fail(`${entry} must contain only name, type, rdata and ttl.`, usage);
    }
    if (typeof record.name !== "string" || [...record.name].length > 255) {
      fail(`${entry}.name must be a string of up to 255 characters.`, usage);
    }
    if (!isRecordType(record.type)) {
      fail(
        `${entry}.type must be A, AAAA, CAA, CNAME, DS, MX, NS, OPENPGPKEY, SRV, SMIMEA, SSHFP, TLSA or TXT.`,
        usage,
      );
    }
    if (typeof record.rdata !== "string" || [...record.rdata].length > 65535) {
      fail(`${entry}.rdata must be a string of up to 65535 characters.`, usage);
    }
    if (
      typeof record.ttl !== "number" ||
      !Number.isSafeInteger(record.ttl) ||
      record.ttl < 1
    ) {
      fail(
        `${entry}.ttl must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}.`,
        usage,
      );
    }
    return {
      name: record.name,
      type: record.type,
      rdata: record.rdata,
      ttl: record.ttl,
    };
  });
}

async function readChanges(
  file: string,
  usage: string,
): Promise<CcpDnsChangeSet> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return fail(
      "Could not read --file. Check the file path and read permissions, then try again.",
      usage,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return fail(
      "The changes file is not valid JSON. Fix the JSON and run prepare again.",
      usage,
    );
  }
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => key !== "create" && key !== "delete")
  ) {
    fail(
      "The changes file must contain only create and delete arrays. Do not include autoCommit or strict; prepare sets them to false and true.",
      usage,
    );
  }
  const create =
    input.create === undefined
      ? undefined
      : records(input.create, "create", usage);
  const deleted =
    input.delete === undefined
      ? undefined
      : records(input.delete, "delete", usage);
  if ((create?.length ?? 0) + (deleted?.length ?? 0) === 0) {
    fail(
      "Add at least one record to create or delete before running prepare.",
      usage,
    );
  }
  return {
    autoCommit: false,
    strict: true,
    ...(create === undefined ? {} : { create }),
    ...(deleted === undefined ? {} : { delete: deleted }),
  };
}

async function readRevision(
  client: NetcupClient,
  domainId: number,
  revision: string,
) {
  const revisionResponse = await client.ccp.dns.getRevision(domainId, revision);
  const recordsResponse = await client.ccp.dns.listRecords(domainId, revision);
  if (!Array.isArray(recordsResponse.result)) {
    throw new Error(
      `Cannot review or commit revision ${revision} for domain ${domainId}: Netcup did not return a record list. Review the revision in the Customer Control Panel or ask Netcup to check its API response. No commit request was sent.`,
    );
  }
  const pagination = recordsResponse.meta?.pagination;
  if (
    pagination &&
    ((pagination.totalEntries !== undefined &&
      pagination.totalEntries > recordsResponse.result.length) ||
      (pagination.nextPage !== undefined &&
        pagination.nextPage > (pagination.page ?? 1)) ||
      (pagination.page !== undefined && pagination.page > 1) ||
      (pagination.lastPage !== undefined && pagination.lastPage > 1))
  ) {
    throw new Error(
      `Cannot review or commit revision ${revision} for domain ${domainId}: Netcup's pagination says some records were omitted, but its API documents no record paging flags. Review the revision in the Customer Control Panel or ask Netcup how to retrieve every record before committing. No commit request was sent.`,
    );
  }
  return { revision: revisionResponse, records: recordsResponse };
}

export async function resolveCcpCommand(
  args: string[],
  options: CommandOptions,
  writeError: (text: string) => void,
): Promise<CliCommand> {
  const [group, action, ...positionals] = args;
  const command = [group, action].filter(Boolean).join(" ");
  const suffix = Object.hasOwn(commandUsage, command)
    ? commandUsage[command]
    : undefined;
  if (suffix === undefined) {
    return fail(
      `${command ? `Unknown command ${JSON.stringify(`ccp ${command}`)}.` : "Choose a CCP command."} Run netcup ccp --help to see the commands.`,
      "netcup ccp GROUP COMMAND [ARGS] [FLAGS]",
    );
  }
  const usage = `netcup ccp ${command}${suffix ? ` ${suffix}` : ""}`;

  switch (command) {
    case "domains list": {
      validateArgs(positionals, options, usage, 0, [
        "fqdn",
        "domain-id",
        "page",
        "per-page",
        "field",
        "direction",
      ]);
      const field = options.field;
      if (field !== undefined && field !== "domainId" && field !== "fqdn") {
        fail("--field must be domainId or fqdn for domains list.", usage);
      }
      if (options.fqdn !== undefined && options.fqdn.trim().length === 0) {
        fail("--fqdn needs a hostname, such as example.com.", usage);
      }
      const query: CcpDomainListQuery = {
        ...listOptions(options, usage),
        ...(field === undefined ? {} : { field }),
        ...(options.fqdn === undefined ? {} : { fqdn: options.fqdn }),
        ...(options["domain-id"] === undefined
          ? {}
          : {
              domainId: positiveInteger(
                options["domain-id"],
                "--domain-id",
                usage,
              ),
            }),
      };
      return {
        label: "Listing Customer Control Panel domains",
        emptyMessage:
          "No domains returned on this page. Check the filters or page number. Add domains in the Customer Control Panel.",
        execute: (client) => client.ccp.domains.list(query),
      };
    }
    case "dns types": {
      validateArgs(positionals, options, usage, 0);
      return {
        label: "Getting supported DNS record types",
        execute: (client) => client.ccp.dns.recordTypes(),
      };
    }
    case "dns revisions": {
      validateArgs(positionals, options, usage, 1, [
        "page",
        "per-page",
        "field",
        "direction",
      ]);
      const domainId = positiveInteger(positionals[0], "Domain ID", usage);
      if (options.field !== undefined && options.field.trim().length === 0) {
        fail("--field needs a nonblank sort field supported by Netcup.", usage);
      }
      const query: CcpDnsRevisionListQuery = {
        ...listOptions(options, usage),
        ...(options.field === undefined ? {} : { field: options.field }),
      };
      return {
        label: `Listing DNS revisions for domain ${domainId}`,
        emptyMessage: `No DNS revisions returned on this page. Check the domain ID or page number. Use netcup ccp dns prepare ${domainId} --file CHANGES.json to submit changes.`,
        execute: (client) => client.ccp.dns.listRevisions(domainId, query),
      };
    }
    case "dns prepare": {
      validateArgs(positionals, options, usage, 1, ["file"]);
      const domainId = positiveInteger(positionals[0], "Domain ID", usage);
      if (options.file === undefined || options.file.trim().length === 0) {
        fail(
          "Pass --file CHANGES.json with the records to create or delete.",
          usage,
        );
      }
      const body = await readChanges(options.file, usage);
      return {
        mutation: true,
        label: `Preparing DNS changes for domain ${domainId}`,
        confirmation: `Prepare a remote DNS change for domain ${domainId}? Automatic commit is disabled. No commit request will be sent.`,
        execute: async (client) => {
          const response = await client.ccp.dns.applyChanges(domainId, body);
          const revision = response.result?.identifier;
          if (
            typeof revision !== "string" ||
            !revisionIdPattern.test(revision)
          ) {
            throw new Error(
              `Netcup accepted changes but returned no revision ID. Run netcup ccp dns revisions ${domainId} before retrying.`,
            );
          }
          writeError(
            `Automatic commit is disabled. No commit request was sent.\nReview the revision with netcup ccp dns review ${domainId} ${revision}.\n`,
          );
          return response;
        },
      };
    }
    case "dns records":
    case "dns review":
    case "dns commit": {
      validateArgs(positionals, options, usage, 2);
      const domainId = positiveInteger(positionals[0], "Domain ID", usage);
      const revision = revisionId(positionals[1], usage);
      if (action === "records") {
        return {
          label: `Getting records for DNS revision ${revision} on domain ${domainId}`,
          emptyMessage: `No records returned for this revision. Check its ID in netcup ccp dns revisions ${domainId}. Use prepare to submit DNS changes.`,
          execute: (client) => client.ccp.dns.listRecords(domainId, revision),
        };
      }
      if (action === "review") {
        return {
          label: `Reviewing DNS revision ${revision} on domain ${domainId}`,
          execute: (client) => readRevision(client, domainId, revision),
        };
      }
      return {
        mutation: true,
        label: `Reviewing DNS revision ${revision} for domain ${domainId} before publication`,
        confirmation: `Publish DNS revision ${revision} for domain ${domainId}? This can replace DNS records.`,
        preview: (client) => readRevision(client, domainId, revision),
        execute: (client) => {
          writeError(
            `Submitting DNS revision ${revision} for domain ${domainId} for publication...\n`,
          );
          return client.ccp.dns.commitRevision(domainId, revision);
        },
      };
    }
    default:
      return fail("Run netcup ccp --help to see the commands.", usage);
  }
}

export function ccpCommandHelp(): string {
  const usages = Object.entries(commandUsage)
    .map(
      ([command, suffix]) =>
        `  netcup ccp ${command}${suffix ? ` ${suffix}` : ""}`,
    )
    .join("\n");
  return `Read Customer Control Panel domains and review DNS changes before publishing them.

Usage:
  netcup ccp login
  netcup ccp logout
  netcup ccp auth status
${usages}

DOMAIN_ID: a whole number from 1 to ${Number.MAX_SAFE_INTEGER}. Find it with netcup ccp domains list.
REVISION_UUID: the exact UUID returned by revisions or prepare. There is no latest or current shortcut.
--domain-id, --page and --per-page: whole numbers from 1 to ${Number.MAX_SAFE_INTEGER}.
--fqdn filters domains by hostname. --field sorts domains by domainId or fqdn; revision sort fields are passed to Netcup unchanged. --direction is asc or desc.
records, review and commit accept no paging or sorting flags. Review and commit stop if record metadata reports omitted records.

DNS workflow:
  1. List domains: netcup ccp domains list
  2. Prepare a remote change: netcup ccp dns prepare DOMAIN_ID --file CHANGES.json
  3. Review that revision: netcup ccp dns review DOMAIN_ID REVISION_UUID
  4. Publish that revision: netcup ccp dns commit DOMAIN_ID REVISION_UUID

The changes file accepts only create and delete arrays. Each record needs name, type, rdata (its value) and ttl (seconds to cache it). Use @ as the name for the domain itself. Delete uses the full record, not a record ID. Put MX and SRV priority inside rdata.
prepare sets autoCommit to false and strict to true. It sends one remote changeset request, not a commit request. commit fetches the revision and its records for review even with --yes, then sends one commit request after confirmation.
Review shows Netcup's revision and record responses, not a local diff. Without pagination metadata, it cannot confirm that every record was returned.

Global flags: --help, --version, --compact (one-line JSON), --yes (skip confirmation, not commit review).
`;
}
