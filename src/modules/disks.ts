import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export class DisksModule {
  constructor(private readonly api: Client<paths>) {}

  list(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/disks", {
        params: { path: { serverId } },
      }),
    );
  }

  get(serverId: number, diskName: string) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/disks/{diskName}", {
        params: { path: { serverId, diskName } },
      }),
    );
  }

  updateDriver(
    serverId: number,
    body: components["schemas"]["EditDisksDriver"],
  ) {
    return unwrap(
      this.api.PATCH("/api/v1/servers/{serverId}/disks", {
        params: { path: { serverId } },
        headers: { "Content-Type": "application/merge-patch+json" },
        body,
      }),
    );
  }

  supportedDrivers(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/disks/supported-drivers", {
        params: { path: { serverId } },
      }),
    );
  }

  /** Erases all data on this disk. The server must be off and have no snapshots. */
  format(serverId: number, diskName: string) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/disks/{diskName}:format", {
        params: { path: { serverId, diskName } },
      }),
    );
  }
}
