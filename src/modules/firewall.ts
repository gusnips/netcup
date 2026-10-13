import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export type FirewallQuery =
  paths["/api/v1/servers/{serverId}/interfaces/{mac}/firewall"]["get"]["parameters"]["query"];
export type FirewallPolicyListQuery =
  paths["/api/v1/users/{userId}/firewall-policies"]["get"]["parameters"]["query"];

export class FirewallModule {
  constructor(private readonly api: Client<paths>) {}

  get(serverId: number, mac: string, query?: FirewallQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/interfaces/{mac}/firewall", {
        params: { path: { serverId, mac }, query },
      }),
    );
  }

  update(
    serverId: number,
    mac: string,
    body: components["schemas"]["ServerFirewallSave"],
  ) {
    return unwrap(
      this.api.PUT("/api/v1/servers/{serverId}/interfaces/{mac}/firewall", {
        params: { path: { serverId, mac } },
        body,
      }),
    );
  }

  reapply(serverId: number, mac: string) {
    return unwrap(
      this.api.POST(
        "/api/v1/servers/{serverId}/interfaces/{mac}/firewall:reapply",
        {
          params: { path: { serverId, mac } },
        },
      ),
    );
  }

  restoreCopiedPolicies(serverId: number, mac: string) {
    return unwrap(
      this.api.POST(
        "/api/v1/servers/{serverId}/interfaces/{mac}/firewall:restore-copied-policies",
        { params: { path: { serverId, mac } } },
      ),
    );
  }

  listPolicies(userId: number, query?: FirewallPolicyListQuery) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/firewall-policies", {
        params: { path: { userId }, query },
      }),
    );
  }

  getPolicy(userId: number, id: number) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/firewall-policies/{id}", {
        params: { path: { userId, id } },
      }),
    );
  }

  createPolicy(
    userId: number,
    body: components["schemas"]["FirewallPolicySave"],
  ) {
    return unwrap(
      this.api.POST("/api/v1/users/{userId}/firewall-policies", {
        params: { path: { userId } },
        body,
      }),
    );
  }

  updatePolicy(
    userId: number,
    id: number,
    body: components["schemas"]["FirewallPolicySave"],
  ) {
    return unwrap(
      this.api.PUT("/api/v1/users/{userId}/firewall-policies/{id}", {
        params: { path: { userId, id } },
        body,
      }),
    );
  }

  async deletePolicy(userId: number, id: number): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/users/{userId}/firewall-policies/{id}", {
        params: { path: { userId, id } },
      }),
    );
  }
}
