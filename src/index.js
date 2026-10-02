import { createHandler } from "./api.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { ZncProvisioner } from "./znc-admin.js";
import { IrcPool } from "./pool.js";

const config = loadConfig();
const store = new Store(`${config.stateDir}/zircon.sqlite`, config);
store.backup();
store.pruneActivity();
const backupTimer = setInterval(() => {
  try { store.backup(); } catch (error) { console.error("SQLite backup failed:", error.message); }
}, 24 * 60 * 60_000);
const pruneTimer = setInterval(() => {
  try { store.pruneActivity(); } catch (error) { console.error("History pruning failed:", error.message); }
}, 60 * 60_000);
const provisioner = new ZncProvisioner(config, store);
const pool = new IrcPool(config, store, provisioner);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  maxRequestBodySize: 4096,
  fetch: createHandler(config, pool, store),
});
console.info(`Zircon listening on ${server.url}`);
void pool.startAll();

process.on("SIGTERM", () => { clearInterval(backupTimer); clearInterval(pruneTimer); pool.stop(); void server.stop(); store.close(); });
process.on("SIGINT", () => { clearInterval(backupTimer); clearInterval(pruneTimer); pool.stop(); void server.stop(); store.close(); });
