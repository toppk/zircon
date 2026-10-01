import net from "node:net";
import { StringDecoder } from "node:string_decoder";

export function parseIrcLine(input) {
  let line = input;
  let prefix;
  if (line.startsWith(":")) {
    const space = line.indexOf(" ");
    if (space < 0) return { command: "", params: [] };
    prefix = line.slice(1, space);
    line = line.slice(space + 1);
  }
  const trailing = line.indexOf(" :");
  const words = trailing < 0
    ? line.trim().split(/\s+/)
    : [...line.slice(0, trailing).trim().split(/\s+/), line.slice(trailing + 2)];
  return { prefix, command: (words.shift() ?? "").toUpperCase(), params: words };
}

export class IrcClient {
  constructor(config) {
    this.config = config;
    this.socket = undefined;
    this.reconnectTimer = undefined;
    this.stopping = false;
    this.reconnectDelay = 1000;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.joined = new Set();
    this.history = new Map();
    this.connected = false;
    for (const channel of config.ircChannels) this.history.set(channel.toLowerCase(), []);
  }

  start() {
    this.stopping = false;
    this.connect();
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
    this.joined.clear();
  }

  messages(channel, limit) {
    return (this.history.get(channel.toLowerCase()) ?? []).slice(-limit);
  }

  sendMessage(channel, text) {
    if (!this.joined.has(channel.toLowerCase())) throw new Error("IRC channel is not joined");
    if (!text || /[\r\n\x00]/.test(text)) throw new RangeError("Message must be one line");
    this.write(`PRIVMSG ${channel} :${text}`);
  }

  write(line) {
    if (/[\r\n\x00]/.test(line) || Buffer.byteLength(line, "utf8") > 510) {
      throw new RangeError("IRC line exceeds 510 bytes or contains a control character");
    }
    if (!this.socket || this.socket.destroyed) throw new Error("IRC is disconnected");
    this.socket.write(`${line}\r\n`);
  }

  connect() {
    if (this.stopping) return;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    const socket = net.connect({ host: this.config.zncHost, port: this.config.zncPort });
    this.socket = socket;
    socket.on("connect", () => this.onConnect());
    socket.on("data", data => this.onData(data));
    socket.on("error", error => console.error("IRC socket error:", error.message));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connected = false;
      this.joined.clear();
      if (!this.stopping) {
        const delay = this.reconnectDelay + Math.random() * this.reconnectDelay / 4;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      }
    });
  }

  onConnect() {
    console.info(`Connected to local ZNC on ${this.config.zncHost}:${this.config.zncPort}`);
    this.write(`PASS ${this.config.zncUser}/${this.config.zncNetwork}:${this.config.zncPassword}`);
    this.write(`NICK ${this.config.ircNick}`);
    this.write(`USER ${this.config.ircUsername} 0 * :${this.config.ircRealname}`);
  }

  onData(data) {
    this.buffer += this.decoder.write(data);
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") <= 510) this.onLine(line);
    }
    if (this.buffer.length > 65536) {
      console.error("IRC input exceeded buffer limit");
      this.socket?.destroy();
    }
  }

  onLine(line) {
    const { prefix, command, params } = parseIrcLine(line);
    if (command === "PING" && params.length) {
      this.write(`PONG :${params.at(-1)}`);
    } else if (["432", "433", "436", "464", "465"].includes(command)) {
      console.error(`IRC registration failed: ${command}`);
      this.socket?.destroy();
    } else if (command === "001") {
      this.reconnectDelay = 1000;
      this.connected = true;
      for (const channel of this.config.ircChannels) this.write(`JOIN ${channel}`);
    } else if (command === "JOIN" && prefix && params.length) {
      if (prefix.split("!", 1)[0]?.toLowerCase() === this.config.ircNick.toLowerCase()) {
        this.joined.add(params[0].toLowerCase());
      }
    } else if (command === "PART" && prefix && params.length) {
      if (prefix.split("!", 1)[0]?.toLowerCase() === this.config.ircNick.toLowerCase()) {
        this.joined.delete(params[0].toLowerCase());
      }
    } else if (command === "KICK" && params.length >= 2) {
      if (params[1].toLowerCase() === this.config.ircNick.toLowerCase()) this.joined.delete(params[0].toLowerCase());
    } else if (command === "PRIVMSG" && prefix && params.length >= 2) {
      const messages = this.history.get(params[0].toLowerCase());
      if (messages) {
        messages.push({ time: new Date().toISOString(), channel: params[0], nick: prefix.split("!", 1)[0] ?? "", text: params[1] });
        if (messages.length > 500) messages.shift();
      }
    }
  }
}
