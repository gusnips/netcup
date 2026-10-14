import type { Client } from "openapi-fetch";
import { createCcpApi, type NetcupCcpConfig } from "./ccp-http";
import type { paths } from "./ccp-schema";
import { CcpDomainsModule } from "./modules/ccp/domains";
import { CcpDnsModule } from "./modules/ccp/dns";

export class NetcupCcpClient {
  readonly api: Client<paths>;
  readonly domains: CcpDomainsModule;
  readonly dns: CcpDnsModule;

  constructor(config: NetcupCcpConfig | string = {}) {
    this.api = createCcpApi(
      typeof config === "string" ? { apiKey: config } : config,
    );
    this.domains = new CcpDomainsModule(this.api);
    this.dns = new CcpDnsModule(this.api);
  }
}
