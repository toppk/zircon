import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/api.js";
import { IrcClient, parseIrcLine } from "../src/irc.js";
import { Store } from "../src/store.js";
import { provisioningCommands, runZncCommands, userPassword } from "../src/znc-admin.js";

const base = "https://zircon.example.com";
const callback = "https://chatgpt.com/aip/g-example/oauth/callback";
const config = { publicBaseUrl: base, githubClientId: "github-client", githubClientSecret: "github-secret", oauthClientId: "zircon-chatgpt", oauthClientSecret: "client-secret",
  oauthRedirectUris: [callback], sessionSecret: "session-secret", adminToken: "admin-secret", ircChannels: ["#soup", "#other"],
  ircNetworks: [{ name: "chonkbase", host: "irc.chonkbase.net", port: 6697, tls: true }], zncUserSecret: "u".repeat(32),
  zncHost: "127.0.0.1", zncPort: 6667, zncUser: "zircon", zncNetwork: "chonkbase", zncPassword: "znc-secret",
  ircNick: "zircon", ircUsername: "zircon", ircRealname: "Zircon" };

test("IRC parser and stream handle replay and split UTF-8", () => {
  expect(parseIrcLine(":alice!u@h PRIVMSG #soup :hello there").params).toEqual(["#soup", "hello there"]);
  const irc = new IrcClient(config);
  const writes = [];
  irc.socket = { destroyed: false, write: line => writes.push(line) };
  irc.onData(Buffer.from(":server 001 zircon :welcome\r\n:zircon!u@h JOIN :#soup\r\nPING :server\r\n"));
  const message = Buffer.from(":alice!u@h PRIVMSG #soup :caf\u00e9\r\n");
  irc.onData(message.subarray(0, message.length - 4));
  irc.onData(message.subarray(message.length - 4));
  expect(irc.messages("#soup", 1)[0].text).toBe("caf\u00e9");
  expect(writes).toEqual(["JOIN #soup\r\n", "JOIN #other\r\n", "PONG :server\r\n"]);
});

test("ZNC login uses the configured network", () => {
  const irc = new IrcClient(config);
  const writes = [];
  irc.socket = { destroyed: false, write: line => writes.push(line) };
  const info = console.info;
  console.info = () => {};
  try { irc.onConnect(); } finally { console.info = info; }
  expect(writes[0]).toBe("PASS zircon/chonkbase:znc-secret\r\n");
});

