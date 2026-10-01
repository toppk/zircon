function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpsUrl(name) {
  const value = required(name);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must be an HTTPS URL`);
  return value;
}

export function loadConfig() {
  const allowedSubjects = new Set(required("OIDC_ALLOWED_SUBJECTS").split(",").map(s => s.trim()).filter(Boolean));
  if (!allowedSubjects.size) throw new Error("OIDC_ALLOWED_SUBJECTS must include a subject");
  const ircChannels = required("IRC_CHANNELS").split(",").map(s => s.trim());
  if (ircChannels.some(c => !/^#[^\s,\x00-\x1f]{1,100}$/.test(c))) {
    throw new Error("IRC_CHANNELS must contain comma-separated channel names beginning with #");
  }
  const zncPort = Number(process.env.ZNC_PORT ?? "6697");
  const port = Number(process.env.PORT ?? "3000");
  if (![zncPort, port].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) {
    throw new Error("ZNC_PORT and PORT must be valid TCP ports");
  }
  const zncHost = process.env.ZNC_HOST?.trim() || "127.0.0.1";
  const zncUser = required("ZNC_USER");
  const zncNetwork = required("ZNC_NETWORK");
  const zncPassword = required("ZNC_PASSWORD");
  if (![zncUser, zncNetwork, zncPassword].every(s => !/[\r\n\x00]/.test(s)) || /[/:]/.test(zncUser) || /[/:]/.test(zncNetwork)) {
    throw new Error("ZNC credentials contain invalid IRC characters");
  }
  if (Buffer.byteLength(`PASS ${zncUser}/${zncNetwork}:${zncPassword}`, "utf8") > 510) {
    throw new Error("ZNC credentials exceed the IRC line limit");
  }
  const ircNick = required("IRC_NICK");
  const ircUsername = process.env.IRC_USERNAME?.trim() || "zircon";
  const ircRealname = process.env.IRC_REALNAME?.trim() || "Zircon ChatGPT bridge";
  if (![ircNick, ircUsername, ircRealname].every(s => !/[\r\n\x00]/.test(s))) {
    throw new Error("IRC identity fields must be one line");
  }
  return {
    publicBaseUrl: httpsUrl("PUBLIC_BASE_URL").replace(/\/$/, ""),
    oidcIssuer: httpsUrl("OIDC_ISSUER"),
    oidcAudience: required("OIDC_AUDIENCE"),
    oidcJwksUrl: httpsUrl("OIDC_JWKS_URL"),
    allowedSubjects,
    zncHost,
    zncPort,
    zncUser,
    zncNetwork,
    zncPassword,
    ircNick,
    ircUsername,
    ircRealname,
    ircChannels,
    port,
  };
}
