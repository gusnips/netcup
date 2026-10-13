import type { Client } from "openapi-fetch";
import type { paths } from "../schema";
import { unwrap } from "../http";

export class MiscModule {
  constructor(private readonly api: Client<paths>) {}

  ping() {
    return unwrap(this.api.GET("/api/ping", { parseAs: "text" }));
  }

  openapi() {
    return unwrap(this.api.GET("/api/v1/openapi"));
  }

  openapiMcp() {
    return unwrap(this.api.POST("/api/v1/openapi/mcp"));
  }
}
