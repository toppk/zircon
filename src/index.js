import { createHandler } from "./api.js";
import { TokenVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import { IrcClient } from "./irc.js";

const config = loadConfig();
const irc = new IrcClient(config);
const verifier = new TokenVerifier(config);
irc.start();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  maxRequestBodySize: 4096,
  fetch: createHandler(config, irc, verifier),
});
console.info(`Zircon listening on ${server.url}`);

process.on("SIGTERM", () => { irc.stop(); void server.stop(); });
process.on("SIGINT", () => { irc.stop(); void server.stop(); });
