import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class TokenVerifier {
  constructor(config, jwks) {
    this.config = config;
    this.jwks = jwks ?? createRemoteJWKSet(new URL(config.oidcJwksUrl));
  }

  async verify(authorization, requiredScope) {
    const match = /^Bearer (\S+)$/i.exec(authorization ?? "");
    if (!match) throw new AuthError("Bearer token required", 401);
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(match[1], this.jwks, {
        issuer: this.config.oidcIssuer,
        audience: this.config.oidcAudience,
        algorithms: ["RS256"],
      }));
    } catch {
      throw new AuthError("Invalid access token", 401);
    }
    if (typeof claims.sub !== "string" || typeof claims.iat !== "number" || typeof claims.exp !== "number") {
      throw new AuthError("Access token is missing required claims", 401);
    }
    if (!this.config.allowedSubjects.has("*") && !this.config.allowedSubjects.has(claims.sub)) {
      throw new AuthError("Subject is not allowed", 403);
    }
    const scopes = new Set(typeof claims.scope === "string" ? claims.scope.split(" ") : []);
    if (!scopes.has(requiredScope)) throw new AuthError(`Missing ${requiredScope} scope`, 403);
    return claims;
  }
}
