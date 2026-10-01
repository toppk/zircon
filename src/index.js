import { createHandler } from "./api.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { ZncProvisioner } from "./znc-admin.js";
import { IrcPool } from "./pool.js";

const config = loadConfig();
const store = new Store(`${config.stateDir}/zircon.sqlite`);
const provisioner = new ZncProvisioner(config, store);
const pool = new IrcPool(config, store, provisioner);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  maxRequestBodySize: 4096,
  fetch: createHandler(config, pool, store),
});
console.info(`Zircon listening on ${server.url}`);

process.on("SIGTERM", () => { pool.stop(); void server.stop(); store.close(); });
process.on("SIGINT", () => { pool.stop(); void server.stop(); store.close(); });
