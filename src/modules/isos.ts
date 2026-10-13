import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export type IsoUploadQuery =
  paths["/api/v1/users/{userId}/isos/{key}"]["post"]["parameters"]["query"];

export class IsosModule {
  constructor(private readonly api: Client<paths>) {}

  getAttached(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/iso", {
        params: { path: { serverId } },
      }),
    );
  }

  attach(serverId: number, body: components["schemas"]["ServerAttachIso"]) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/iso", {
        params: { path: { serverId } },
        body,
      }),
    );
  }

  async detach(serverId: number): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/servers/{serverId}/iso", {
        params: { path: { serverId } },
      }),
    );
  }

  listAvailable(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/isoimages", {
        params: { path: { serverId } },
      }),
    );
  }

  list(userId: number) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/isos", {
        params: { path: { userId } },
      }),
    );
  }

  downloadInfo(userId: number, key: string) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/isos/{key}", {
        params: { path: { userId, key } },
      }),
    );
  }

  prepareUpload(userId: number, key: string, query?: IsoUploadQuery) {
    return unwrap(
      this.api.POST("/api/v1/users/{userId}/isos/{key}", {
        params: { path: { userId, key }, query },
      }),
    );
  }

  uploadPartUrl(
    userId: number,
    key: string,
    uploadId: string,
    partNumber: number,
  ) {
    return unwrap(
      this.api.GET(
        "/api/v1/users/{userId}/isos/{key}/{uploadId}/parts/{partNumber}",
        {
          params: { path: { userId, key, uploadId, partNumber } },
        },
      ),
    );
  }

  async completeUpload(
    userId: number,
    key: string,
    uploadId: string,
    body: components["schemas"]["S3CompletedPart"][],
  ): Promise<void> {
    await unwrap(
      this.api.PUT("/api/v1/users/{userId}/isos/{key}/{uploadId}", {
        params: { path: { userId, key, uploadId } },
        body,
      }),
    );
  }

  async delete(userId: number, key: string): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/users/{userId}/isos/{key}", {
        params: { path: { userId, key } },
      }),
    );
  }
}
