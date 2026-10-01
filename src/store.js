import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const randomToken = () => randomBytes(32).toString("base64url");
export const tokenHash = token => createHash("sha256").update(token).digest("hex");
const now = () => Date.now();

export class Store {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, github_login TEXT NOT NULL UNIQUE, github_id TEXT UNIQUE, display_name TEXT NOT NULL,
        allowed_channels TEXT NOT NULL, selected_channels TEXT NOT NULL,
        network_name TEXT NOT NULL, nick TEXT NOT NULL, znc_username TEXT NOT NULL UNIQUE,
        provisioned INTEGER NOT NULL DEFAULT 0, config_version INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_states (
        hash TEXT PRIMARY KEY, request_id TEXT, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        state TEXT NOT NULL, scope TEXT NOT NULL, code_challenge TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT NOT NULL,
        code_challenge TEXT, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, github_login TEXT NOT NULL,
        channel TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    this.db.run("DELETE FROM github_states WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM sessions WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM auth_requests WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM auth_codes WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM tokens WHERE expires_at < ?", [now()]);
  }

  close() { this.db.close(); }

  invite(login, allowedChannels, networkName) {
    const id = randomUUID();
    const display = login.slice(0, 32);
    const nick = (/^[A-Za-z]/.test(login) ? login : `u${login}`).slice(0, 31);
    const channels = JSON.stringify(allowedChannels);
    const zncUsername = `z${id.replaceAll("-", "").slice(0, 20)}`;
    this.db.query(`INSERT INTO users (id,github_login,display_name,allowed_channels,selected_channels,network_name,nick,znc_username,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(github_login) DO UPDATE SET
      allowed_channels=excluded.allowed_channels, selected_channels=excluded.selected_channels,
      provisioned=0, config_version=config_version+1, enabled=1`)
      .run(id, login, display, channels, channels, networkName, nick, zncUsername, now());
    return this.userByLogin(login);
  }

  userByLogin(login) { return this.db.query("SELECT * FROM users WHERE github_login = ? AND enabled = 1").get(login); }
  userById(id) { return this.db.query("SELECT * FROM users WHERE id = ? AND enabled = 1").get(id); }
  userCount() { return this.db.query("SELECT count(*) AS count FROM users WHERE enabled = 1").get().count; }

  githubUser(githubId, login) {
    const existing = this.db.query("SELECT * FROM users WHERE github_id = ? AND enabled = 1").get(String(githubId));
    if (existing) return existing;
    const invited = this.userByLogin(login.toLowerCase());
    if (!invited || invited.github_id) return null;
    this.db.query("UPDATE users SET github_id = ? WHERE id = ?").run(String(githubId), invited.id);
    return this.userById(invited.id);
  }

  updateSettings(userId, displayName, selectedChannels, networkName, nick) {
    const previous = this.userById(userId);
    const channels = JSON.stringify(selectedChannels);
    const changed = previous.selected_channels !== channels || previous.network_name !== networkName || previous.nick !== nick;
    this.db.query(`UPDATE users SET display_name = ?, selected_channels = ?, network_name = ?, nick = ?,
      provisioned = ?, config_version = config_version + ? WHERE id = ? AND enabled = 1`)
      .run(displayName, channels, networkName, nick, changed ? 0 : previous.provisioned, changed ? 1 : 0, userId);
    return changed;
  }

  markProvisioned(userId, version) { this.db.query("UPDATE users SET provisioned = 1 WHERE id = ? AND config_version = ?").run(userId, version); }

  createGithubState(requestId) {
    const state = randomToken();
    this.db.query("INSERT INTO github_states VALUES (?,?,?)").run(tokenHash(state), requestId ?? null, now() + 10 * 60_000);
    return state;
  }

  consumeGithubState(state) {
    return this.db.transaction(() => {
      const hash = tokenHash(state);
      const row = this.db.query("SELECT * FROM github_states WHERE hash = ? AND expires_at > ?").get(hash, now());
      if (!row) return null;
      this.db.query("DELETE FROM github_states WHERE hash = ?").run(hash);
      return row;
    })();
  }

  createSession(userId) {
    const token = randomToken();
    this.db.query("INSERT INTO sessions (hash,user_id,expires_at) VALUES (?,?,?)")
      .run(tokenHash(token), userId, now() + 7 * 86_400_000);
    return token;
  }

