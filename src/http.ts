import createClient from "openapi-fetch";
import type { Client } from "openapi-fetch";
import { NetcupAuth } from "./auth";
import type { AuthOptions } from "./auth";
import { NetcupError } from "./errors";
import type { paths } from "./schema";

export interface NetcupConfig extends AuthOptions {
  baseUrl?: string;
}

export function createApi(
  config: NetcupConfig,
  auth: NetcupAuth,
): Client<paths> {
  const api = createClient<paths>({
    baseUrl: (
      config.baseUrl ?? "https://servercontrolpanel.de/scp-core"
    ).replace(/\/+$/, ""),
    fetch: config.fetch,
    headers: { Accept: "application/json", Prefer: "error-i18n" },
    querySerializer: { array: { style: "form", explode: true } },
  });
  api.use({
    async onRequest({ request, schemaPath }) {
      if (schemaPath !== "/api/ping" && schemaPath !== "/api/v1/openapi") {
        request.headers.set(
          "Authorization",
          `Bearer ${await auth.getAccessToken()}`,
        );
      }
    },
  });
  return api;
}

export async function unwrap<T>(
  result: Promise<
    | { data: T; error?: never; response: Response }
    | { data?: never; error: unknown; response: Response }
  >,
): Promise<T> {
  const value = await result;
  if ("error" in value || !value.response.ok) {
    throw new NetcupError(value.response.status, value.error);
  }
  return value.data;
}
