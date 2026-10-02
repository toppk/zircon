import { IrcClient } from "./irc.js";
import { userPassword } from "./znc-admin.js";

export class IrcPool {
  constructor(config, store, provisioner) {
    this.config = config;
    this.store = store;
    this.provisioner = provisioner;
    this.clients = new Map();
  }

  async forUser(user) {
    if (!user.online) throw new Error("IRC is offline for this user");
    await this.provisioner.ensure(user);
    const previous = this.clients.get(user.id);
    if (previous) {
      this.clients.delete(user.id);
      this.clients.set(user.id, previous);
      return previous;
    }
    if (this.clients.size >= (this.config.maxUsers ?? 16)) {
      const oldest = this.clients.keys().next().value;
      this.clients.get(oldest).stop();
      this.clients.delete(oldest);
    }
    const client = new IrcClient({ ...this.config, zncUser: user.znc_username, zncNetwork: "primary",
      zncPassword: userPassword(this.config, user), ircNick: user.nick,
      networkName: user.network_name, ircChannels: JSON.parse(user.selected_channels),
      onActivity: event => this.store.recordActivity(user, event) });
    this.clients.set(user.id, client);
    client.start();
    return client;
  }

  drop(userId) {
    this.clients.get(userId)?.stop();
    this.clients.delete(userId);
  }

  async startAll() {
    for (const user of this.store.activeUsers()) {
      try { await this.forUser(user); }
      catch (error) { console.error(`Could not start IRC client for ${user.github_login}:`, error.message); }
    }
  }

  async setOnline(user, online) {
    await this.provisioner.ensure(user);
    this.drop(user.id);
    const command = online ? "Reconnect" : "Disconnect";
    await this.provisioner.runner(this.config, [
      { target: "*controlpanel", command: `${command} ${user.znc_username} primary`,
        okay: online ? /^Queued network primary of user .* for a reconnect\.$/ : /^Closed IRC connection for network primary of user .*\.$/ },
      { target: "*status", command: "SaveConfig", okay: /^Wrote config to / },
    ]);
    this.store.setOnline(user.id, online);
    if (online) await this.forUser(this.store.userById(user.id));
  }

  stop() { for (const client of this.clients.values()) client.stop(); this.clients.clear(); }
}
