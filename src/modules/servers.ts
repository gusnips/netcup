import type { Client } from "openapi-fetch";
import type { paths } from "../schema";
import { unwrap } from "../http";

export type ServerListQuery =
  paths["/api/v1/servers"]["get"]["parameters"]["query"];
export type ServerGetQuery =
  paths["/api/v1/servers/{serverId}"]["get"]["parameters"]["query"];
export type ServerUpdateQuery =
  paths["/api/v1/servers/{serverId}"]["patch"]["parameters"]["query"];
export type ServerLogsQuery =
  paths["/api/v1/servers/{serverId}/logs"]["get"]["parameters"]["query"];
export type StorageOptimizationQuery =
  paths["/api/v1/servers/{serverId}/storageoptimization"]["post"]["parameters"]["query"];

type SingleAttribute<
  T,
  Keys extends PropertyKey = T extends unknown ? keyof T : never,
> = T extends unknown
  ? Required<T> & Partial<Record<Exclude<Keys, keyof T>, never>>
  : never;

export type ServerUpdate = SingleAttribute<
  paths["/api/v1/servers/{serverId}"]["patch"]["requestBody"]["content"]["application/merge-patch+json"]
>;

export class ServersModule {
  constructor(private readonly api: Client<paths>) {}

  list(query?: ServerListQuery) {
    return unwrap(this.api.GET("/api/v1/servers", { params: { query } }));
  }

  get(serverId: number, query?: ServerGetQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}", {
        params: { path: { serverId }, query },
      }),
    );
  }

  async update(
    serverId: number,
    body: ServerUpdate,
    query?: ServerUpdateQuery,
  ) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.values(body).filter((value) => value !== undefined).length !== 1
    ) {
      throw new TypeError(
        'Change one server setting per call. Pass one field with a value, such as { nickname: "web-1" }.',
      );
    }
    return unwrap(
      this.api.PATCH("/api/v1/servers/{serverId}", {
        params: { path: { serverId }, query },
        headers: { "Content-Type": "application/merge-patch+json" },
        body,
      }),
    );
  }

  gpuDriver(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/gpu-driver", {
        params: { path: { serverId } },
      }),
    );
  }

  guestAgent(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/guest-agent", {
        params: { path: { serverId } },
      }),
    );
  }

  guestAgentStatus(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/guest-agent/status", {
        params: { path: { serverId } },
      }),
    );
  }

  logs(serverId: number, query?: ServerLogsQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/logs", {
        params: { path: { serverId }, query },
      }),
    );
  }

  rescueStatus(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/rescuesystem", {
        params: { path: { serverId } },
      }),
    );
  }

  activateRescue(serverId: number) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/rescuesystem", {
        params: { path: { serverId } },
      }),
    );
  }

  deactivateRescue(serverId: number) {
    return unwrap(
      this.api.DELETE("/api/v1/servers/{serverId}/rescuesystem", {
        params: { path: { serverId } },
      }),
    );
  }

  optimizeStorage(serverId: number, query?: StorageOptimizationQuery) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/storageoptimization", {
        params: { path: { serverId }, query },
      }),
    );
  }
}
