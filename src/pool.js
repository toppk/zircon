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
    await this.provisioner.ensure(user);
    const previous = this.clients.get(user.id);
    if (previous) {
      this.clients.delete(user.id);
      this.clients.set(user.id, previous);
      return previous;
    }
    if (this.clients.size >= 16) {
      const oldest = this.clients.keys().next().value;
      this.clients.get(oldest).stop();
      this.clients.delete(oldest);
    }
    const client = new IrcClient({ ...this.config, zncUser: user.znc_username, zncNetwork: "primary",
      zncPassword: userPassword(this.config, user), ircNick: user.nick,
      ircChannels: JSON.parse(user.selected_channels) });
    this.clients.set(user.id, client);
    client.start();
    return client;
  }

  drop(userId) {
    this.clients.get(userId)?.stop();
    this.clients.delete(userId);
  }

  stop() { for (const client of this.clients.values()) client.stop(); this.clients.clear(); }
}
