import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { githubIdentity } from "./github.js";
import { randomToken, tokenHash } from "./store.js";

const SESSION_COOKIE = "__Host-zircon_session";
const GITHUB_COOKIE = "__Host-zircon_github_state";
const allowedScopes = new Set(["irc:read", "irc:write"]);
const logo = readFileSync(new URL("./assets/logo.png", import.meta.url));
const stylesheet = readFileSync(new URL("./assets/ui.css", import.meta.url));

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function redirect(location, headers = {}) {
  const result = new Headers(headers);
  result.set("Location", location);
  result.set("Cache-Control", "no-store");
  return new Response(null, { status: 303, headers: result });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function page(title, body, formOrigins = []) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" href="/logo.png" type="image/png"><link rel="stylesheet" href="/ui.css"></head><body><main><div class="brand"><img src="/logo.png" width="42" height="42" alt="">Zircon IRC</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'${formOrigins.length ? ` ${formOrigins.join(" ")}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
    },
  });
}
function cookieValue(request, name = SESSION_COOKIE) {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  const entry = cookies.find(part => part.trim().startsWith(`${name}=`));
  return entry?.trim().slice(name.length + 1) ?? null;
}
function csrf(config, sessionToken) {
  return createHmac("sha256", config.sessionSecret).update(sessionToken).digest("base64url");
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
function sameOrigin(request, baseUrl) {
  const origin = request.headers.get("origin");
  return origin === new URL(baseUrl).origin ||
    (origin === "null" && request.headers.get("sec-fetch-site") === "same-origin");
}
function oauthError(error, status = 400) {
  return json({ error }, status);
}
function authenticateClient(request, form, config, store) {
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const pair = Buffer.from(header.slice(6), "base64").toString("utf8");
      const colon = pair.indexOf(":");
      id = decodeURIComponent(pair.slice(0, colon));
      secret = decodeURIComponent(pair.slice(colon + 1));
    } catch { return false; }
  }
  if (id === config.oauthClientId && equal(secret, config.oauthClientSecret)) return { id, resource: null };
  const registered = typeof id === "string" ? store.oauthClient(id) : null;
  if (registered) {
    const basic = header.startsWith("Basic ");
    if (registered.authMethod === "none" && !secret && !header) return { id, resource: baseResource(config) };
    if (registered.authMethod === "client_secret_post" && !header && typeof secret === "string" && equal(tokenHash(secret), registered.secretHash)) return { id, resource: baseResource(config) };
    if (registered.authMethod === "client_secret_basic" && basic && typeof secret === "string" && equal(tokenHash(secret), registered.secretHash)) return { id, resource: baseResource(config) };
  }
  return null;
}

const baseResource = config => config.publicBaseUrl;
function chatgptRedirect(uri) {
  if (typeof uri !== "string") return false;
  try {
    const url = new URL(uri);
    return url.origin === "https://chatgpt.com" && !url.search && !url.hash &&
      (url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname)) && url.href === uri;
  } catch { return false; }
}

