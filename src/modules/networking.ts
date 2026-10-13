import type { Client } from "openapi-fetch";
import type { components, paths } from "../schema";
import { unwrap } from "../http";

export type ServerInterfacesQuery =
  paths["/api/v1/servers/{serverId}/interfaces"]["get"]["parameters"]["query"];
export type ServerInterfaceQuery =
  paths["/api/v1/servers/{serverId}/interfaces/{mac}"]["get"]["parameters"]["query"];
export type FailoverIpv4Query =
  paths["/api/v1/users/{userId}/failoverips/v4"]["get"]["parameters"]["query"];
export type FailoverIpv6Query =
  paths["/api/v1/users/{userId}/failoverips/v6"]["get"]["parameters"]["query"];
export type VlanListQuery =
  paths["/api/v1/users/{userId}/vlans"]["get"]["parameters"]["query"];

export class NetworkingModule {
  constructor(private readonly api: Client<paths>) {}

  listInterfaces(serverId: number, query?: ServerInterfacesQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/interfaces", {
        params: { path: { serverId }, query },
      }),
    );
  }

  getInterface(serverId: number, mac: string, query?: ServerInterfaceQuery) {
    return unwrap(
      this.api.GET("/api/v1/servers/{serverId}/interfaces/{mac}", {
        params: { path: { serverId, mac }, query },
      }),
    );
  }

  createInterface(
    serverId: number,
    body: components["schemas"]["ServerCreateNicVlan"],
  ) {
    return unwrap(
      this.api.POST("/api/v1/servers/{serverId}/interfaces", {
        params: { path: { serverId } },
        body,
      }),
    );
  }

  updateInterface(
    serverId: number,
    mac: string,
    body: components["schemas"]["ServerInterfaceUpdate"],
  ): Promise<components["schemas"]["TaskInfo"] | undefined> {
    return unwrap(
      this.api.PUT("/api/v1/servers/{serverId}/interfaces/{mac}", {
        params: { path: { serverId, mac } },
        body,
      }),
    );
  }

  deleteInterface(serverId: number, mac: string) {
    return unwrap(
      this.api.DELETE("/api/v1/servers/{serverId}/interfaces/{mac}", {
        params: { path: { serverId, mac } },
      }),
    );
  }

  getRdnsIpv4(ip: string) {
    return unwrap(
      this.api.GET("/api/v1/rdns/ipv4/{ip}", { params: { path: { ip } } }),
    );
  }

  setRdnsIpv4(body: components["schemas"]["SetRdnsIpv4"]) {
    return unwrap(this.api.POST("/api/v1/rdns/ipv4", { body }));
  }

  async deleteRdnsIpv4(ip: string): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/rdns/ipv4/{ip}", { params: { path: { ip } } }),
    );
  }

  getRdnsIpv6(ip: string) {
    return unwrap(
      this.api.GET("/api/v1/rdns/ipv6/{ip}", { params: { path: { ip } } }),
    );
  }

  setRdnsIpv6(body: components["schemas"]["SetRdnsIpv6"]) {
    return unwrap(this.api.POST("/api/v1/rdns/ipv6", { body }));
  }

  async deleteRdnsIpv6(ip: string): Promise<void> {
    await unwrap(
      this.api.DELETE("/api/v1/rdns/ipv6/{ip}", { params: { path: { ip } } }),
    );
  }

  listFailoverIpv4(userId: number, query?: FailoverIpv4Query) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/failoverips/v4", {
        params: { path: { userId }, query },
      }),
    );
  }

  routeFailoverIpv4(
    userId: number,
    id: number,
    body: components["schemas"]["RouteFailoverIp"],
  ) {
    return unwrap(
      this.api.PATCH("/api/v1/users/{userId}/failoverips/v4/{id}", {
        params: { path: { userId, id } },
        headers: { "Content-Type": "application/merge-patch+json" },
        body,
      }),
    );
  }

  listFailoverIpv6(userId: number, query?: FailoverIpv6Query) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/failoverips/v6", {
        params: { path: { userId }, query },
      }),
    );
  }

  routeFailoverIpv6(
    userId: number,
    id: number,
    body: components["schemas"]["RouteFailoverIp"],
  ) {
    return unwrap(
      this.api.PATCH("/api/v1/users/{userId}/failoverips/v6/{id}", {
        params: { path: { userId, id } },
        headers: { "Content-Type": "application/merge-patch+json" },
        body,
      }),
    );
  }

  listVlans(userId: number, query?: VlanListQuery) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/vlans", {
        params: { path: { userId }, query },
      }),
    );
  }

  getUserVlan(userId: number, vlanId: number) {
    return unwrap(
      this.api.GET("/api/v1/users/{userId}/vlans/{vlanId}", {
        params: { path: { userId, vlanId } },
      }),
    );
  }

  async updateVlan(
    userId: number,
    vlanId: number,
    body: components["schemas"]["VLanSave"],
  ): Promise<void> {
    await unwrap(
      this.api.PUT("/api/v1/users/{userId}/vlans/{vlanId}", {
        params: { path: { userId, vlanId } },
        body,
      }),
    );
  }

  getVlan(vlanId: number) {
    return unwrap(
      this.api.GET("/api/v1/vlans/{vlanId}", {
        params: { path: { vlanId } },
      }),
    );
  }
}
