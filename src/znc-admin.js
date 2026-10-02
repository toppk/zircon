import net from "node:net";
import { createHmac } from "node:crypto";
import { parseIrcLine } from "./irc.js";

export function userPassword(config, user) {
  return createHmac("sha256", config.zncUserSecret).update(user.id).digest("base64url");
}

const safeWord = value => /^[A-Za-z0-9_#.-]{1,100}$/.test(value);

export function provisioningCommands(config, user) {
  const network = config.ircNetworks.find(item => item.name === user.network_name);
  const channels = JSON.parse(user.selected_channels);
  if (!network || !safeWord(user.znc_username) || !/^[a-z0-9-]{1,39}$/.test(user.github_login ?? "") ||
      !/^[A-Za-z][A-Za-z0-9_\-\[\]\\`^{}|]{0,30}$/.test(user.nick) ||
      channels.some(channel => !/^#[^\s,\x00-\x1f]{1,100}$/.test(channel))) throw new Error("Invalid ZNC configuration");
  const name = user.znc_username;
  const realName = `${config.ircRealname ?? "Zircon ChatGPT bridge"} for ${user.github_login}`;
  if (/[\r\n\x00]/.test(realName)) throw new Error("Invalid ZNC real name");
  return [
    { target: "*controlpanel", command: `AddUser ${name} ${userPassword(config, user)}`, okay: /^(User .* added!|Error: User .* already exists!)$/ },
    { target: "*controlpanel", command: `Set RealName ${name} ${realName}`, okay: /^RealName = / },
    { target: "*controlpanel", command: `DelNetwork ${name} primary`, okay: /^(Network primary deleted|Error: User .* does not have a network named \[primary\])/, },
    { target: "*controlpanel", command: `AddNetwork ${name} primary`, okay: /^Network primary added to user / },
    { target: "*controlpanel", command: `SetNetwork nick ${name} primary ${user.nick}`, okay: /^Nick = / },
    ...channels.map(channel => ({ target: "*controlpanel", command: `AddChan ${name} primary ${channel}`, okay: /^Channel .* added to network / })),
    { target: "*controlpanel", command: `AddServer ${name} primary ${network.host} +${network.port}`, okay: /^Added IRC Server / },
    { target: "*controlpanel", command: `Reconnect ${name} primary`, okay: /^Queued network primary of user .* for a reconnect\.$/ },
    { target: "*status", command: "SaveConfig", okay: /^Wrote config to / },
  ];
}

export function runZncCommands(config, commands, connect = net.connect) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: config.zncHost, port: config.zncPort });
    let buffer = "";
    let index = 0;
    let ready = false;
    let finished = false;
    const timeout = setTimeout(() => finish(new Error("ZNC administration timed out")), 20_000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve();
    }
    function write(line) {
      if (/[\r\n\x00]/.test(line) || Buffer.byteLength(line) > 510) return finish(new Error("Invalid ZNC command"));
      socket.write(`${line}\r\n`);
    }
    function sendNext() {
      if (index >= commands.length) return finish();
      const command = commands[index];
      write(`PRIVMSG ${command.target} :${command.command}`);
    }
    socket.on("connect", () => {
      write(`PASS ${config.zncAdminUser}:${config.zncAdminPassword}`);
      write("NICK zirconctl");
      write("USER zirconctl 0 * :Zircon control");
    });
    socket.on("data", data => {
      buffer += data.toString("utf8");
      if (buffer.length > 65536) return finish(new Error("ZNC administration response too large"));
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1 && !finished) {
        const raw = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const line = parseIrcLine(raw);
        if (line.command === "PING") { write(`PONG :${line.params.at(-1)}`); continue; }
        if (["464", "465"].includes(line.command)) return finish(new Error("ZNC administrator authentication failed"));
        if (line.command === "001" && !ready) { ready = true; sendNext(); continue; }
        if (!ready || line.command !== "PRIVMSG" || !line.prefix) continue;
        const source = line.prefix.split("!", 1)[0]?.toLowerCase();
        const expected = commands[index];
        if (source !== expected.target.toLowerCase()) continue;
        const reply = line.params.at(-1) ?? "";
        if (!expected.okay.test(reply)) return finish(new Error(`ZNC rejected ${expected.command.split(" ", 1)[0]}: ${reply}`));
        index++;
        sendNext();
      }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!finished) finish(new Error("ZNC administration connection closed")); });
  });
}

export class ZncProvisioner {
  constructor(config, store, runner = runZncCommands) { this.config = config; this.store = store; this.runner = runner; this.pending = new Map(); }
  async ensure(user) {
    if (user.provisioned) return;
    let task = this.pending.get(user.id);
    if (!task) {
      const work = Promise.resolve().then(async () => {
        await this.runner(this.config, provisioningCommands(this.config, user));
        this.store.markProvisioned(user.id, user.config_version);
      });
      task = work.finally(() => this.pending.delete(user.id));
      this.pending.set(user.id, task);
    }
    await task;
    if (!this.store.userById(user.id).provisioned) return this.ensure(this.store.userById(user.id));
  }
}
