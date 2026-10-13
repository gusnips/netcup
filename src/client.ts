import type { Client } from "openapi-fetch";
import { NetcupAuth } from "./auth";
import { createApi, type NetcupConfig } from "./http";
import { ServersModule } from "./modules/servers";
import { DisksModule } from "./modules/disks";
import { FirewallModule } from "./modules/firewall";
import { IsosModule } from "./modules/isos";
import { ImagesModule } from "./modules/images";
import { MetricsModule } from "./modules/metrics";
import { NetworkingModule } from "./modules/networking";
import { SnapshotsModule } from "./modules/snapshots";
import { TasksModule } from "./modules/tasks";
import { UsersModule } from "./modules/users";
import { MiscModule } from "./modules/misc";
import type { paths } from "./schema";

export class NetcupClient {
  readonly auth: NetcupAuth;
  readonly api: Client<paths>;
  readonly servers: ServersModule;
  readonly disks: DisksModule;
  readonly firewall: FirewallModule;
  readonly isos: IsosModule;
  readonly images: ImagesModule;
  readonly metrics: MetricsModule;
  readonly networking: NetworkingModule;
  readonly snapshots: SnapshotsModule;
  readonly tasks: TasksModule;
  readonly users: UsersModule;
  readonly misc: MiscModule;

  constructor(config: NetcupConfig | string) {
    const options =
      typeof config === "string" ? { accessToken: config } : config;
    this.auth = new NetcupAuth(options);
    this.api = createApi(options, this.auth);
    this.servers = new ServersModule(this.api);
    this.disks = new DisksModule(this.api);
    this.firewall = new FirewallModule(this.api);
    this.isos = new IsosModule(this.api);
    this.images = new ImagesModule(this.api);
    this.metrics = new MetricsModule(this.api);
    this.networking = new NetworkingModule(this.api);
    this.snapshots = new SnapshotsModule(this.api);
    this.tasks = new TasksModule(this.api);
    this.users = new UsersModule(this.api);
    this.misc = new MiscModule(this.api);
  }
}
