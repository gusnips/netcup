import type { Client } from "openapi-fetch";
import type { components, paths } from "../../ccp-schema";
import { unwrapCcp } from "../../ccp-http";
import { unwrap } from "../../http";

export type CcpDomain = components["schemas"]["Domain"];
export type CcpAcmeChallenge = components["schemas"]["DomainAcmeChallenge"];
export type CcpDomainListQuery =
  paths["/v1/domain"]["get"]["parameters"]["query"];
export type CcpAcmeChallengeInput =
  paths["/v1/domain/{domainId}/acme/challenge"]["post"]["requestBody"]["content"]["application/json"];

export class CcpDomainsModule {
  constructor(private readonly api: Client<paths>) {}

  list(query?: CcpDomainListQuery) {
    return unwrapCcp(this.api.GET("/v1/domain", { params: { query } }));
  }

  listAcmeChallenges(domainId: number) {
    return unwrapCcp(
      this.api.GET("/v1/domain/{domainId}/acme/challenge", {
        params: { path: { domainId } },
      }),
    );
  }

  createAcmeChallenge(domainId: number, body: CcpAcmeChallengeInput) {
    return unwrapCcp(
      this.api.POST("/v1/domain/{domainId}/acme/challenge", {
        params: { path: { domainId } },
        body,
      }),
    );
  }

  getAcmeChallenge(domainId: number, scope: string, value: string) {
    return unwrapCcp(
      this.api.GET("/v1/domain/{domainId}/acme/challenge/{scope}/{value}", {
        params: { path: { domainId, scope, value } },
      }),
    );
  }

  async deleteAcmeChallenge(
    domainId: number,
    scope: string,
    value: string,
  ): Promise<void> {
    await unwrap(
      this.api.DELETE("/v1/domain/{domainId}/acme/challenge/{scope}/{value}", {
        params: { path: { domainId, scope, value } },
      }),
    );
  }
}