  sessionUser(token) {
    if (!token) return null;
    const row = this.db.query("SELECT user_id FROM sessions WHERE hash = ? AND expires_at > ?").get(tokenHash(token), now());
    return row ? this.userById(row.user_id) : null;
  }

  revokeSession(token) { if (token) this.db.query("DELETE FROM sessions WHERE hash = ?").run(tokenHash(token)); }

  createAuthRequest(details) {
    const id = randomToken();
    this.db.query("INSERT INTO auth_requests VALUES (?,?,?,?,?,?,?)")
      .run(id, details.clientId, details.redirectUri, details.state, details.scope, details.codeChallenge ?? null, now() + 10 * 60_000);
    return id;
  }

  authRequest(id) { return this.db.query("SELECT * FROM auth_requests WHERE id = ? AND expires_at > ?").get(id, now()); }
  deleteAuthRequest(id) { this.db.query("DELETE FROM auth_requests WHERE id = ?").run(id); }

  createAuthCode(userId, request) {
    const code = randomToken();
    this.db.query("INSERT INTO auth_codes VALUES (?,?,?,?,?,?,?,0)")
      .run(tokenHash(code), userId, request.client_id, request.redirect_uri, request.scope, request.code_challenge, now() + 5 * 60_000);
    return code;
  }

  consumeAuthCode(code, clientId, redirectUri, codeVerifier) {
    return this.db.transaction(() => {
      const hash = tokenHash(code);
      const row = this.db.query("SELECT * FROM auth_codes WHERE hash = ? AND used = 0 AND expires_at > ?").get(hash, now());
      if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || !this.userById(row.user_id)) return null;
      if (row.code_challenge) {
        if (!codeVerifier || createHash("sha256").update(codeVerifier).digest("base64url") !== row.code_challenge) return null;
      }
      this.db.query("UPDATE auth_codes SET used = 1 WHERE hash = ?").run(hash);
      return row;
    })();
  }

  issueTokens(userId, clientId, scope) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.db.transaction(() => {
      this.db.query("INSERT INTO tokens VALUES (?,?,?,?,?,?,0)")
        .run(tokenHash(accessToken), userId, "access", clientId, scope, now() + 3600_000);
      this.db.query("INSERT INTO tokens VALUES (?,?,?,?,?,?,0)")
        .run(tokenHash(refreshToken), userId, "refresh", clientId, scope, now() + 30 * 86_400_000);
    })();
    return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope };
  }

  rotateRefresh(token, clientId) {
    return this.db.transaction(() => {
      const hash = tokenHash(token);
      const row = this.db.query("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh' AND revoked = 0 AND expires_at > ?").get(hash, now());
      if (!row || row.client_id !== clientId || !this.userById(row.user_id)) return null;
      this.db.query("UPDATE tokens SET revoked = 1 WHERE hash = ?").run(hash);
      return this.issueTokens(row.user_id, row.client_id, row.scope);
    })();
  }

  revokeToken(token, clientId) {
    this.db.query("UPDATE tokens SET revoked = 1 WHERE hash = ? AND client_id = ?").run(tokenHash(token), clientId);
  }

  accessUser(token, requiredScope) {
    if (!token) return null;
    const row = this.db.query("SELECT * FROM tokens WHERE hash = ? AND kind = 'access' AND revoked = 0 AND expires_at > ?")
      .get(tokenHash(token), now());
    if (!row || !row.scope.split(" ").includes(requiredScope)) return null;
    return this.userById(row.user_id);
  }

  allowRate(key, limit, windowMs) {
    const timestamp = now();
    this.db.query(`INSERT INTO rate_limits (key,window_start,count) VALUES (?,?,1)
      ON CONFLICT(key) DO UPDATE SET
      window_start=CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END,
      count=CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END`)
      .run(key, timestamp, timestamp, windowMs, timestamp, timestamp, windowMs);
    const { count } = this.db.query("SELECT count FROM rate_limits WHERE key = ?").get(key);
    return count <= limit;
  }

  auditPost(user, channel, text) {
    this.db.query("INSERT INTO audit (user_id,github_login,channel,text,created_at) VALUES (?,?,?,?,?)")
      .run(user.id, user.github_login, channel, text, now());
    this.db.run("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 10000)");
  }
}