test("GitHub invite, consent, PKCE, API, refresh and revocation", async () => {
  const store = new Store(":memory:");
  const irc = new IrcClient(config);
  irc.joined.add("#soup");
  const sent = [];
  irc.sendMessage = (channel, text) => sent.push([channel, text]);
  const pool = { forUser: async () => irc, drop: () => {}, provisioner: { ensure: async () => {} } };
  const handle = createHandler(config, pool, store, async () => ({ id: "123", login: "alice" }));
  const req = (path, init = {}) => handle(new Request(new URL(path, base), init));
  const form = (fields, cookie) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields) });
  try {
    expect((await req("/healthz")).status).toBe(200);
    expect((await req("/admin/invite", { method: "POST", headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" }, body: JSON.stringify({ github_login: "alice", channels: ["#soup"] }) })).status).toBe(201);
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: config.oauthClientId, redirect_uri: callback, state: "state-1", scope: "irc:read irc:write", code_challenge: challenge, code_challenge_method: "S256" })}`;
    expect((await req(authorize.replace(encodeURIComponent(callback), encodeURIComponent("https://evil.example/callback")))).status).toBe(400);
    const begin = await req(authorize);
    const requestId = new URL(begin.headers.get("location")).searchParams.get("request_id");
    expect((await req(`/oauth/authorize?request_id=${requestId}`)).headers.get("location")).toContain("/login");
    const githubRedirect = await req(`/login?request_id=${requestId}`);
    const githubState = new URL(githubRedirect.headers.get("location")).searchParams.get("state");
    const githubCookie = githubRedirect.headers.get("set-cookie").split(";")[0];
    expect((await req(`/login/github/callback?state=${githubState}&code=sample`)).status).toBe(200);
    const signedIn = await req(`/login/github/callback?state=${githubState}&code=sample`, { headers: { Cookie: githubCookie } });
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    expect((await req(`/login/github/callback?state=${githubState}&code=sample`)).status).toBe(200);
    const consent = await req(`/oauth/authorize?request_id=${requestId}`, { headers: { Cookie: cookie } });
    const csrf = (await consent.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const settings = { display_name: "Alice", network_name: "chonkbase", nick: "Alice", channel: "#soup" };
    expect((await req("/settings", form({ csrf: "bad", ...settings }, cookie))).status).toBe(403);
    expect((await req("/settings", form({ csrf, ...settings, channel: "#other" }, cookie))).status).toBe(400);
    expect((await req("/settings", form({ csrf, ...settings }, cookie))).status).toBe(303);
    expect((await req("/oauth/authorize/approve", form({ csrf: "bad", request_id: requestId, decision: "approve" }, cookie))).status).toBe(403);
    const approved = await req("/oauth/authorize/approve", form({ csrf, request_id: requestId, decision: "approve" }, cookie));
    const callbackUrl = new URL(approved.headers.get("location"));
    expect(callbackUrl.searchParams.get("state")).toBe("state-1");
    const code = callbackUrl.searchParams.get("code");
    const client = { client_id: config.oauthClientId, client_secret: config.oauthClientSecret };
    const badExchange = await req("/oauth/token", form({ ...client, grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: "wrong" }));
    expect(badExchange.status).toBe(400);
    const tokenResponse = await req("/oauth/token", form({ ...client, grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: verifier }));
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    expect((await req("/oauth/token", form({ ...client, grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: verifier }))).status).toBe(400);
    const bearer = { Authorization: `Bearer ${tokens.access_token}` };
    expect((await req("/v1/status", { headers: bearer })).status).toBe(200);
    expect((await req("/v1/channels/other/messages", { headers: bearer })).status).toBe(404);
    expect((await req("/v1/channels/soup/messages", { method: "POST", headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }) })).status).toBe(202);
    expect(sent).toEqual([["#soup", "hello"]]);
    expect(store.db.query("SELECT github_login,text FROM audit").get()).toEqual({ github_login: "alice", text: "hello" });
    const refreshedResponse = await req("/oauth/token", form({ ...client, grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json();
    expect((await req("/oauth/token", form({ ...client, grant_type: "refresh_token", refresh_token: tokens.refresh_token }))).status).toBe(400);
    await req("/oauth/revoke", form({ ...client, token: refreshed.access_token }));
    expect((await req("/v1/status", { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(401);
  } finally { store.close(); }
});

test("one ZNC account and network are provisioned per invited user", () => {
  const store = new Store(":memory:");
  try {
    const alice = store.invite("alice", ["#soup"], "chonkbase");
    const bob = store.invite("bob", ["#soup"], "chonkbase");
    expect(alice.znc_username).not.toBe(bob.znc_username);
    expect(userPassword(config, alice)).not.toBe(userPassword(config, bob));
    const commands = provisioningCommands(config, alice).map(item => item.command);
    expect(commands).toContain(`AddServer ${alice.znc_username} primary irc.chonkbase.net +6697`);
    expect(commands).toContain(`SetNetwork nick ${alice.znc_username} primary alice`);
    expect(commands.at(-1)).toBe("SaveConfig");
  } finally { store.close(); }
});

test("online SQLite backup contains committed users while WAL is active", () => {
  const dir = mkdtempSync(join(tmpdir(), "zircon-backup-test-"));
  const store = new Store(join(dir, "zircon.sqlite"));
  try {
    store.invite("alice", ["#soup"], "chonkbase");
    const backup = store.backup();
    const copy = new Store(backup);
    try { expect(copy.userByLogin("alice").github_login).toBe("alice"); }
    finally { copy.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ZNC controlpanel provisions dynamically over one IRC listener", async () => {
  const seen = [];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("USER ")) socket.write(":znc 001 zirconctl :welcome\r\n");
        if (!line.startsWith("PRIVMSG ")) continue;
        seen.push(line);
        const command = line.split(" :")[1].split(" ")[0];
        const replies = { AddUser: "User ztest added!", DelNetwork: "Error: User ztest does not have a network named [primary].",
          AddNetwork: "Network primary added to user ztest.", AddServer: "Added IRC Server irc.chonkbase.net +6697 to network primary for user ztest.",
          SetNetwork: "Nick = test", AddChan: "Channel #soup for user ztest added to network primary.", SaveConfig: "Wrote config to /var/lib/znc/configs/znc.conf" };
        const source = command === "SaveConfig" ? "*status" : "*controlpanel";
        socket.write(`:${source}!x@znc.in PRIVMSG zirconctl :${replies[command]}\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const testConfig = { ...config, zncPort: server.address().port, zncAdminUser: "zirconctl", zncAdminPassword: "secret" };
    const commands = provisioningCommands(testConfig, { id: "user-id", znc_username: "ztest", nick: "test", network_name: "chonkbase", selected_channels: '["#soup"]' });
    await runZncCommands(testConfig, commands);
    expect(seen).toHaveLength(commands.length);
    expect(seen.at(-1)).toBe("PRIVMSG *status :SaveConfig");
  } finally { server.close(); }
});
