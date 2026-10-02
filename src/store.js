import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const randomToken = () => randomBytes(32).toString("base64url");
export const tokenHash = token => createHash("sha256").update(token).digest("hex");
const now = () => Date.now();
const parsePageCursor = cursor => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" &&
      Number.isSafeInteger(value[1]) && value[1] > 0 ? value : false;
  } catch { return false; }
};
const pageCursor = row => Buffer.from(JSON.stringify([row.time, row.id])).toString("base64url");
const addressesNick = (message, nick) => {
  const text = message.toLowerCase();
  const target = nick.toLowerCase();
  for (let index = text.indexOf(target); index >= 0; index = text.indexOf(target, index + target.length)) {
    if ((index === 0 || !/[a-z0-9_]/.test(text[index - 1])) &&
        (index + target.length === text.length || !/[a-z0-9_]/.test(text[index + target.length]))) return true;
  }
  return false;
};

export class Store {
  constructor(path, { historyRetentionDays = 7, historyMaxPerChannel = 5000, diagnosticsEnabled = false } = {}) {
    this.path = path;
    this.historyRetentionDays = historyRetentionDays;
    this.historyMaxPerChannel = historyMaxPerChannel;
    this.diagnosticsEnabled = diagnosticsEnabled;
    this.onEventQueued = null;
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
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
        online INTEGER NOT NULL DEFAULT 1, buffer_policy INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS owner_bindings (
        login TEXT PRIMARY KEY, github_id TEXT NOT NULL, resolved_at INTEGER NOT NULL
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
        expires_at INTEGER NOT NULL, completed_by TEXT, decision TEXT
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
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL,
        auth_method TEXT NOT NULL DEFAULT 'none', secret_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
        entry_id TEXT UNIQUE, outgoing_message_id TEXT,
        network TEXT NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL,
        time TEXT NOT NULL, observed_at TEXT NOT NULL, timestamp_source TEXT NOT NULL,
        nick TEXT NOT NULL, text TEXT NOT NULL, target TEXT,
        fingerprint TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS activity_user_channel_time ON channel_activity(user_id,network,channel,time,id);
      CREATE INDEX IF NOT EXISTS activity_user_id ON channel_activity(user_id,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(text, content='channel_activity', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS activity_fts_insert AFTER INSERT ON channel_activity BEGIN
        INSERT INTO activity_fts(rowid,text) VALUES (new.id,new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS activity_fts_delete AFTER DELETE ON channel_activity BEGIN
        INSERT INTO activity_fts(activity_fts,rowid,text) VALUES ('delete',old.id,old.text);
      END;
      CREATE TABLE IF NOT EXISTS mention_cursors (
        user_id TEXT PRIMARY KEY REFERENCES users(id), last_id INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS unread_cursors (
        user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
        network TEXT NOT NULL, channel TEXT NOT NULL, last_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,client_id,network,channel)
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sessions_owner ON agent_sessions(user_id,client_id);
      CREATE TABLE IF NOT EXISTS unread_batches (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
        network TEXT NOT NULL, channel TEXT NOT NULL, last_id INTEGER NOT NULL,
        entries TEXT NOT NULL, has_more INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS unread_batches_pending ON unread_batches(user_id,client_id,network,channel,acknowledged);
      CREATE TABLE IF NOT EXISTS event_subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL,
        name TEXT NOT NULL, arguments TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
        previous_secret TEXT, rotate_until INTEGER,
        expires_at INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
        last_attempt_at INTEGER, last_delivery_status TEXT
      );
      CREATE INDEX IF NOT EXISTS event_subscriptions_user ON event_subscriptions(user_id,active);
      CREATE TABLE IF NOT EXISTS event_deliveries (
        event_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
        payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_deliveries_due ON event_deliveries(next_attempt_at);
      CREATE TABLE IF NOT EXISTS post_requests (
        user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL,
        channel TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, network TEXT, message_id TEXT,
        echoed_at INTEGER, activity_entry_id TEXT, failure_reason TEXT,
        PRIMARY KEY(user_id,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS capture_state (
        user_id TEXT PRIMARY KEY REFERENCES users(id), last_activity_at TEXT,
        last_message_at TEXT, last_disconnect_at TEXT, last_auth_at TEXT
      );
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
        user_id TEXT, category TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diagnostic_events_time ON diagnostic_events(occurred_at,id);
    `);
    for (const table of ["auth_requests", "auth_codes", "tokens"]) {
      if (!this.db.query(`PRAGMA table_info(${table})`).all().some(column => column.name === "resource")) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN resource TEXT`);
      }
    }
    const authColumns = this.db.query("PRAGMA table_info(auth_requests)").all().map(column => column.name);
    if (!authColumns.includes("completed_by")) this.db.run("ALTER TABLE auth_requests ADD COLUMN completed_by TEXT");
    if (!authColumns.includes("decision")) this.db.run("ALTER TABLE auth_requests ADD COLUMN decision TEXT");
    if (!this.db.query("PRAGMA table_info(users)").all().some(column => column.name === "online")) {
      this.db.run("ALTER TABLE users ADD COLUMN online INTEGER NOT NULL DEFAULT 1");
    }
    if (!this.db.query("PRAGMA table_info(users)").all().some(column => column.name === "buffer_policy")) {
      this.db.run("ALTER TABLE users ADD COLUMN buffer_policy INTEGER NOT NULL DEFAULT 0");
    }
    const clientColumns = this.db.query("PRAGMA table_info(oauth_clients)").all().map(column => column.name);
    if (!clientColumns.includes("auth_method")) this.db.run("ALTER TABLE oauth_clients ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'none'");
    if (!clientColumns.includes("secret_hash")) this.db.run("ALTER TABLE oauth_clients ADD COLUMN secret_hash TEXT");
    const activityColumns = this.db.query("PRAGMA table_info(channel_activity)").all().map(column => column.name);
    if (!activityColumns.includes("entry_id")) this.db.run("ALTER TABLE channel_activity ADD COLUMN entry_id TEXT");
    if (!activityColumns.includes("outgoing_message_id")) this.db.run("ALTER TABLE channel_activity ADD COLUMN outgoing_message_id TEXT");
    this.db.run("UPDATE channel_activity SET entry_id='entry_' || lower(hex(randomblob(16))) WHERE entry_id IS NULL");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS activity_entry_id ON channel_activity(entry_id)");
    const postColumns = this.db.query("PRAGMA table_info(post_requests)").all().map(column => column.name);
    for (const [name, type] of [["network", "TEXT"], ["message_id", "TEXT"], ["echoed_at", "INTEGER"],
      ["activity_entry_id", "TEXT"], ["failure_reason", "TEXT"]]) {
      if (!postColumns.includes(name)) this.db.run(`ALTER TABLE post_requests ADD COLUMN ${name} ${type}`);
    }
    for (const row of this.db.query("SELECT user_id,idempotency_key FROM post_requests WHERE message_id IS NULL").all()) {
      this.db.query("UPDATE post_requests SET message_id=? WHERE user_id=? AND idempotency_key=?")
        .run(this.outgoingMessageId({ id: row.user_id }, row.idempotency_key), row.user_id, row.idempotency_key);
    }
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS post_requests_message_id ON post_requests(user_id,message_id)");
    this.db.run(`UPDATE post_requests SET network=(SELECT network_name FROM users WHERE users.id=post_requests.user_id) WHERE network IS NULL`);
    const subscriptionColumns = this.db.query("PRAGMA table_info(event_subscriptions)").all().map(column => column.name);
    if (!subscriptionColumns.includes("previous_secret")) this.db.run("ALTER TABLE event_subscriptions ADD COLUMN previous_secret TEXT");
    if (!subscriptionColumns.includes("rotate_until")) this.db.run("ALTER TABLE event_subscriptions ADD COLUMN rotate_until INTEGER");
    if (!subscriptionColumns.includes("last_attempt_at")) this.db.run("ALTER TABLE event_subscriptions ADD COLUMN last_attempt_at INTEGER");
    if (!subscriptionColumns.includes("last_delivery_status")) this.db.run("ALTER TABLE event_subscriptions ADD COLUMN last_delivery_status TEXT");
    for (const batch of this.db.query("SELECT id,user_id,network,channel,entries FROM unread_batches").all()) {
      const entries = JSON.parse(batch.entries);
      if (entries.every(entry => entry.entryId)) continue;
      for (const entry of entries) {
        if (entry.entryId) continue;
        const row = this.db.query(`SELECT entry_id,outgoing_message_id FROM channel_activity
          WHERE user_id=? AND network=? AND channel=? AND kind=? AND time=? AND nick=? AND text=?
          AND target IS ? LIMIT 1`).get(batch.user_id, batch.network, batch.channel,
            entry.kind, entry.time, entry.nick, entry.text, entry.target);
        entry.entryId = row?.entry_id ?? `entry_${randomBytes(16).toString("hex")}`;
        entry.messageId = row?.outgoing_message_id ?? null;
      }
      this.db.query("UPDATE unread_batches SET entries=? WHERE id=?").run(JSON.stringify(entries), batch.id);
    }
    this.db.run("DELETE FROM github_states WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM sessions WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM auth_requests WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM auth_codes WHERE expires_at < ?", [now()]);
    this.db.run("DELETE FROM tokens WHERE expires_at < ?", [now()]);
  }

  close() { this.db.close(); }

  backup() {
    if (this.path === ":memory:") throw new Error("In-memory database cannot be backed up");
    const directory = join(dirname(this.path), "backup");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, "zircon.sqlite");
    const temporary = join(directory, `zircon-${randomUUID()}.tmp`);
    try {
      this.db.query("VACUUM INTO ?").run(temporary);
      const copy = new Database(temporary, { readonly: true });
      try {
        if (copy.query("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("SQLite backup failed integrity check");
      } finally { copy.close(); }
      renameSync(temporary, destination);
      return destination;
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* backup may have failed before creating it */ }
      throw error;
    }
  }

  invite(login, allowedChannels, networkName) {
    const id = randomUUID();
    const display = login.slice(0, 32);
    const nick = (/^[A-Za-z]/.test(login) ? login : `u${login}`).slice(0, 31);
    const channels = JSON.stringify(allowedChannels);
    const existing = this.userByLogin(login);
    const selected = JSON.stringify(existing
      ? JSON.parse(existing.selected_channels).filter(channel => allowedChannels.includes(channel)) : []);
    const zncUsername = `z${id.replaceAll("-", "").slice(0, 20)}`;
    this.db.query(`INSERT INTO users (id,github_login,display_name,allowed_channels,selected_channels,network_name,nick,znc_username,created_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(github_login) DO UPDATE SET
      allowed_channels=excluded.allowed_channels, selected_channels=excluded.selected_channels,
      provisioned=CASE WHEN users.selected_channels != excluded.selected_channels THEN 0 ELSE users.provisioned END,
      config_version=users.config_version+(users.selected_channels != excluded.selected_channels), enabled=1`)
      .run(id, login, display, channels, selected, networkName, nick, zncUsername, now());
    return this.userByLogin(login);
  }

  userByLogin(login) { return this.db.query("SELECT * FROM users WHERE github_login = ? AND enabled = 1").get(login); }
  userById(id) { return this.db.query("SELECT * FROM users WHERE id = ? AND enabled = 1").get(id); }
  activeUsers() { return this.db.query("SELECT * FROM users WHERE enabled = 1 AND github_id IS NOT NULL AND online = 1 ORDER BY created_at").all(); }
  setOnline(userId, online) { this.db.query("UPDATE users SET online = ? WHERE id = ? AND enabled = 1").run(online ? 1 : 0, userId); }
  userCount() { return this.db.query("SELECT count(*) AS count FROM users WHERE enabled = 1").get().count; }
  ownerGithubId(login) {
    return this.db.query("SELECT github_id AS githubId FROM owner_bindings WHERE login=?").get(login)?.githubId ?? null;
  }
  pinOwner(login, githubId) {
    this.db.query("INSERT OR IGNORE INTO owner_bindings(login,github_id,resolved_at) VALUES (?,?,?)")
      .run(login, String(githubId), now());
    return this.ownerGithubId(login);
  }
  listUsers() {
    return this.db.query(`SELECT github_login AS githubLogin,github_id AS githubId,
      allowed_channels AS allowedChannels,selected_channels AS selectedChannels,
      network_name AS network,nick,online FROM users WHERE enabled=1 ORDER BY github_login`).all()
      .map(row => ({ ...row, allowedChannels: JSON.parse(row.allowedChannels),
        selectedChannels: JSON.parse(row.selectedChannels) }));
  }

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

  markProvisioned(userId, version) { this.db.query("UPDATE users SET provisioned = 1, buffer_policy = 1 WHERE id = ? AND config_version = ?").run(userId, version); }
  markBufferPolicy(userId) { this.db.query("UPDATE users SET buffer_policy = 1 WHERE id = ?").run(userId); }

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

  registerClient(redirectUris, authMethod) {
    const id = randomToken();
    const secret = authMethod === "none" ? null : randomToken();
    this.db.query("INSERT INTO oauth_clients (id,redirect_uris,created_at,auth_method,secret_hash) VALUES (?,?,?,?,?)")
      .run(id, JSON.stringify(redirectUris), now(), authMethod, secret ? tokenHash(secret) : null);
    return { id, secret };
  }

  oauthClient(id) {
    if (!id) return null;
    const row = this.db.query("SELECT redirect_uris,auth_method,secret_hash FROM oauth_clients WHERE id = ?").get(id);
    return row ? { redirectUris: JSON.parse(row.redirect_uris), authMethod: row.auth_method, secretHash: row.secret_hash } : null;
  }

  createAuthRequest(details) {
    const id = randomToken();
    this.db.query("INSERT INTO auth_requests (id,client_id,redirect_uri,state,scope,code_challenge,expires_at,resource) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, details.clientId, details.redirectUri, details.state, details.scope, details.codeChallenge ?? null, now() + 10 * 60_000, details.resource ?? null);
    return id;
  }

  authRequest(id) { return this.db.query("SELECT * FROM auth_requests WHERE id = ? AND expires_at > ?").get(id, now()); }
  deleteAuthRequest(id) { this.db.query("DELETE FROM auth_requests WHERE id = ?").run(id); }

  completeAuthRequest(id, userId, decision, code) {
    return this.db.transaction(() => {
      const row = this.authRequest(id);
      if (!row || (row.completed_by && (row.completed_by !== userId || row.decision !== decision))) return null;
      if (!row.completed_by) {
        this.db.query("UPDATE auth_requests SET completed_by = ?, decision = ?, expires_at = ? WHERE id = ?")
          .run(userId, decision, now() + 5 * 60_000, id);
        if (decision === "approve") this.createAuthCode(userId, row, code);
      }
      return row;
    })();
  }

  createAuthCode(userId, request, code = randomToken()) {
    this.db.query("INSERT INTO auth_codes (hash,user_id,client_id,redirect_uri,scope,code_challenge,expires_at,used,resource) VALUES (?,?,?,?,?,?,?,0,?)")
      .run(tokenHash(code), userId, request.client_id, request.redirect_uri, request.scope, request.code_challenge, now() + 5 * 60_000, request.resource);
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

  issueTokens(userId, clientId, scope, resource = null) {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.db.transaction(() => {
      this.db.query("INSERT INTO tokens (hash,user_id,kind,client_id,scope,expires_at,revoked,resource) VALUES (?,?,?,?,?,?,0,?)")
        .run(tokenHash(accessToken), userId, "access", clientId, scope, now() + 3600_000, resource);
      this.db.query("INSERT INTO tokens (hash,user_id,kind,client_id,scope,expires_at,revoked,resource) VALUES (?,?,?,?,?,?,0,?)")
        .run(tokenHash(refreshToken), userId, "refresh", clientId, scope, now() + 30 * 86_400_000, resource);
    })();
    return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope };
  }

  rotateRefresh(token, clientId, resource = null) {
    return this.db.transaction(() => {
      const hash = tokenHash(token);
      const row = this.db.query("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh' AND revoked = 0 AND expires_at > ?").get(hash, now());
      if (!row || row.client_id !== clientId || row.resource !== resource || !this.userById(row.user_id)) return null;
      this.db.query("UPDATE tokens SET revoked = 1 WHERE hash = ?").run(hash);
      return this.issueTokens(row.user_id, row.client_id, row.scope, row.resource);
    })();
  }

  revokeToken(token, clientId) {
    this.db.query("UPDATE tokens SET revoked = 1 WHERE hash = ? AND client_id = ?").run(tokenHash(token), clientId);
  }

  accessPrincipal(token, requiredScope, resource = null) {
    if (!token) return null;
    const row = this.db.query("SELECT * FROM tokens WHERE hash = ? AND kind = 'access' AND revoked = 0 AND expires_at > ?")
      .get(tokenHash(token), now());
    if (!row || row.resource !== resource || !row.scope.split(" ").includes(requiredScope)) return null;
    const user = this.userById(row.user_id);
    return user ? { user, clientId: row.client_id } : null;
  }

  accessUser(token, requiredScope, resource = null) {
    return this.accessPrincipal(token, requiredScope, resource)?.user ?? null;
  }

  hasEventAccess(userId, clientId) {
    return Boolean(this.db.query(`SELECT 1 FROM tokens WHERE user_id=? AND client_id=? AND resource IS NOT NULL AND revoked=0
      AND expires_at>? AND (' ' || scope || ' ') LIKE '% irc:read %' LIMIT 1`).get(userId, clientId, now()));
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

  outgoingMessageId(user, key) {
    return `msg_${createHash("sha256").update(`${user.id}:${key}`).digest("base64url").slice(0, 24)}`;
  }

  reservePost(user, key, channel, message) {
    return this.db.transaction(() => {
      const existing = this.db.query("SELECT network,channel,text,status FROM post_requests WHERE user_id = ? AND idempotency_key = ?")
        .get(user.id, key);
      if (existing) {
        if (existing.network !== user.network_name || existing.channel !== channel || existing.text !== message) return "conflict";
        if (existing.status === "failed") {
          this.db.query("UPDATE post_requests SET status='pending',failure_reason=NULL,created_at=? WHERE user_id=? AND idempotency_key=?")
            .run(now(), user.id, key);
          return "new";
        }
        return existing.status;
      }
      this.db.query(`INSERT INTO post_requests
        (user_id,idempotency_key,channel,text,status,created_at,network,message_id)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(user.id, key, channel, message, "pending", now(), user.network_name, this.outgoingMessageId(user, key));
      return "new";
    })();
  }

  completePost(user, key) {
    this.db.query("UPDATE post_requests SET status = 'queued' WHERE user_id = ? AND idempotency_key = ? AND status='pending'")
      .run(user.id, key);
  }

  failPost(user, key, reason) {
    this.db.query("UPDATE post_requests SET status='failed',failure_reason=? WHERE user_id=? AND idempotency_key=? AND status='pending'")
      .run(reason, user.id, key);
  }

  postStatus(user, messageId) {
    const post = this.db.query(`SELECT message_id AS messageId,network,channel,status,created_at AS createdAt,
      echoed_at AS echoedAt,activity_entry_id AS entryId,failure_reason AS failureReason
      FROM post_requests WHERE user_id=? AND message_id=?`).get(user.id, messageId);
    return post ? { ...post, createdAt: new Date(post.createdAt).toISOString(),
      echoedAt: post.echoedAt === null ? null : new Date(post.echoedAt).toISOString() } : null;
  }

  recordActivity(user, event) {
    const identity = [
      user.id, user.network_name, event.channel.toLowerCase(), event.kind, event.time,
      event.nick.toLowerCase(), event.text, event.target ?? null,
    ];
    if (event.outgoingMessageId) identity.push(event.outgoingMessageId);
    const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    let entryId = null;
    this.db.transaction(() => {
      let post = null;
      if (event.kind === "message" && event.timestampSource !== "local" &&
          event.nick.toLowerCase() === user.nick.toLowerCase()) {
        const eventTime = Date.parse(event.time);
        post = this.db.query(`SELECT idempotency_key,message_id,activity_entry_id FROM post_requests
          WHERE user_id=? AND network=? AND lower(channel)=? AND text=? AND status='queued'
          AND created_at BETWEEN ? AND ? ORDER BY created_at LIMIT 1`)
          .get(user.id, user.network_name, event.channel.toLowerCase(), event.text,
            eventTime - 120_000, eventTime + 120_000);
        if (post?.activity_entry_id) {
          const reconciled = this.db.query(`UPDATE OR IGNORE channel_activity SET time=?,observed_at=?,
            timestamp_source=?,nick=?,fingerprint=? WHERE entry_id=? AND user_id=? AND timestamp_source='local'`)
            .run(event.time, event.observedAt, event.timestampSource, event.nick, fingerprint,
              post.activity_entry_id, user.id);
          if (reconciled.changes) {
            entryId = post.activity_entry_id;
            this.db.query(`UPDATE post_requests SET status='echoed',echoed_at=?
              WHERE user_id=? AND idempotency_key=?`).run(Date.parse(event.observedAt), user.id, post.idempotency_key);
            this.updateCaptureState(user, event);
            return;
          }
        }
      }
      const proposedId = `entry_${randomBytes(16).toString("hex")}`;
      const inserted = this.db.query(`INSERT OR IGNORE INTO channel_activity
        (entry_id,outgoing_message_id,user_id,network,channel,kind,time,observed_at,timestamp_source,nick,text,target,fingerprint)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(proposedId, event.outgoingMessageId ?? null, user.id, user.network_name,
          event.channel.toLowerCase(), event.kind, event.time,
          event.observedAt, event.timestampSource, event.nick, event.text, event.target ?? null, fingerprint);
      entryId = inserted.changes ? proposedId : this.db.query("SELECT entry_id FROM channel_activity WHERE fingerprint=?").get(fingerprint)?.entry_id ?? null;
      if (!inserted.changes) return;
      if (event.timestampSource !== "local") this.updateCaptureState(user, event);
      if (post) {
        this.db.query(`UPDATE post_requests SET status='echoed',echoed_at=?,activity_entry_id=?
          WHERE user_id=? AND idempotency_key=?`).run(Date.parse(event.observedAt), entryId, user.id, post.idempotency_key);
        this.db.query("UPDATE channel_activity SET outgoing_message_id=? WHERE entry_id=?").run(post.message_id, entryId);
      }
      this.enqueueMentionEvents(user, event, entryId);
    })();
    this.historyRecorded = (this.historyRecorded ?? 0) + 1;
    if (this.historyRecorded % 100 === 0) this.pruneActivity();
    return entryId;
  }

  updateCaptureState(user, event) {
    this.db.query(`INSERT INTO capture_state(user_id,last_activity_at,last_message_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET last_activity_at=excluded.last_activity_at,
      last_message_at=CASE WHEN ? IN ('message','action') THEN excluded.last_message_at ELSE capture_state.last_message_at END`)
      .run(user.id, event.observedAt, ["message", "action"].includes(event.kind) ? event.observedAt : null, event.kind);
  }

  recordOutgoing(user, key, channel, message) {
    const stamp = new Date().toISOString();
    const messageId = this.outgoingMessageId(user, key);
    const entryId = this.recordActivity(user, { channel, kind: "message", time: stamp,
      observedAt: stamp, timestampSource: "local", nick: user.nick, text: message,
      outgoingMessageId: messageId });
    this.db.query("UPDATE post_requests SET activity_entry_id=? WHERE user_id=? AND idempotency_key=?")
      .run(entryId, user.id, key);
    return entryId;
  }

  recordConnectionState(user, state) {
    const stamp = new Date().toISOString();
    if (state === "znc_disconnected" || state === "go_offline") {
      this.db.query(`INSERT INTO capture_state(user_id,last_disconnect_at) VALUES (?,?)
        ON CONFLICT(user_id) DO UPDATE SET last_disconnect_at=excluded.last_disconnect_at`).run(user.id, stamp);
    } else if (state === "znc_authenticated") {
      this.db.query(`INSERT INTO capture_state(user_id,last_auth_at) VALUES (?,?)
        ON CONFLICT(user_id) DO UPDATE SET last_auth_at=excluded.last_auth_at`).run(user.id, stamp);
    }
    this.recordDiagnostic(user, "irc", state);
  }

  captureStatus(user) {
    const state = this.db.query("SELECT last_activity_at AS lastActivityAt,last_message_at AS lastMessageAt,last_disconnect_at AS lastDisconnectAt,last_auth_at AS lastAuthenticatedAt FROM capture_state WHERE user_id=?")
      .get(user.id) ?? { lastActivityAt: null, lastMessageAt: null, lastDisconnectAt: null, lastAuthenticatedAt: null };
    const subscriptions = this.db.query(`SELECT count(*) AS count,max(last_attempt_at) AS lastAttemptAt
      FROM event_subscriptions WHERE user_id=? AND active=1 AND (expires_at IS NULL OR expires_at>?)`)
      .get(user.id, now());
    const lastDelivery = this.db.query(`SELECT last_delivery_status AS status FROM event_subscriptions
      WHERE user_id=? AND last_attempt_at IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 1`).get(user.id);
    const pending = this.db.query(`SELECT count(*) AS count FROM event_deliveries d
      JOIN event_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=?`).get(user.id).count;
    const channels = JSON.parse(user.selected_channels).map(channel => channel.toLowerCase());
    const lastReceived = channels.length ? this.db.query(`SELECT entry_id AS entryId,kind,channel,
      observed_at AS observedAt FROM channel_activity WHERE user_id=? AND network=?
      AND channel IN (${channels.map(() => "?").join(",")}) AND timestamp_source!='local'
      ORDER BY observed_at DESC,id DESC LIMIT 1`).get(user.id, user.network_name, ...channels) : null;
    return { ...state, activeSubscriptions: subscriptions.count, pendingDeliveries: pending,
      lastReceived,
      lastEventAttemptAt: subscriptions.lastAttemptAt === null ? null : new Date(subscriptions.lastAttemptAt).toISOString(),
      lastEventDeliveryStatus: lastDelivery?.status ?? null,
      captureGapPossibleSince: state.lastDisconnectAt };
  }

  clientEventStatus(user, clientId) {
    const summary = this.db.query(`SELECT count(*) AS count,max(last_attempt_at) AS lastAttemptAt
      FROM event_subscriptions WHERE user_id=? AND client_id=? AND active=1 AND (expires_at IS NULL OR expires_at>?)`)
      .get(user.id, clientId, now());
    const enabledChannels = new Set(JSON.parse(user.selected_channels).map(channel => channel.toLowerCase()));
    const subscriptions = this.db.query(`SELECT arguments,expires_at AS expiresAt FROM event_subscriptions
      WHERE user_id=? AND client_id=? AND name='message.mention' AND active=1
      AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC`)
      .all(user.id, clientId, now()).map(row => {
        const filters = JSON.parse(row.arguments);
        return { filters, paused: enabledChannels.size === 0 ||
          (filters.network !== undefined && filters.network !== user.network_name) ||
          (filters.channel !== undefined && !enabledChannels.has(filters.channel.toLowerCase())),
        expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString() };
      });
    const lastDelivery = this.db.query(`SELECT last_delivery_status AS status FROM event_subscriptions
      WHERE user_id=? AND client_id=? AND active=1 AND last_attempt_at IS NOT NULL
      ORDER BY last_attempt_at DESC LIMIT 1`).get(user.id, clientId);
    const pending = this.db.query(`SELECT count(*) AS count FROM event_deliveries d
      JOIN event_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=? AND s.client_id=?`)
      .get(user.id, clientId).count;
    return { eventSubscriptionCount: summary.count, subscriptions, pendingDeliveries: pending,
      lastEventAttemptAt: summary.lastAttemptAt === null ? null : new Date(summary.lastAttemptAt).toISOString(),
      lastEventDeliveryStatus: lastDelivery?.status ?? null };
  }

  eventSubscriptionId(user, clientId, name, args, url) {
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
    return `sub_${createHash("sha256").update(JSON.stringify([user.id, clientId, name, canonical, url])).digest("base64url").slice(0, 32)}`;
  }

  saveEventSubscription(user, clientId, name, args, url, secret, expiresAt) {
    const id = this.eventSubscriptionId(user, clientId, name, args, url);
    this.db.query(`INSERT INTO event_subscriptions(id,user_id,client_id,name,arguments,url,secret,expires_at,active,created_at)
      VALUES (?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET
      previous_secret=CASE WHEN secret!=excluded.secret THEN secret ELSE previous_secret END,
      rotate_until=CASE WHEN secret!=excluded.secret THEN excluded.created_at+300000 ELSE rotate_until END,
      secret=excluded.secret,expires_at=excluded.expires_at,active=1`)
      .run(id, user.id, clientId, name, JSON.stringify(args), url, secret, expiresAt, now());
    this.recordDiagnostic(user, "event", "subscribe", id);
    return id;
  }

  removeEventSubscription(user, clientId, name, args, url) {
    const id = this.eventSubscriptionId(user, clientId, name, args, url);
    this.db.query(`DELETE FROM event_deliveries WHERE subscription_id IN
      (SELECT id FROM event_subscriptions WHERE id=? AND user_id=? AND client_id=?)`).run(id, user.id, clientId);
    this.db.query("DELETE FROM event_subscriptions WHERE id=? AND user_id=? AND client_id=?").run(id, user.id, clientId);
    this.recordDiagnostic(user, "event", "unsubscribe", id);
  }

  revokeEventSubscription(user, id) {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT id FROM event_subscriptions WHERE id=? AND user_id=?").get(id, user.id);
      if (!row) return false;
      this.db.query("DELETE FROM event_deliveries WHERE subscription_id=?").run(id);
      this.db.query("DELETE FROM event_subscriptions WHERE id=?").run(id);
      this.recordDiagnostic(user, "event", "revoke", id);
      return true;
    })();
  }

  listEventSubscriptions(user) {
    return this.db.query(`SELECT id,name,arguments,url,expires_at AS expiresAt FROM event_subscriptions
      WHERE user_id=? AND active=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC`)
      .all(user.id, now()).map(row => ({ ...row, arguments: JSON.parse(row.arguments),
        expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString() }));
  }

  enqueueMentionEvents(user, event, entryId) {
    if (!["message", "action"].includes(event.kind) || event.nick.toLowerCase() === user.nick.toLowerCase() ||
        event.timestampSource === "local") return;
    if (!addressesNick(event.text, user.nick)) return;
    const text = event.text.toLowerCase();
    const selected = JSON.parse(user.selected_channels).map(channel => channel.toLowerCase());
    if (!selected.includes(event.channel.toLowerCase())) return;
    const subscriptions = this.db.query(`SELECT * FROM event_subscriptions WHERE user_id=? AND name='message.mention'
      AND active=1 AND (expires_at IS NULL OR expires_at>?)`).all(user.id, now());
    for (const subscription of subscriptions) {
      const filter = JSON.parse(subscription.arguments);
      if (filter.network && filter.network !== user.network_name) continue;
      if (filter.channel && filter.channel.toLowerCase() !== event.channel.toLowerCase()) continue;
      if (filter.sender && filter.sender.toLowerCase() !== event.nick.toLowerCase()) continue;
      if (filter.keyword && !text.includes(filter.keyword.toLowerCase())) continue;
      if (!this.allowRate(`event:${subscription.id}`, 12, 60_000)) {
        this.recordDiagnostic(user, "event", "rate_limited", subscription.id);
        continue;
      }
      const queued = this.db.query("SELECT count(*) AS count FROM event_deliveries").get().count;
      if (queued >= 1000) { this.recordDiagnostic(user, "event", "queue_full", subscription.id); continue; }
      const payload = JSON.stringify({ eventId: `evt_${randomToken()}`, name: "message.mention",
        timestamp: event.time, data: { network: user.network_name, channel: event.channel,
          sender: event.nick, text: event.text, kind: event.kind, observedAt: event.observedAt,
          entryId }, cursor: null });
      if (Buffer.byteLength(payload) > 256 * 1024) continue;
      const eventId = JSON.parse(payload).eventId;
      this.db.query(`INSERT INTO event_deliveries(event_id,subscription_id,payload,next_attempt_at,created_at)
        VALUES (?,?,?,?,?)`).run(eventId, subscription.id, payload, now(), now());
      this.recordDiagnostic(user, "event", "queued", eventId);
      this.onEventQueued?.();
    }
  }

  nextEventDelivery() {
    return this.db.query(`SELECT d.*,s.url,s.secret,s.previous_secret,s.rotate_until,s.user_id,s.client_id,s.name,s.arguments,s.expires_at
      FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
      WHERE d.next_attempt_at<=? ORDER BY d.next_attempt_at,d.created_at LIMIT 1`).get(now());
  }

  recordEventAttempt(subscriptionId, status) {
    this.db.query("UPDATE event_subscriptions SET last_attempt_at=?,last_delivery_status=? WHERE id=?")
      .run(now(), status, subscriptionId);
  }

  finishEventDelivery(eventId, status) {
    if (status === "retry") {
      const row = this.db.query("SELECT attempts FROM event_deliveries WHERE event_id=?").get(eventId);
      if (row && row.attempts < 5) {
        const delay = Math.min(300_000, 2000 * 2 ** row.attempts);
        this.db.query("UPDATE event_deliveries SET attempts=attempts+1,next_attempt_at=? WHERE event_id=?")
          .run(now() + delay, eventId);
        return;
      }
    }
    this.db.query("DELETE FROM event_deliveries WHERE event_id=?").run(eventId);
  }

  recordDiagnostic(user, category, action, result = "") {
    if (!this.diagnosticsEnabled) return;
    this.db.query("INSERT INTO diagnostic_events(occurred_at,user_id,category,action,result) VALUES (?,?,?,?,?)")
      .run(now(), user?.id ?? null, String(category).slice(0, 32), String(action).slice(0, 100), String(result).slice(0, 64));
    this.db.run("DELETE FROM diagnostic_events WHERE id NOT IN (SELECT id FROM diagnostic_events ORDER BY id DESC LIMIT 2000)");
  }

  adminEvents(since = null, limit = 50) {
    const sinceTime = since ?? "1970-01-01T00:00:00.000Z";
    const diagnostics = this.db.query(`SELECT d.occurred_at,d.category,d.action,d.result,u.github_login AS user
      FROM diagnostic_events d LEFT JOIN users u ON u.id=d.user_id
      WHERE d.occurred_at >= ? ORDER BY d.occurred_at DESC,d.id DESC LIMIT ?`).all(Date.parse(sinceTime), limit)
      .map(row => ({ source: "diagnostic", time: new Date(row.occurred_at).toISOString(), user: row.user,
        category: row.category, action: row.action, result: row.result }));
    const activity = this.db.query(`SELECT a.entry_id AS entryId,a.outgoing_message_id AS messageId,
      a.time,a.observed_at AS observedAt,a.timestamp_source AS timestampSource,
      a.network,a.channel,a.kind,a.nick,a.text,u.github_login AS user
      FROM channel_activity a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.observed_at >= ? ORDER BY a.observed_at DESC,a.id DESC LIMIT ?`).all(sinceTime, limit)
      .map(row => ({ source: "irc", ...row }));
    return [...diagnostics, ...activity].sort((a, b) =>
      (b.observedAt ?? b.time).localeCompare(a.observedAt ?? a.time)).slice(0, limit);
  }

  recentActivity(user, channel, limit = 50) {
    return this.db.query(`SELECT id,entry_id AS entryId,outgoing_message_id AS messageId,
      network,channel,kind,time,observed_at AS observedAt,
      timestamp_source AS timestampSource,nick,text,target FROM channel_activity
      WHERE user_id = ? AND network = ? AND channel = ? ORDER BY time DESC,id DESC LIMIT ?`)
      .all(user.id, user.network_name, channel.toLowerCase(), limit).reverse();
  }

  unreadCount(user, clientId, channel) {
    const cursor = this.db.query(`SELECT last_id FROM unread_cursors WHERE user_id=? AND client_id=? AND network=? AND channel=?`)
      .get(user.id, clientId, user.network_name, channel.toLowerCase())?.last_id ?? 0;
    return this.db.query(`SELECT count(*) AS count FROM channel_activity WHERE user_id=? AND network=? AND channel=? AND id>?`)
      .get(user.id, user.network_name, channel.toLowerCase(), cursor).count;
  }

  startAgentSession(user, clientId, existingId = null) {
    if (existingId) {
      const session = this.db.query(`SELECT id,created_at AS createdAt FROM agent_sessions
        WHERE id=? AND user_id=? AND client_id=?`).get(existingId, user.id, clientId);
      if (!session) return null;
      this.db.query("UPDATE agent_sessions SET last_used_at=? WHERE id=?").run(now(), existingId);
      return { sessionId: session.id, sessionCreatedAt: new Date(session.createdAt).toISOString() };
    }
    const count = this.db.query("SELECT count(*) AS count FROM agent_sessions WHERE user_id=? AND client_id=?")
      .get(user.id, clientId).count;
    if (count >= 32) throw new RangeError("Agent session limit reached");
    const sessionId = `agent_${randomToken()}`;
    const stamp = now();
    this.db.query("INSERT INTO agent_sessions(id,user_id,client_id,created_at,last_used_at) VALUES (?,?,?,?,?)")
      .run(sessionId, user.id, clientId, stamp, stamp);
    return { sessionId, sessionCreatedAt: new Date(stamp).toISOString() };
  }

  hasAgentSession(user, clientId, sessionId) {
    const found = Boolean(this.db.query("SELECT 1 FROM agent_sessions WHERE id=? AND user_id=? AND client_id=?")
      .get(sessionId, user.id, clientId));
    if (found) this.db.query("UPDATE agent_sessions SET last_used_at=? WHERE id=?").run(now(), sessionId);
    return found;
  }

  mailboxStatus(user, clientId) {
    return JSON.parse(user.selected_channels).map(channel => {
      const normalized = channel.toLowerCase();
      const cursor = this.db.query(`SELECT last_id FROM unread_cursors
        WHERE user_id=? AND client_id=? AND network=? AND channel=?`)
        .get(user.id, clientId, user.network_name, normalized)?.last_id ?? 0;
      const lastAcknowledged = cursor ? this.db.query(`SELECT entry_id AS entryId,kind,time,observed_at AS observedAt
        FROM channel_activity WHERE id=? AND user_id=?`).get(cursor, user.id) ?? null : null;
      const pending = this.db.query(`SELECT id FROM unread_batches WHERE user_id=? AND client_id=?
        AND network=? AND channel=? AND acknowledged=0 ORDER BY created_at,id LIMIT 1`)
        .get(user.id, clientId, user.network_name, normalized);
      return { channel, unreadCount: this.unreadCount(user, clientId, channel),
        lastAcknowledged, pendingBatchId: pending?.id ?? null };
    });
  }

  readUnread(user, clientId, channel, limit = 50) {
    return this.db.transaction(() => {
      const network = user.network_name;
      const normalized = channel.toLowerCase();
      const pending = this.db.query(`SELECT id,entries,has_more FROM unread_batches
        WHERE user_id=? AND client_id=? AND network=? AND channel=? AND acknowledged=0
        ORDER BY created_at,id LIMIT 1`).get(user.id, clientId, network, normalized);
      if (pending) return { batchId: pending.id, entries: JSON.parse(pending.entries), hasMore: Boolean(pending.has_more) };
      const cursor = this.db.query(`SELECT last_id FROM unread_cursors WHERE user_id=? AND client_id=? AND network=? AND channel=?`)
        .get(user.id, clientId, network, normalized)?.last_id ?? 0;
      const rows = this.db.query(`SELECT id,entry_id AS entryId,outgoing_message_id AS messageId,
        network,channel,kind,time,observed_at AS observedAt,
        timestamp_source AS timestampSource,nick,text,target FROM channel_activity
        WHERE user_id=? AND network=? AND channel=? AND id>? ORDER BY id LIMIT ?`)
        .all(user.id, network, normalized, cursor, limit);
      if (!rows.length) return { batchId: null, entries: [], hasMore: false };
      const entries = rows.map(({ id, ...entry }) => ({ ...entry,
        mention: ["message", "action"].includes(entry.kind) &&
          entry.nick.toLowerCase() !== user.nick.toLowerCase() &&
          addressesNick(entry.text, user.nick) }));
      const lastId = rows.at(-1).id;
      const hasMore = Boolean(this.db.query(`SELECT 1 FROM channel_activity
        WHERE user_id=? AND network=? AND channel=? AND id>? LIMIT 1`).get(user.id, network, normalized, lastId));
      const batchId = `batch_${randomToken()}`;
      this.db.query(`INSERT INTO unread_batches(id,user_id,client_id,network,channel,last_id,entries,has_more,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(batchId, user.id, clientId, network, normalized, lastId,
          JSON.stringify(entries), Number(hasMore), now());
      return { batchId, entries, hasMore };
    })();
  }

  ackMessages(user, clientId, batchId) {
    return this.db.transaction(() => {
      const batch = this.db.query(`SELECT * FROM unread_batches WHERE id=? AND user_id=? AND client_id=?`)
        .get(batchId, user.id, clientId);
      if (!batch || batch.network !== user.network_name ||
          !JSON.parse(user.selected_channels).some(channel => channel.toLowerCase() === batch.channel)) return false;
      if (batch.acknowledged) return true;
      this.db.query(`INSERT INTO unread_cursors(user_id,client_id,network,channel,last_id) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id,client_id,network,channel) DO UPDATE SET last_id=max(last_id,excluded.last_id)`)
        .run(user.id, clientId, batch.network, batch.channel, batch.last_id);
      this.db.query("UPDATE unread_batches SET acknowledged=1 WHERE id=?").run(batchId);
      return true;
    })();
  }

  getHistory(user, channel, before = null, limit = 50, since = null) {
    const boundary = parsePageCursor(before);
    if (boundary === false) return null;
    const rows = this.db.query(`SELECT id,entry_id AS entryId,outgoing_message_id AS messageId,
      network,channel,kind,time,observed_at AS observedAt,
      timestamp_source AS timestampSource,nick,text,target FROM channel_activity
      WHERE user_id=? AND network=? AND channel=? AND
        (? IS NULL OR time < ? OR (time = ? AND id < ?)) AND (? IS NULL OR time >= ?)
      ORDER BY time DESC,id DESC LIMIT ?`).all(user.id, user.network_name, channel.toLowerCase(),
        boundary?.[0] ?? null, boundary?.[0] ?? null, boundary?.[0] ?? null, boundary?.[1] ?? 0,
        since, since, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const nextBefore = hasMore ? pageCursor(page.at(-1)) : null;
    return { entries: page.map(({ id, ...entry }) => ({ ...entry,
      mention: ["message", "action"].includes(entry.kind) &&
        entry.nick.toLowerCase() !== user.nick.toLowerCase() && addressesNick(entry.text, user.nick) })), nextBefore };
  }

  searchActivity(user, channels, query, since, until, limit = 50) {
    if (!channels.length) return [];
    const placeholders = channels.map(() => "?").join(",");
    return this.db.query(`SELECT a.id,a.entry_id AS entryId,a.outgoing_message_id AS messageId,
      a.network,a.channel,a.kind,a.time,a.observed_at AS observedAt,
      a.timestamp_source AS timestampSource,a.nick,a.text,a.target FROM activity_fts f
      JOIN channel_activity a ON a.id = f.rowid WHERE activity_fts MATCH ? AND a.user_id = ?
      AND a.network = ? AND a.channel IN (${placeholders}) AND a.kind IN ('message','action')
      AND (? IS NULL OR a.time >= ?) AND (? IS NULL OR a.time <= ?)
      ORDER BY a.time DESC,a.id DESC LIMIT ?`)
      .all(`"${query.replaceAll('"', '""')}"`, user.id, user.network_name,
        ...channels.map(channel => channel.toLowerCase()), since, since, until, until, limit);
  }

  searchPage(user, channels, query, since, until, before = null, limit = 50) {
    const boundary = parsePageCursor(before);
    if (boundary === false) return null;
    if (!channels.length) return { messages: [], nextBefore: null };
    const placeholders = channels.map(() => "?").join(",");
    const rows = this.db.query(`SELECT a.id,a.entry_id AS entryId,a.outgoing_message_id AS messageId,
      a.network,a.channel,a.kind,a.time,a.observed_at AS observedAt,
      a.timestamp_source AS timestampSource,a.nick,a.text,a.target FROM activity_fts f
      JOIN channel_activity a ON a.id=f.rowid WHERE activity_fts MATCH ? AND a.user_id=?
      AND a.network=? AND a.channel IN (${placeholders}) AND a.kind IN ('message','action')
      AND (? IS NULL OR a.time>=?) AND (? IS NULL OR a.time<=?)
      AND (? IS NULL OR a.time<? OR (a.time=? AND a.id<?))
      ORDER BY a.time DESC,a.id DESC LIMIT ?`).all(`"${query.replaceAll('"', '""')}"`, user.id,
        user.network_name, ...channels.map(channel => channel.toLowerCase()), since, since, until, until,
        boundary?.[0] ?? null, boundary?.[0] ?? null, boundary?.[0] ?? null, boundary?.[1] ?? 0, limit + 1);
    const page = rows.slice(0, limit);
    return { messages: page.map(({ id, ...row }) => ({ ...row,
      mention: row.nick.toLowerCase() !== user.nick.toLowerCase() && addressesNick(row.text, user.nick) })),
      nextBefore: rows.length > limit ? pageCursor(page.at(-1)) : null };
  }

  pruneActivity() {
    const cutoff = new Date(now() - this.historyRetentionDays * 86_400_000).toISOString();
    this.db.query("DELETE FROM channel_activity WHERE observed_at < ?").run(cutoff);
    this.db.query(`DELETE FROM channel_activity WHERE id IN (
      SELECT id FROM (SELECT id,row_number() OVER
        (PARTITION BY user_id,network,channel ORDER BY time DESC,id DESC) AS rank FROM channel_activity)
      WHERE rank > ?)`)
      .run(this.historyMaxPerChannel);
    this.db.query("DELETE FROM post_requests WHERE created_at < ?").run(now() - 7 * 86_400_000);
    this.db.query(`DELETE FROM unread_batches WHERE created_at < ? OR EXISTS
      (SELECT 1 FROM json_each(unread_batches.entries) WHERE json_extract(value,'$.observedAt') < ?)`).run(
        now() - this.historyRetentionDays * 86_400_000, cutoff);
    this.db.query("DELETE FROM diagnostic_events WHERE occurred_at < ?").run(now() - this.historyRetentionDays * 86_400_000);
    this.db.query("DELETE FROM event_deliveries WHERE created_at < ? OR subscription_id IN (SELECT id FROM event_subscriptions WHERE expires_at IS NOT NULL AND expires_at < ?)")
      .run(now() - this.historyRetentionDays * 86_400_000, now());
    this.db.query("DELETE FROM event_subscriptions WHERE expires_at IS NOT NULL AND expires_at < ?").run(now());
    const stale = this.db.query("SELECT id FROM agent_sessions WHERE last_used_at < ?")
      .all(now() - 30 * 86_400_000);
    for (const { id } of stale) {
      this.db.query("DELETE FROM unread_batches WHERE client_id=?").run(id);
      this.db.query("DELETE FROM unread_cursors WHERE client_id=?").run(id);
      this.db.query("DELETE FROM agent_sessions WHERE id=?").run(id);
    }
  }
}
