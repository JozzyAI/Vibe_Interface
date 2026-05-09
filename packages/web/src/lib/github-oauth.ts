import "server-only";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function getRequestOrigin(request: Request): string {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
  const host = request.headers.get("x-forwarded-host")?.trim() || request.headers.get("host")?.trim();
  if (host) {
    return `${forwardedProto || "http"}://${host}`;
  }
  return new URL(request.url).origin;
}

export function getGitHubOAuthConfig(requestOrigin: string): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = requireEnv("GITHUB_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GITHUB_OAUTH_CLIENT_SECRET");
  const configuredRedirect = process.env.PI_GITHUB_OAUTH_REDIRECT_URI?.trim();
  const redirectUri =
    configuredRedirect && configuredRedirect.length > 0
      ? configuredRedirect
      : new URL("/api/pi/github/oauth/callback", requestOrigin).toString();

  return { clientId, clientSecret, redirectUri };
}

export function buildGitHubOAuthAuthorizeUrl(input: {
  requestOrigin: string;
  state: string;
}): string {
  const { clientId, redirectUri } = getGitHubOAuthConfig(input.requestOrigin);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo read:user user:email",
    state: input.state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGitHubOAuthCode(input: {
  requestOrigin: string;
  code: string;
}): Promise<{ accessToken: string; scope: string }> {
  const { clientId, clientSecret, redirectUri } = getGitHubOAuthConfig(input.requestOrigin);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      redirect_uri: redirectUri,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      }
    | null;

  if (!response.ok || !payload?.access_token) {
    throw new Error(
      payload?.error_description ??
        payload?.error ??
        `GitHub OAuth exchange failed with status ${response.status}`,
    );
  }

  return {
    accessToken: payload.access_token,
    scope: payload.scope ?? "",
  };
}

export async function fetchGitHubViewer(accessToken: string): Promise<{
  login: string;
  name?: string | null;
  avatarUrl?: string;
}> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        login?: string;
        name?: string | null;
        avatar_url?: string;
        message?: string;
      }
    | null;

  if (!response.ok || !payload?.login) {
    throw new Error(payload?.message ?? `GitHub user lookup failed with status ${response.status}`);
  }

  return {
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatar_url,
  };
}

export function buildOAuthReturnUrl(base: string, path: string, params: Record<string, string>): string {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildGitHubOAuthPopupHtml(input: {
  requestOrigin: string;
  projectId?: string;
  success?: boolean;
  login?: string;
  error?: string;
}): string {
  const payload = JSON.stringify({
    type: "pi-github-oauth",
    projectId: input.projectId,
    success: input.success === true,
    login: input.login,
    error: input.error,
  });
  const title = input.success ? "GitHub connected" : "GitHub connection failed";
  const body = input.success
    ? `Connected as @${input.login ?? "github-user"}. You can close this window.`
    : `GitHub connect failed: ${input.error ?? "unknown_error"}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeForHtml(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #111111;
        color: #f5f5f5;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      .card {
        width: min(420px, calc(100vw - 32px));
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 24px;
        padding: 24px;
        background: rgba(20,20,20,0.96);
        box-shadow: 0 18px 60px rgba(0,0,0,0.35);
      }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0; line-height: 1.6; color: rgba(255,255,255,0.76); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeForHtml(title)}</h1>
      <p>${escapeForHtml(body)}</p>
    </div>
    <script>
      (function () {
        var payload = ${payload};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, ${JSON.stringify(input.requestOrigin)});
          }
        } catch (error) {}
        setTimeout(function () { window.close(); }, 250);
      })();
    </script>
  </body>
</html>`;
}
