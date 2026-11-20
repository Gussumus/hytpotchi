export interface Env {
  // Reserved for future configuration. No secrets are required to proxy public Modrinth data.
}

const API_ORIGIN = "https://api.modrinth.com";
const ALLOWED_DOWNLOAD_SUFFIXES = [".modrinth.com", ".modrinth.net"];

function isAllowedModrinthHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "modrinth.com" || host === "modrinth.net" ||
    ALLOWED_DOWNLOAD_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function proxyApi(request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }

  const upstreamUrl = new URL(url.pathname.replace(/^\/v2(?=\/|$)/, "/v2") + url.search, API_ORIGIN);
  const headers = new Headers();
  for (const name of ["accept", "content-type", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", "Hytpotchi/ModrinthProxy");

  const init: RequestInit = { method: request.method, headers, redirect: "follow" };
  if (request.method === "POST") init.body = request.body;

  const upstream = await fetch(upstreamUrl, init);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "public, max-age=60");
  responseHeaders.delete("set-cookie");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

async function proxyDownload(request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET") return jsonError("Method not allowed", 405);

  const raw = url.searchParams.get("url");
  if (!raw || raw.length > 4096) return jsonError("Missing or invalid url", 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return jsonError("Invalid url", 400);
  }
  if (target.protocol !== "https:" || !isAllowedModrinthHost(target.hostname)) {
    return jsonError("Only HTTPS Modrinth download hosts are allowed", 403);
  }

  // Follow redirects manually and validate every destination to prevent open-proxy/SSRF abuse.
  for (let hop = 0; hop < 6; hop++) {
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) headers.set("range", range);

    const upstream = await fetch(target, { method: "GET", headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(upstream.status)) {
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("cache-control", "public, max-age=86400");
      responseHeaders.delete("set-cookie");
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    }

    const location = upstream.headers.get("location");
    if (!location) return jsonError("Upstream redirect without location", 502);
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return jsonError("Invalid upstream redirect", 502);
    }
    if (next.protocol !== "https:" || !isAllowedModrinthHost(next.hostname)) {
      return jsonError("Upstream redirected outside Modrinth download hosts", 502);
    }
    target = next;
  }
  return jsonError("Too many upstream redirects", 502);
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ service: "hytpotchi-modrinth-proxy", ok: true });
    }
    if (url.pathname === "/download") return proxyDownload(request, url);
    if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) return proxyApi(request, url);
    return jsonError("Not found", 404);
  },
};
