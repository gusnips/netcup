import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export type ImageUploadQuery =
  paths["/api/v1/users/{userId}/images/{key}"]["post"]["parameters"]["query"];

export class ImagesModule {
  constructor(private readonly api: Client<paths>) {}

  listFlavours(serverId: number) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/imageflavours", {
        params: { path: { serverId } },
      }),
    );
  }

  /** Erases data on the selected disk and installs the image. */
  setup(serverId: number, body: components["schemas"]["ServerImageSetup"]) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/image", {
        params: { path: { serverId } },
        body,
      }),
    );
  }

  /** Replaces disk data with an image you uploaded. */
  setupUserImage(
    serverId: number,
    body: components["schemas"]["ServerUserImageSetup"],
  ) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/user-image", {
        params: { path: { serverId } },
        body,
      }),
    );
  }

  list(userId: number) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/images", {
        params: { path: { userId } },
      }),
    );
  }

  downloadInfo(userId: number, key: string) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/images/{key}", {
        params: { path: { userId, key } },
      }),
    );
  }

  prepareUpload(userId: number, key: string, query?: ImageUploadQuery) {
    return unwrap(
      this.api.POST("/api/v1/users/{userId}/images/{key}", {
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
        "/api/v1/users/{userId}/images/{key}/{uploadId}/parts/{partNumber}",
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
      this.api.PUT("/api/v1/users/{userId}/images/{key}/{uploadId}", {
        params: { path: { userId, key, uploadId } },
        body,
      }),
    );
  }

  async delete(userId: number, key: string): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/users/{userId}/images/{key}", {
        params: { path: { userId, key } },
      }),
    );
  }
}
