import type { Client } from "openapi-fetch";
import type { paths } from "../schema";
import { unwrap } from "../http";

export type CpuMetricsQuery =
  paths["/api/v1/servers/{serverId}/metrics/cpu"]["get"]["parameters"]["query"];
export type DiskMetricsQuery =
  paths["/api/v1/servers/{serverId}/metrics/disk"]["get"]["parameters"]["query"];
export type NetworkMetricsQuery =
  paths["/api/v1/servers/{serverId}/metrics/network"]["get"]["parameters"]["query"];
export type NetworkPacketMetricsQuery =
  paths["/api/v1/servers/{serverId}/metrics/network/packet"]["get"]["parameters"]["query"];

export class MetricsModule {
  constructor(private readonly api: Client<paths>) {}

  cpu(serverId: number, query?: CpuMetricsQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/metrics/cpu", {
        params: { path: { serverId }, query },
      }),
    );
  }

  disk(serverId: number, query?: DiskMetricsQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/metrics/disk", {
        params: { path: { serverId }, query },
      }),
    );
  }

  network(serverId: number, query?: NetworkMetricsQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/metrics/network", {
        params: { path: { serverId }, query },
      }),
    );
  }

  networkPackets(serverId: number, query?: NetworkPacketMetricsQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/metrics/network/packet", {
        params: { path: { serverId }, query },
      }),
    );
  }
}
