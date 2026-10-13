import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export type TaskListQuery =
  paths["/api/v1/tasks"]["get"]["parameters"]["query"];

export class TasksModule {
  constructor(private readonly api: Client<paths>) {}

  list(query?: TaskListQuery) {
    return unwrap(this.api.GET("/api/v1/tasks", { params: { query } }));
  }

  get(uuid: string) {
    return unwrap(
      this.api.GET("/api/v1/tasks/{uuid}", {
        params: { path: { uuid } },
      }),
    );
  }

  cancel(uuid: string): Promise<components["schemas"]["TaskInfo"] | undefined> {
    return unwrap(
      this.api.PUT("/api/v1/tasks/{uuid}:cancel", {
        params: { path: { uuid } },
      }),
    );
  }
}
