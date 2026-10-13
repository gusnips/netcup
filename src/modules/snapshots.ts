import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export class SnapshotsModule {
  constructor(private readonly api: Client<paths>) {}

  list(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/snapshots", {
        params: { path: { serverId } },
      }),
    );
  }

  get(serverId: number, name: string) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/snapshots/{name}", {
        params: { path: { serverId, name } },
      }),
    );
  }

  create(
    serverId: number,
    body: components["schemas"]["ServerSnapshotCreate"],
  ) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/snapshots", {
        params: { path: { serverId } },
        body,
      }),
    );
  }

  delete(serverId: number, name: string) {
    return unwrap(
      this.api.DELETE("/api/v1/servers/{serverId}/snapshots/{name}", {
        params: { path: { serverId, name } },
      }),
    );
  }

  export(serverId: number, name: string) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/snapshots/{name}/export", {
        params: { path: { serverId, name } },
      }),
    );
  }

  /** Replaces disk data with this snapshot. */
  revert(serverId: number, name: string) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/snapshots/{name}/revert", {
        params: { path: { serverId, name } },
      }),
    );
  }

  dryRun(
    serverId: number,
    body: components["schemas"]["ServerSnapshotCreateCheck"],
  ) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/snapshots:dryrun", {
        params: { path: { serverId } },
        body,
      }),
    );
  }
}
