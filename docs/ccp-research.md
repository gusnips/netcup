# Customer and DNS API research

Checked on 2026-10-13. Authentication and implementation notes updated on 2026-10-14. See the README for released command syntax.

## Implementation boundary

The separate `ccp` group uses the current domain and DNS API, not the older DNS API used by community clients. Server Control Panel (SCP) commands and credentials remain separate.

MCP support stays in v2. An MCP client should be able to launch the package through npx when needed. That still starts a local process; it does not require a separately managed server.

## Current domain and DNS API

Netcup's [API guide](https://www.netcup.com/en/helpcenter/documentation/general/netcup-api) points CloudDNS users to the new API. The [technical reference](https://www.netcup.com/en/helpcenter/documentation/netcup-api) embeds an OpenAPI 3.1 document in the page's Nuxt JSON data.

The inspected document is version `2026.0921.153936`, with base URL `https://api.netcup.com`, 11 paths and 17 operations:

| Feature            | Operations                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Domains            | List and filter domains by ID or name                                                                         |
| DNS record types   | Read the available types                                                                                      |
| DNS revisions      | List, create, read, delete and commit revisions                                                               |
| DNS records        | List, create, read and delete records within a revision                                                       |
| Change sets        | Submit record additions and deletions, either for a domain or an existing revision                            |
| Certificate checks | Create, list, read and delete ACME DNS challenges, which prove domain ownership when issuing TLS certificates |

The contract includes page-based pagination and response fields named `success`, `errors`, `messages`, `meta` and `result`. This differs from SCP's bare response bodies. Change sets require explicit `autoCommit` and `strict` fields. Do not hide the commit step or silently publish draft changes.

The document names `bearerAuth` on operations but omits its definition from `components.securitySchemes`. Read-only checks on 2026-10-14 confirmed `Authorization: Bearer <API key>`: a raw fake key was rejected as not a bearer token, while a fake bearer value was rejected as invalid or expired. This verifies header syntax, not successful authenticated access. Keys come from CCP > Master Data > API; SCP OAuth tokens and legacy DNS credentials are not substitutes.

A read-only request without credentials to `GET /v1/domain` returned HTTP 400 with `success: false` and an `authenticationError`. Do not equate authentication failure only with HTTP 401, or discard the structured API error.

No invoice, payment or server-order endpoints appear in this document. Domain listing is not proof that registration or transfer is supported here.

The original page snapshot is kept in the ignored `refs/netcup-api/` folder. `openapi-ccp.json` now holds the separate checked-in contract for generation. The supplied root `openapi.json` remains the SCP specification and was not replaced.

## What the two repositories add

Both use the legacy CCP JSON endpoint at `https://ccp.netcup.net/run/webservice/servers/endpoint.php?JSON`. Neither implements the current CloudDNS API or any SCP server API.

### netcup-node

Inspected commit: `bab999ef10258d21671db3b0f349ee0695f15300`.

Its complete action list is `login`, `infoDnsZone`, `infoDnsRecords` and `updateDnsRecords`. It reads zone settings and records, then sends batches of record changes. Its extra dynamic-DNS helper discovers the local machine's public IP and submits A or AAAA records. It does not discover an SCP server's IP.

There is no domain listing, invoice, order, customer-profile, reseller or logout implementation. DNSSEC status is read-only. The dynamic-DNS helper does not find existing record IDs, so safe repeated updates are not established.

It logs in again before each DNS call, exposes its mutable credentials through `getAuthData()` and drops structured error fields. Use it as a small payload reference, not as an authentication or validation pattern.

Evidence: [action list](https://github.com/proohit/netcup-node/blob/bab999ef10258d21671db3b0f349ee0695f15300/src/%40types/Actions.ts#L1), [transport](https://github.com/proohit/netcup-node/blob/bab999ef10258d21671db3b0f349ee0695f15300/src/api.ts#L23), [dynamic DNS](https://github.com/proohit/netcup-node/blob/bab999ef10258d21671db3b0f349ee0695f15300/src/index.ts#L146).

### netcup-api-mcp

Inspected commit: `274a8e822b2d32af74a8ed63a9d255a36ff938c4`.

It implements 11 business-action calls plus login and logout:

- The same three DNS reads and writes.
- Domain listing, domain details, transfer-code retrieval and nameserver changes.
- Reading, creating, changing and deleting domain contact handles. These are domain-registration contacts, not customer billing contacts.

Its own documentation restricts the domain and contact features to reseller accounts. Source code alone does not prove that each action works: its `domainAuthcode` and `*Contacthandle` action names differ from the current [legacy technical reference](https://ccp.netcup.net/run/webservice/servers/endpoint.php), which lists `getAuthcodeDomain` and `*Handle`. Verify the provider contract before implementing these calls; do not invent aliases.

It has no invoice, payment, order, customer-profile, registration, renewal or transfer-execution implementation. Its DNSSEC claim is not backed by a write method. Reading a transfer code does not transfer a domain.

Do not reuse its logging: it prints full requests and responses, including API passwords, keys and session IDs. It also lacks a transport timeout, validates little data and retries a request after one guessed session-error code. Its DNS write simply forwards records; the README's full-replacement claim is not a verified provider guarantee.

Evidence: [client and logging](https://github.com/JensS/netcup-api-mcp/blob/274a8e822b2d32af74a8ed63a9d255a36ff938c4/src/netcup-client.ts#L14), [business calls](https://github.com/JensS/netcup-api-mcp/blob/274a8e822b2d32af74a8ed63a9d255a36ff938c4/src/netcup-client.ts#L113), [account restrictions](https://github.com/JensS/netcup-api-mcp/blob/274a8e822b2d32af74a8ed63a9d255a36ff938c4/README.md#L413).

Both repositories are MIT-licensed. Preserve their notices if substantial code is ever copied. No code was copied for this research.

## Legacy authentication and write safety

Legacy login needs a customer number, API key and API password. Later calls use the returned session ID. Netcup's [legacy API guide](https://www.netcup.com/en/helpcenter/documentation/domain/our-api) says sessions expire after 15 minutes of inactivity. These are not SCP OAuth credentials or the new API's key contract.

The legacy API returns application status fields inside its response. Preserve status codes and request IDs instead of treating HTTP success as proof the action succeeded. Deletion uses `updateDnsRecords` with a record's deletion flag. Neither repository proves what happens to omitted records or concurrent changes; establish those rules before offering record replacement or repeated dynamic-DNS writes.

If legacy support is needed, expose it explicitly rather than silently switching backends. Start with the new API's domain and DNS operations; add reseller actions only when their contract and account requirements are confirmed.

## Scope limits

The initial research added no runtime code. The next implementation adds the current CCP client and CLI; legacy APIs and MCP remain out of scope. No real account login, DNS change or server mutation was performed. The reference repositories were read, not installed or run.
