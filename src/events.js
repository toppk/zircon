import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

export function publicIp(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
        b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    const [firstText, secondText = "0"] = value.split(":");
    const first = Number.parseInt(firstText, 16);
    const second = Number.parseInt(secondText || "0", 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002;
  }
  return false;
}

export function validCallbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.port === "" && !url.username && !url.password &&
      !url.hash && url.hostname.length <= 253 && !isIP(url.hostname) &&
      /^[a-z0-9.-]+$/i.test(url.hostname) && url.hostname.includes(".") &&
      !url.hostname.endsWith(".local") && !url.hostname.endsWith(".internal");
  } catch { return false; }
}

export function validWebhookSecret(secret) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  const encoded = secret.slice(6);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length >= 24 && bytes.length <= 64 && bytes.toString("base64") === encoded;
}

export function webhookSignature(secret, id, timestamp, body) {
  const key = Buffer.from(secret.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function pinnedLookup(address) {
  return (_host, options, callback) => {
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}

export async function sendHttps(urlString, { body, headers }) {
  if (!validCallbackUrl(urlString)) throw new Error("invalid_callback_url");
  const url = new URL(urlString);
  let timeout;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("callback_dns_timeout")), 5000); }),
  ]).finally(() => clearTimeout(timeout));
  if (!addresses.length || addresses.some(item => !publicIp(item.address))) throw new Error("non_public_callback_address");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST", agent: false, servername: url.hostname, rejectUnauthorized: true,
      lookup: pinnedLookup(address),
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 16_384) request.destroy(new Error("callback_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error("callback_timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

export class EventService {
  constructor(store, transport = sendHttps) {
    this.store = store;
    this.transport = transport;
    this.running = false;
    this.wakePending = false;
    this.wakeScheduled = false;
    this.verified = new Map();
  }

  wake() {
    this.wakePending = true;
    if (this.running || this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      if (this.running) return;
      this.wakePending = false;
      void this.drain().catch(error => console.error("Event worker failed:", error.message));
    });
  }

  async post(url, secret, subscriptionId, id, data, previousSecret = null) {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error("event_too_large");
    const timestamp = String(Math.floor(Date.now() / 1000));
    return this.transport(url, { body, headers: {
      "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": timestamp,
      "webhook-signature": [webhookSignature(secret, id, timestamp, body),
        ...(previousSecret ? [webhookSignature(previousSecret, id, timestamp, body)] : [])].join(" "),
      "X-MCP-Subscription-Id": subscriptionId,
    } });
  }

  async verify(url, secret, subscriptionId) {
    const key = `${subscriptionId}:${createHash("sha256").update(secret).digest("hex")}`;
    if ((this.verified.get(key) ?? 0) > Date.now()) return true;
    const challenge = randomBytes(24).toString("base64url");
    const result = await this.post(url, secret, subscriptionId, `msg_verification_${randomBytes(12).toString("base64url")}`,
      { type: "verification", challenge });
    if (result.status < 200 || result.status >= 300) return false;
    let echoed;
    try { echoed = JSON.parse(result.body).challenge; } catch { return false; }
    const valid = typeof echoed === "string" && Buffer.byteLength(echoed) === Buffer.byteLength(challenge) &&
      timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge));
    if (valid) {
      if (this.verified.size >= 256) this.verified.delete(this.verified.keys().next().value);
      this.verified.set(key, Date.now() + 300_000);
    }
    return valid;
  }

  async processOnce() {
    const delivery = this.store.nextEventDelivery();
    if (!delivery) return false;
    const user = this.store.userById(delivery.user_id);
    const payload = JSON.parse(delivery.payload);
    if (!user || !user.online || !this.store.hasEventAccess(delivery.user_id, delivery.client_id) ||
        (delivery.expires_at !== null && delivery.expires_at <= Date.now()) ||
        !JSON.parse(user.selected_channels).some(channel => channel.toLowerCase() === payload.data.channel.toLowerCase()) ||
        user.network_name !== payload.data.network) {
      this.store.finishEventDelivery(delivery.event_id, "drop");
      return true;
    }
    try {
      this.store.recordDiagnostic(user, "event", "delivery_started", delivery.event_id);
      const result = await this.post(delivery.url, delivery.secret, delivery.subscription_id, delivery.event_id, payload,
        delivery.rotate_until > Date.now() ? delivery.previous_secret : null);
      this.store.recordEventAttempt(delivery.subscription_id, String(result.status));
      if (result.status === 410) {
        this.store.db.query("DELETE FROM event_deliveries WHERE subscription_id=?").run(delivery.subscription_id);
        this.store.db.query("DELETE FROM event_subscriptions WHERE id=?").run(delivery.subscription_id);
      } else this.store.finishEventDelivery(delivery.event_id,
        result.status === 429 || result.status >= 500 ? "retry" : "done");
      this.store.recordDiagnostic(user, "event", "delivery", `${result.status}:${delivery.event_id}`);
    } catch (error) {
      this.store.recordEventAttempt(delivery.subscription_id, "error");
      this.store.finishEventDelivery(delivery.event_id, "retry");
      this.store.recordDiagnostic(user, "event", "delivery_error", `${delivery.event_id}:${String(error.message)}`.slice(0, 128));
    }
    return true;
  }

  async drain(max = 10) {
    if (this.running) return;
    this.running = true;
    try { for (let index = 0; index < max && await this.processOnce(); index++); }
    finally {
      this.running = false;
      if (this.wakePending) {
        this.wakePending = false;
        this.wake();
      }
    }
  }
}