export function createWebHandler(config, store, pool, getGithubIdentity = githubIdentity) {
  const base = config.publicBaseUrl;
  const sessionUser = request => store.sessionUser(cookieValue(request));
  const requireCsrf = (request, form) => {
    const session = cookieValue(request);
    return session && sameOrigin(request, base) && equal(form.get("csrf"), csrf(config, session));
  };

  return async request => {
    const url = new URL(request.url, base);
    const path = url.pathname;

    if (path === "/logo.png" && request.method === "GET") return new Response(logo, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });
    if (path === "/ui.css" && request.method === "GET") return new Response(stylesheet, {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    });

    if (["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(path) && request.method === "GET") return json({
      resource: base, authorization_servers: [base], scopes_supported: ["irc:read", "irc:write"],
      resource_documentation: "https://toppk.github.io/zircon/api.html", resource_policy_uri: `${base}/privacy`,
    });
    if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") return json({
      issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`, revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"], scopes_supported: ["irc:read", "irc:write"],
    });
    if (path === "/oauth/register" && request.method === "POST") {
      if (!store.allowRate("oauth-register", 30, 3600_000)) return oauthError("slow_down", 429);
      let client;
      try { client = await request.json(); } catch { return oauthError("invalid_client_metadata"); }
      const uris = client?.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.length > 4 || !uris.every(chatgptRedirect) ||
          (client.token_endpoint_auth_method && !["none", "client_secret_post", "client_secret_basic"].includes(client.token_endpoint_auth_method)) ||
          (client.grant_types && (!Array.isArray(client.grant_types) || client.grant_types.some(grant => !["authorization_code", "refresh_token"].includes(grant))))) {
        return oauthError("invalid_client_metadata");
      }
      const authMethod = client.token_endpoint_auth_method ?? "client_secret_basic";
      const registered = store.registerClient([...new Set(uris)], authMethod);
      return json({ client_id: registered.id, ...(registered.secret ? { client_secret: registered.secret, client_secret_expires_at: 0 } : {}),
        redirect_uris: uris, token_endpoint_auth_method: authMethod,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
    }

    if (path === "/admin/events" && request.method === "GET") {
      if (!config.diagnosticsEnabled) return json({ error: "Not found" }, 404);
      const browserUser = sessionUser(request);
      const allowedSession = browserUser && config.diagnosticsAdminLogins?.includes(browserUser.github_login);
      const allowedToken = equal(request.headers.get("authorization") ?? "", `Bearer ${config.adminToken}`);
      if (!allowedSession && !allowedToken) return json({ error: "Unauthorized" }, 401);
      const rawLimit = url.searchParams.get("limit") ?? "50";
      const rawSince = url.searchParams.get("since");
      if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200 ||
          (rawSince !== null && (Number.isNaN(Date.parse(rawSince)) || rawSince.length > 40)) ||
          [...url.searchParams.keys()].some(key => !["limit", "since"].includes(key))) {
        return json({ error: "Invalid diagnostics query" }, 400);
      }
      const since = rawSince === null ? null : new Date(rawSince).toISOString();
      return json({ capturedAt: new Date().toISOString(), events: store.adminEvents(since, Number(rawLimit)) });
    }

    if (path === "/privacy" && request.method === "GET") return page("Zircon privacy", `<p>Zircon uses GitHub to identify invited users. It stores your GitHub username and numeric ID, IRC settings, browser sessions, hashed OAuth tokens, and an audit of messages you send. It does not store your GitHub access token after sign-in.</p>
      <p>Zircon stores channel messages and activity seen through your own ZNC account for up to ${config.historyRetentionDays ?? 7} days or ${config.historyMaxPerChannel ?? 5000} entries per channel, whichever limit is reached first. Times marked as server time came from IRC; observed times mark when Zircon saw a line. ChatGPT receives messages and activity when you use the MCP read tools. Staying online lets Zircon keep recording; going offline stops new collection.</p>
      ${config.diagnosticsEnabled ? `<p>While diagnostics are enabled, Zircon also keeps up to 2000 recent MCP call and IRC connection records for up to ${config.historyRetentionDays ?? 7} days. These records include the signed-in user, action, time and result, but not OAuth tokens or tool arguments. Only the owner can view them.</p>` : ""}
      <p>If you subscribe to a mention event in ChatGPT, Zircon sends matching channel text, sender, channel and timestamps to the callback ChatGPT provides. You can list and revoke subscriptions in settings. Zircon stores subscription filters, callback URLs, signing secrets and a bounded queue of pending deliveries in its database.</p>
      <p>Your IRC nickname, channels, and messages are visible to people on the IRC networks you use. The database and ZNC buffers are included in host backups and may remain there beyond live retention until those backups expire. Contact the Zircon owner to request account removal.</p>`);

    if (path === "/oauth/authorize" && request.method === "GET") {
      let auth;
      const requestId = url.searchParams.get("request_id");
      if (requestId) {
        auth = store.authRequest(requestId);
      } else {
        const query = url.searchParams;
        const clientId = query.get("client_id");
        const redirectUri = query.get("redirect_uri");
        const state = query.get("state");
        const scope = query.get("scope") ?? "";
        const codeChallenge = query.get("code_challenge");
        const method = query.get("code_challenge_method");
        const scopes = scope.split(" ").filter(Boolean);
        const registered = store.oauthClient(clientId);
        const resource = query.get("resource");
        if (query.get("response_type") !== "code" ||
            !(registered ? registered.redirectUris.includes(redirectUri) && resource === base : clientId === config.oauthClientId && config.oauthRedirectUris.includes(redirectUri) && !resource) ||
            !state || state.length > 512 ||
            !scopes.length || scopes.some(item => !allowedScopes.has(item)) ||
            (codeChallenge && (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || method !== "S256")) ||
            (!codeChallenge && method) || (registered && !codeChallenge)) return oauthError("invalid_request");
        const id = store.createAuthRequest({ clientId, redirectUri, state, scope: [...new Set(scopes)].join(" "), codeChallenge, resource });
        return redirect(`${base}/oauth/authorize?request_id=${encodeURIComponent(id)}`);
      }
      if (!auth) return page("Authorization expired", "<p>Please start connecting Zircon from ChatGPT again.</p>");
      const user = sessionUser(request);
      if (!user) return redirect(`${base}/login?request_id=${encodeURIComponent(requestId)}`);
      const token = cookieValue(request);
      const scopeDetails = {
        "irc:read": ["Read your IRC channels", "View channel activity and search history. You may also subscribe to mention events sent to ChatGPT."],
        "irc:write": ["Send messages and change IRC presence", "Post to enabled channels and connect or disconnect your IRC network."],
      };
      const scopes = auth.scope.split(" ").map(scope => {
        const [heading, detail] = scopeDetails[scope];
        return `<li><strong>${heading}</strong><span>${detail}</span></li>`;
      }).join("");
      return page("Connect Zircon to ChatGPT", `<p class="signed-in">Signed in as <strong>${escapeHtml(user.github_login)}</strong></p><p>ChatGPT is requesting permission to:</p><ul class="scope-list">${scopes}</ul>
        <form method="post" action="/oauth/authorize/approve">
          <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
          <input type="hidden" name="csrf" value="${csrf(config, token)}">
          <div class="consent-actions"><button class="button-primary" name="decision" value="approve">Allow access</button>
          <button name="decision" value="deny">Deny</button></div>
        </form>`, [new URL(auth.redirect_uri).origin]);
    }

    if (path === "/oauth/authorize/approve" && request.method === "POST") {
      const form = await request.formData();
      const user = sessionUser(request);
      if (!user || !requireCsrf(request, form)) return json({ error: "Forbidden" }, 403);
      const requestId = form.get("request_id");
      const decision = form.get("decision") === "approve" ? "approve" : "deny";
      const code = createHmac("sha256", config.sessionSecret).update(`${requestId}:${user.id}`).digest("base64url");
      const auth = typeof requestId === "string" ? store.completeAuthRequest(requestId, user.id, decision, code) : null;
      if (!auth) return oauthError("invalid_request");
      const callback = new URL(auth.redirect_uri);
      callback.searchParams.set("state", auth.state);
      if (decision === "deny") callback.searchParams.set("error", "access_denied");
      else callback.searchParams.set("code", code);
      return redirect(callback.toString());
    }

    if (path === "/oauth/token" && request.method === "POST") {
      if (!store.allowRate("oauth-token", 120, 60_000)) return oauthError("slow_down", 429);
      const form = await request.formData();
      const client = authenticateClient(request, form, config, store);
      if (!client) return oauthError("invalid_client", 401);
      const resource = form.get("resource") ?? null;
      if (resource !== client.resource) return oauthError("invalid_target");
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = form.get("code");
        const redirectUri = form.get("redirect_uri");
        const verifier = form.get("code_verifier");
        const row = typeof code === "string" && typeof redirectUri === "string"
          ? store.consumeAuthCode(code, client.id, redirectUri, verifier) : null;
        if (!row || row.resource !== resource) return oauthError("invalid_grant");
        return json(store.issueTokens(row.user_id, row.client_id, row.scope, resource));
      }
      if (grant === "refresh_token") {
        const token = form.get("refresh_token");
        const result = typeof token === "string" ? store.rotateRefresh(token, client.id, resource) : null;
        return result ? json(result) : oauthError("invalid_grant");
      }
      return oauthError("unsupported_grant_type");
    }

    if (path === "/oauth/revoke" && request.method === "POST") {
      if (!store.allowRate("oauth-revoke", 120, 60_000)) return oauthError("slow_down", 429);
      const form = await request.formData();
      const client = authenticateClient(request, form, config, store);
      if (!client) return oauthError("invalid_client", 401);
      const token = form.get("token");
      if (typeof token === "string") store.revokeToken(token, client.id);
      return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
    }

    if (path === "/login" && request.method === "GET") {
      const requestId = url.searchParams.get("request_id") ?? "";
      if (!store.allowRate("github-login", 60, 60_000)) return json({ error: "Too many sign-in requests" }, 429);
      const state = store.createGithubState(store.authRequest(requestId) ? requestId : null);
      const github = new URL("https://github.com/login/oauth/authorize");
      github.searchParams.set("client_id", config.githubClientId);
      github.searchParams.set("redirect_uri", `${base}/login/github/callback`);
      github.searchParams.set("state", state);
      return redirect(github.toString(), { "Set-Cookie": `${GITHUB_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` });
    }
    if (path === "/login/github/callback" && request.method === "GET") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const login = state && code && equal(state, cookieValue(request, GITHUB_COOKIE)) ? store.consumeGithubState(state) : null;
      if (!login) return page("Sign-in expired", "<p>Start sign-in again.</p>");
      let identity;
      try { identity = await getGithubIdentity(config, code); }
      catch (error) { console.error("GitHub sign-in failed:", error.message); return page("Sign-in failed", "<p>Please try again.</p>"); }
      const user = store.githubUser(identity.id, identity.login);
      if (!user) return page("Invitation required", "<p>Ask the Zircon owner to invite your GitHub username.</p>");
      const session = store.createSession(user.id);
      if (user.online) void pool.forUser(user).catch(error => console.error("Could not start IRC client after sign-in:", error.message));
      const next = login.request_id ? `/oauth/authorize?request_id=${encodeURIComponent(login.request_id)}` : "/settings";
      const headers = new Headers();
      headers.append("Set-Cookie", `${SESSION_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800`);
      headers.append("Set-Cookie", `${GITHUB_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
      return redirect(next, headers);
    }

    if (path === "/settings" && request.method === "GET") {
      const user = sessionUser(request);
      if (!user) return redirect(`${base}/login`);
      const allowed = JSON.parse(user.allowed_channels);
      const selected = new Set(JSON.parse(user.selected_channels));
      const options = allowed.map(channel => `<label><input type="checkbox" name="channel" value="${escapeHtml(channel)}" ${selected.has(channel) ? "checked" : ""}>${escapeHtml(channel)}</label>`).join("<br>");
      const networks = config.ircNetworks.map(network => `<option value="${escapeHtml(network.name)}" ${network.name === user.network_name ? "selected" : ""}>${escapeHtml(network.name)} (${escapeHtml(network.host)})</option>`).join("");
      const diagnosticsLink = config.diagnosticsEnabled && config.diagnosticsAdminLogins?.includes(user.github_login)
        ? '<p><a href="/admin/events">View recent diagnostics</a></p>' : "";
      const subscriptions = store.listEventSubscriptions(user).map(subscription => `<li><strong>${escapeHtml(subscription.name)}</strong> ${escapeHtml(JSON.stringify(subscription.arguments))} to ${escapeHtml(new URL(subscription.url).origin)}${subscription.expiresAt ? ` until ${escapeHtml(subscription.expiresAt)}` : " (no expiry)"}
        <form method="post" action="/settings/subscriptions/revoke"><input type="hidden" name="csrf" value="${csrf(config, cookieValue(request))}"><input type="hidden" name="id" value="${escapeHtml(subscription.id)}"><button>Revoke</button></form></li>`).join("");
      return page("Zircon settings", `<p>GitHub: ${escapeHtml(user.github_login)}</p><p>IRC is ${user.online ? "online" : "offline"}. Staying online records new channel activity and delivers subscribed mention events. ChatGPT can use go_offline and go_online when you ask it to change your presence.</p>${diagnosticsLink}<form method="post" action="/settings">
        <input type="hidden" name="csrf" value="${csrf(config, cookieValue(request))}">
        <label>IRC network <select name="network_name">${networks}</select></label>
        <label>IRC nick <input name="nick" maxlength="31" value="${escapeHtml(user.nick)}" required></label>
        <label>IRC display name <input name="display_name" maxlength="32" value="${escapeHtml(user.display_name)}" required></label>
        <fieldset><legend>Channels enabled in ChatGPT</legend><p>New channels start off. Select a granted channel to join it and let ChatGPT read and post there.</p>${options}</fieldset><button>Save</button></form>
        <h2>Event subscriptions</h2><p>ChatGPT can receive new mentions while IRC is online. Revoking a subscription stops future deliveries.</p><ul>${subscriptions || "<li>No active subscriptions</li>"}</ul>`);
    }
    if (path === "/settings/subscriptions/revoke" && request.method === "POST") {
      const user = sessionUser(request);
      const form = await request.formData();
      if (!user || !requireCsrf(request, form)) return json({ error: "Forbidden" }, 403);
      const id = String(form.get("id") ?? "");
      if (!/^sub_[A-Za-z0-9_-]{32}$/.test(id) || !store.revokeEventSubscription(user, id)) {
        return json({ error: "Unknown subscription" }, 404);
      }
      return redirect(`${base}/settings`);
    }
    if (path === "/settings" && request.method === "POST") {
      const user = sessionUser(request);
      const form = await request.formData();
      if (!user || !requireCsrf(request, form)) return json({ error: "Forbidden" }, 403);
      const name = String(form.get("display_name") ?? "").trim();
      const networkName = String(form.get("network_name") ?? "");
      const nick = String(form.get("nick") ?? "");
      const channels = form.getAll("channel");
      const allowed = new Set(JSON.parse(user.allowed_channels));
      if (!/^[A-Za-z0-9 _.-]{1,32}$/.test(name) ||
          !/^[A-Za-z][A-Za-z0-9_\-\[\]\\`^{}|]{0,30}$/.test(nick) ||
          !config.ircNetworks.some(network => network.name === networkName) ||
          channels.some(channel => typeof channel !== "string" || !allowed.has(channel))) {
        return json({ error: "Invalid settings" }, 400);
      }
      const changed = store.updateSettings(user.id, name, [...new Set(channels)], networkName, nick);
      if (changed) {
        pool.drop(user.id);
        try { await pool.provisioner.ensure(store.userById(user.id)); } catch (error) {
          console.error("Could not apply IRC settings:", error.message);
          return page("IRC setup pending", "<p>Your settings were saved, but ZNC could not apply them. Please retry saving shortly.</p>");
        }
        if (user.online) void pool.forUser(store.userById(user.id)).catch(error => console.error("Could not reconnect IRC after settings change:", error.message));
      }
      return redirect(`${base}/settings`);
    }

    if (path === "/logout" && request.method === "POST") {
      const form = await request.formData();
      if (!requireCsrf(request, form)) return json({ error: "Forbidden" }, 403);
      store.revokeSession(cookieValue(request));
      return redirect(`${base}/login`, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
    }

    if (path === "/admin/invite" && request.method === "POST") {
      const header = request.headers.get("authorization") ?? "";
      if (!equal(header, `Bearer ${config.adminToken}`)) return json({ error: "Unauthorized" }, 401);
      if (!store.allowRate("admin-invite", 30, 3600_000)) return json({ error: "Too many requests" }, 429);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const login = typeof body.github_login === "string" ? body.github_login.trim().toLowerCase() : "";
      const channels = body.channels ?? config.ircChannels;
      if (!/^[a-z0-9-]{1,39}$/.test(login) || !Array.isArray(channels) || !channels.length ||
          channels.some(channel => !config.ircChannels.includes(channel))) return json({ error: "Invalid invite" }, 400);
      if (!store.userByLogin(login) && store.userCount() >= (config.maxUsers ?? 16)) return json({ error: "User limit reached" }, 409);
      const previous = store.userByLogin(login);
      const user = store.invite(login, [...new Set(channels)], config.ircNetworks[0].name);
      if (previous && previous.selected_channels !== user.selected_channels) {
        pool.drop(user.id);
        if (user.online) {
          try { await pool.forUser(user); }
          catch (error) {
            console.error("Could not apply updated channel grant:", error.message);
            return json({ error: "Invitation saved, but IRC setup is pending" }, 503);
          }
        }
      }
      return json({ github_login: user.github_login, allowed_channels: JSON.parse(user.allowed_channels) }, 201);
    }

    return null;
  };
}
