import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { runZncCommands, provisioningCommands, userPassword } from "../src/znc-admin.js";

const binary = process.argv[2];
if (!binary) throw new Error("Usage: bun tools/check-znc.js /path/to/znc");
const dir = mkdtempSync(join(tmpdir(), "zircon-znc-check-"));
const holder = net.createServer();
await new Promise(resolve => holder.listen(0, "127.0.0.1", resolve));
const port = holder.address().port;
await new Promise(resolve => holder.close(resolve));
const password = "temporary-local-test-secret";
const salt = "temporary-salt";
const hash = createHash("sha256").update(password + salt).digest("hex");
mkdirSync(join(dir, "configs"));
writeFileSync(join(dir, "configs", "znc.conf"), `Version = 1.10.1
<Listener loopback>
    Host = 127.0.0.1
    Port = ${port}
    IPv4 = true
    IPv6 = false
    SSL = false
    AllowIRC = true
    AllowWeb = false
</Listener>
<User zirconctl>
    Admin = true
    Nick = zirconctl
    LoadModule = controlpanel
    <Pass password>
        Method = sha256
        Salt = ${salt}
        Hash = ${hash}
    </Pass>
</User>
`);
const child = Bun.spawn([binary, "--foreground", "--datadir", dir], { stdout: "pipe", stderr: "pipe" });
const config = { zncHost: "127.0.0.1", zncPort: port, zncAdminUser: "zirconctl", zncAdminPassword: password,
  zncUserSecret: "u".repeat(32), ircNetworks: [{ name: "chonkbase", host: "irc.chonkbase.net", port: 6697, tls: true }] };
const user = { id: "test-user", github_login: "test-user", znc_username: "ztestuser", nick: "testnick", network_name: "chonkbase", selected_channels: '["#soup"]' };
let ready = false;
try {
  for (let i = 0; i < 50; i++) {
    try {
      const socket = net.connect({ host: "127.0.0.1", port });
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.destroy();
      ready = true;
      break;
    } catch { await Bun.sleep(100); }
  }
  if (!ready) throw new Error(`ZNC did not listen; stderr: ${await new Response(child.stderr).text()}`);
  await runZncCommands(config, provisioningCommands(config, user));
  const client = net.connect({ host: "127.0.0.1", port });
  const welcome = await new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("New ZNC user did not receive welcome")), 5000);
    client.on("connect", () => client.write(`PASS ${user.znc_username}/primary:${userPassword(config, user)}\r\nNICK testnick\r\nUSER zircon 0 * :Zircon\r\n`));
    client.on("data", chunk => {
      data += chunk.toString();
      if (data.includes(" 001 ")) { clearTimeout(timer); resolve(data); }
      if (data.includes(" 464 ")) { clearTimeout(timer); reject(new Error("New ZNC user authentication failed")); }
    });
    client.on("error", reject);
  });
  client.destroy();
  if (!welcome.includes("testnick")) throw new Error("Welcome did not name the configured nickname");
  const saved = readFileSync(join(dir, "configs", "znc.conf"), "utf8");
  if (!saved.includes("<User ztestuser>") || !saved.includes("<Network primary>") || !saved.includes("irc.chonkbase.net") || !saved.includes("#soup") || !saved.includes("RealName = Zircon ChatGPT bridge for test-user")) throw new Error("ZNC config did not persist the user/network/channel/real name");
  console.log("Real ZNC accepted and persisted a user, TLS network, nick and channel, then authenticated its IRC client without a restart.");
} finally {
  child.kill("SIGINT");
  await child.exited;
  rmSync(dir, { recursive: true, force: true });
}
