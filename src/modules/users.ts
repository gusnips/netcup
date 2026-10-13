import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export type UserLogsQuery =
  paths["/api/v1/users/{userId}/logs"]["get"]["parameters"]["query"];

export class UsersModule {
  constructor(private readonly api: Client<paths>) {}

  get(userId: number) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}", {
        params: { path: { userId } },
      }),
    );
  }

  update(userId: number, body: components["schemas"]["UserSave"]) {
    return unwrap(
      this.api.PUT("/api/v1/users/{userId}", {
        params: { path: { userId } },
        body,
      }),
    );
  }

  logs(userId: number, query?: UserLogsQuery) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/logs", {
        params: { path: { userId }, query },
      }),
    );
  }

  listSshKeys(userId: number) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/ssh-keys", {
        params: { path: { userId } },
      }),
    );
  }

  createSshKey(userId: number, body: components["schemas"]["SSHKey"]) {
    return unwrap(
      this.api.POST("/api/v1/users/{userId}/ssh-keys", {
        params: { path: { userId } },
        body,
      }),
    );
  }

  async deleteSshKey(userId: number, id: number): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/users/{userId}/ssh-keys/{id}", {
        params: { path: { userId, id } },
      }),
    );
  }
}
