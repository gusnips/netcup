import type { Client } from "openapi-fetch";
import type { components, paths } from "../../ccp-schema";
import { unwrapCcp } from "../../ccp-http";

export type CcpDnsRecordInput = components["schemas"]["DnsRecordInput"];
export type CcpDnsRecord = components["schemas"]["DomainDnsRecord"];
export type CcpDnsRevision = components["schemas"]["DomainDnsRevision"];
export type CcpDnsRevisionListQuery =
  paths["/v1/domain/{domainId}/dns/revision"]["get"]["parameters"]["query"];
export type CcpDnsChangeSet =
  paths["/v1/domain/{domainId}/changeset"]["post"]["requestBody"]["content"]["application/json"];
export type CcpDnsRevisionChangeSet =
  paths["/v1/domain/{domainId}/dns/revision/{revisionId}/changeset"]["post"]["requestBody"]["content"]["application/json"];

export class CcpDnsModule {
  constructor(private readonly api: Client<paths>) {}

  recordTypes() {
    return unwrapCcp(this.api.GET("/v1/dns/recordType"));
  }

  listRevisions(domainId: number, query?: CcpDnsRevisionListQuery) {
    return unwrapCcp(
      this.api.GET("/v1/domain/{domainId}/dns/revision", {
        params: { path: { domainId }, query },
      }),
    );
  }

  createRevision(domainId: number) {
    return unwrapCcp(
      this.api.POST("/v1/domain/{domainId}/dns/revision", {
        params: { path: { domainId } },
      }),
    );
  }

  getRevision(domainId: number, revisionId: string) {
    return unwrapCcp(
      this.api.GET("/v1/domain/{domainId}/dns/revision/{revisionId}", {
        params: { path: { domainId, revisionId } },
      }),
    );
  }

  deleteRevision(domainId: number, revisionId: string) {
    return unwrapCcp(
      this.api.DELETE("/v1/domain/{domainId}/dns/revision/{revisionId}", {
        params: { path: { domainId, revisionId } },
      }),
    );
  }

  applyChanges(domainId: number, body: CcpDnsChangeSet) {
    return unwrapCcp(
      this.api.POST("/v1/domain/{domainId}/changeset", {
        params: { path: { domainId } },
        body,
      }),
    );
  }

  applyRevisionChanges(
    domainId: number,
    revisionId: string,
    body: CcpDnsRevisionChangeSet,
  ) {
    return unwrapCcp(
      this.api.POST(
        "/v1/domain/{domainId}/dns/revision/{revisionId}/changeset",
        {
          params: { path: { domainId, revisionId } },
          body,
        },
      ),
    );
  }

  commitRevision(domainId: number, revisionId: string) {
    return unwrapCcp(
      this.api.POST("/v1/domain/{domainId}/dns/revision/{revisionId}/commit", {
        params: { path: { domainId, revisionId } },
      }),
    );
  }

  listRecords(domainId: number, revisionId: string) {
    return unwrapCcp(
      this.api.GET("/v1/domain/{domainId}/dns/revision/{revisionId}/record", {
        params: { path: { domainId, revisionId } },
      }),
    );
  }

  createRecord(domainId: number, revisionId: string, body: CcpDnsRecordInput) {
    return unwrapCcp(
      this.api.POST("/v1/domain/{domainId}/dns/revision/{revisionId}/record", {
        params: { path: { domainId, revisionId } },
        body,
      }),
    );
  }

  getRecord(domainId: number, revisionId: string, recordId: string) {
    return unwrapCcp(
      this.api.GET(
        "/v1/domain/{domainId}/dns/revision/{revisionId}/record/{recordId}",
        { params: { path: { domainId, revisionId, recordId } } },
      ),
    );
  }

  deleteRecord(domainId: number, revisionId: string, recordId: string) {
    return unwrapCcp(
      this.api.DELETE(
        "/v1/domain/{domainId}/dns/revision/{revisionId}/record/{recordId}",
        { params: { path: { domainId, revisionId, recordId } } },
      ),
    );
  }
}
