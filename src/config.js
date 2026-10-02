function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function strongSecret(name) {
  const value = required(name);
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

function httpsUrl(name) {
  const value = required(name);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must be an HTTPS URL`);
  return value;
}

export function loadConfig() {
  const publicBaseUrl = httpsUrl("PUBLIC_BASE_URL").replace(/\/$/, "");
  const oauthRedirectUris = (process.env.OAUTH_REDIRECT_URIS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (oauthRedirectUris.some(uri => {
    const url = new URL(uri);
    return url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/aip\/g-[A-Za-z0-9_-]+\/oauth\/callback$/.test(url.pathname) || url.href !== uri;
  })) throw new Error("OAUTH_REDIRECT_URIS must contain exact ChatGPT GPT Action callback URLs");
  const ircChannels = required("IRC_CHANNELS").split(",").map(s => s.trim());
  if (ircChannels.some(c => !/^#[^\s,\x00-\x1f]{1,100}$/.test(c))) {
    throw new Error("IRC_CHANNELS must contain comma-separated channel names beginning with #");
  }
  const ircNetworks = JSON.parse(required("IRC_NETWORKS_JSON"));
  if (!Array.isArray(ircNetworks) || !ircNetworks.length || ircNetworks.some(network =>
    !/^[a-z][a-z0-9_-]{0,31}$/.test(network.name ?? "") ||
    !/^[A-Za-z0-9.-]+$/.test(network.host ?? "") ||
    !Number.isInteger(network.port) || network.port < 1 || network.port > 65535 ||
    network.tls !== true)) throw new Error("IRC_NETWORKS_JSON must list named TLS IRC servers");
  if (new Set(ircNetworks.map(network => network.name)).size !== ircNetworks.length) throw new Error("IRC network names must be unique");
  const zncPort = Number(process.env.ZNC_PORT ?? "6667");
  const port = Number(process.env.PORT ?? "3000");
  const maxUsers = Number(process.env.MAX_USERS ?? "16");
  const historyRetentionDays = Number(process.env.HISTORY_RETENTION_DAYS ?? "7");
  const historyMaxPerChannel = Number(process.env.HISTORY_MAX_PER_CHANNEL ?? "5000");
  if (![zncPort, port].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) {
    throw new Error("ZNC_PORT and PORT must be valid TCP ports");
  }
  if (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 100) throw new Error("MAX_USERS must be 1 to 100");
  if (!Number.isInteger(historyRetentionDays) || historyRetentionDays < 1 || historyRetentionDays > 365) throw new Error("HISTORY_RETENTION_DAYS must be 1 to 365");
  if (!Number.isInteger(historyMaxPerChannel) || historyMaxPerChannel < 100 || historyMaxPerChannel > 100000) throw new Error("HISTORY_MAX_PER_CHANNEL must be 100 to 100000");
  const zncHost = process.env.ZNC_HOST?.trim() || "127.0.0.1";
  const zncAdminUser = required("ZNC_ADMIN_USER");
  const zncAdminPassword = required("ZNC_ADMIN_PASSWORD");
  if (![zncAdminUser, zncAdminPassword].every(s => !/[\r\n\x00]/.test(s)) || /[/:]/.test(zncAdminUser)) {
    throw new Error("ZNC credentials contain invalid IRC characters");
  }
  if (Buffer.byteLength(`PASS ${zncAdminUser}:${zncAdminPassword}`, "utf8") > 510) {
    throw new Error("ZNC credentials exceed the IRC line limit");
  }
  const ircUsername = process.env.IRC_USERNAME?.trim() || "zircon";
  const ircRealname = process.env.IRC_REALNAME?.trim() || "Zircon ChatGPT bridge";
  if (![ircUsername, ircRealname].every(s => !/[\r\n\x00]/.test(s))) {
    throw new Error("IRC identity fields must be one line");
  }
  return {
    publicBaseUrl,
    githubClientId: required("GITHUB_CLIENT_ID"),
    githubClientSecret: strongSecret("GITHUB_CLIENT_SECRET"),
    oauthClientId: required("OAUTH_CLIENT_ID"),
    oauthClientSecret: strongSecret("OAUTH_CLIENT_SECRET"),
    oauthRedirectUris,
    sessionSecret: strongSecret("SESSION_SECRET"),
    adminToken: strongSecret("ADMIN_TOKEN"),
    stateDir: process.env.STATE_DIR?.trim() || "/var/lib/zircon",
    zncHost,
    zncPort,
    zncAdminUser,
    zncAdminPassword,
    zncUserSecret: strongSecret("ZNC_USER_SECRET"),
    ircNetworks,
    ircUsername,
    ircRealname,
    ircChannels,
    port,
    maxUsers,
    historyRetentionDays,
    historyMaxPerChannel,
  };
}
