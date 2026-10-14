import createClient from "openapi-fetch";
import type { Client } from "openapi-fetch";
import type { NetcupFetch } from "./auth";
import { isRecord, NetcupAuthError, NetcupError } from "./errors";
import type { paths } from "./ccp-schema";

export interface NetcupCcpConfig {
  apiKey?: string;
  baseUrl?: string;
  fetch?: NetcupFetch;
}

export function createCcpApi(config: NetcupCcpConfig): Client<paths> {
  const api = createClient<paths>({
    baseUrl: (config.baseUrl ?? "https://api.netcup.com").replace(/\/+$/, ""),
    fetch: config.fetch,
    headers: { Accept: "application/json" },
  });
  api.use({
    onRequest({ request, schemaPath }) {
      if (schemaPath === "/v1/dns/recordType" && request.method === "GET") {
        request.headers.delete("Authorization");
        return;
      }
      if (config.apiKey === undefined) {
        throw new NetcupAuthError(
          "missing_api_key",
          "Provide a CCP API key as apiKey in the CCP client configuration before calling this endpoint.",
        );
      }
      if (
        typeof config.apiKey !== "string" ||
        !/^[!-~]+$/.test(config.apiKey)
      ) {
        throw new NetcupAuthError(
          "invalid_api_key",
          "The CCP API key must contain only printable characters with no spaces. Copy the key from CCP and try again.",
        );
      }
      request.headers.set("Authorization", `Bearer ${config.apiKey}`);
    },
  });
  return api;
}

export async function unwrapCcp<T>(
  result: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const value = await result;
  if ("error" in value || !value.response.ok) {
    throw new NetcupError(value.response.status, value.error);
  }
  const body = value.data;
  if (isRecord(body) && body.success === false) {
    throw new NetcupError(value.response.status, body);
  }
  if (
    !isRecord(body) ||
    body.success !== true ||
    !Array.isArray(body.errors) ||
    !Array.isArray(body.messages) ||
    !(body.meta === null || isRecord(body.meta)) ||
    !Object.hasOwn(body, "result")
  ) {
    throw new NetcupError(
      value.response.status,
      body,
      "Netcup returned an invalid CCP response. Check the API response before using this result.",
    );
  }
  return body;
}
