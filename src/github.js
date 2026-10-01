export async function githubIdentity(config, code, fetcher = fetch) {
  const response = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret,
      code, redirect_uri: `${config.publicBaseUrl}/login/github/callback` }),
  });
  if (!response.ok) throw new Error("GitHub token exchange failed");
  const token = await response.json();
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("GitHub did not issue an access token");
  const profile = await fetcher("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Zircon" },
  });
  if (!profile.ok) throw new Error("GitHub profile lookup failed");
  const user = await profile.json();
  if (!Number.isSafeInteger(user.id) || !/^[A-Za-z0-9-]{1,39}$/.test(user.login ?? "")) throw new Error("Invalid GitHub identity");
  return { id: String(user.id), login: user.login.toLowerCase() };
}
