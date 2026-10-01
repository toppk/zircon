import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHandler } from "../src/api.js";
import { TokenVerifier } from "../src/auth.js";
import { IrcClient, parseIrcLine } from "../src/irc.js";

const config = {
  publicBaseUrl: "https://zircon.example.com",
  oidcIssuer: "https://id.example.com/",
  oidcAudience: "https://zircon.example.com",
  oidcJwksUrl: "https://id.example.com/keys",
  allowedSubjects: new Set(["user-1"]),
  zncHost: "127.0.0.1",
  zncPort: 6697,
  zncUser: "zircon",
  zncNetwork: "example",
  zncPassword: "secret",
  ircNick: "zircon",
  ircUsername: "zircon",
  ircRealname: "Zircon",
  ircChannels: ["#room"],
  port: 3000,
};

test("IRC parser keeps trailing text intact", () => {
  expect(parseIrcLine(":alice!u@h PRIVMSG #room :hello there")).toEqual({
    prefix: "alice!u@h", command: "PRIVMSG", params: ["#room", "hello there"],
  });
  expect(parseIrcLine("PING :server.example")).toEqual({ command: "PING", params: ["server.example"] });
});

test("IRC stream handles split UTF-8, joins, and PING", () => {
  const irc = new IrcClient(config);
  const writes = [];
  irc.socket = { destroyed: false, write: line => writes.push(line) };
  irc.onData(Buffer.from(":server 001 zircon :welcome\r\n:zircon!u@h JOIN :#room\r\nPING :server\r\n"));
  const message = Buffer.from(":alice!u@h PRIVMSG #room :caf\u00e9\r\n");
  irc.onData(message.subarray(0, message.length - 4));
  irc.onData(message.subarray(message.length - 4));
  expect(irc.connected).toBe(true);
  expect(irc.joined.has("#room")).toBe(true);
  expect(irc.messages("#room", 1)[0]).toMatchObject({ nick: "alice", text: "caf\u00e9" });
  expect(writes).toEqual(["JOIN #room\r\n", "PONG :server\r\n"]);
});

test("ZNC login uses the configured network and never logs the password", () => {
  const irc = new IrcClient(config);
  const writes = [];
  irc.socket = { destroyed: false, write: line => writes.push(line) };
  const originalInfo = console.info;
  const logs = [];
  console.info = message => logs.push(message);
  try {
    irc.onConnect();
  } finally {
    console.info = originalInfo;
  }
  expect(writes).toEqual([
    "PASS zircon/example:secret\r\n",
    "NICK zircon\r\n",
    "USER zircon 0 * :Zircon\r\n",
  ]);
  expect(logs.join(" ")).not.toContain("secret");
});

test("OIDC verification and API enforce identity, scopes, and channel allowlist", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const verifier = new TokenVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  const makeToken = (sub, scope, audience = config.oidcAudience) => new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(config.oidcIssuer).setAudience(audience).setSubject(sub)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const readToken = await makeToken("user-1", "irc:read");
  const writeToken = await makeToken("user-1", "irc:write");
  const wrongSubject = await makeToken("other-user", "irc:read");
  const wrongAudience = await makeToken("user-1", "irc:read", "other-api");

  await expect(verifier.verify(`Bearer ${readToken}`, "irc:read")).resolves.toHaveProperty("sub", "user-1");
  await expect(verifier.verify(`Bearer ${readToken}`, "irc:write")).rejects.toMatchObject({ status: 403 });
  await expect(verifier.verify(`Bearer ${wrongSubject}`, "irc:read")).rejects.toMatchObject({ status: 403 });
  await expect(verifier.verify(`Bearer ${wrongAudience}`, "irc:read")).rejects.toMatchObject({ status: 401 });

  const irc = new IrcClient(config);
  irc.joined.add("#room");
  const sent = [];
  irc.sendMessage = (channel, text) => { sent.push([channel, text]); };
  const handle = createHandler(config, irc, verifier);
  const request = (path, token, method = "GET", body) => handle(new Request(`https://zircon.example.com${path}`, {
    method, headers: token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));

  expect((await request("/healthz")).status).toBe(200);
  expect((await request("/v1/status")).status).toBe(401);
  expect((await request("/v1/status", readToken)).status).toBe(200);
  expect((await request("/v1/channels/elsewhere/messages", readToken)).status).toBe(404);
  expect((await request("/v1/channels/room/messages", readToken, "POST", { text: "hello" })).status).toBe(403);
  expect((await request("/v1/channels/room/messages", writeToken, "POST", { text: "one\ntwo" })).status).toBe(422);
  expect((await request("/v1/channels/room/messages", writeToken, "POST", { text: "hello" })).status).toBe(202);
  expect(sent).toEqual([["#room", "hello"]]);
});
