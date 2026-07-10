// Minimal mock Supabase HTTP server for e2e screenshots.
// Covers just enough of the GoTrue + PostgREST surface for the auth-shell
// flow: password sign-in, getUser(), and the app_user.is_admin lookup.
import http from "node:http";

const FAKE_ACCESS_TOKEN = "fake-access-token";

const ADMIN_USER = {
  id: "admin-0001",
  aud: "authenticated",
  role: "authenticated",
  email: "ops@stablepass.co",
  email_confirmed_at: "2020-01-01T00:00:00Z",
  phone: "",
  confirmed_at: "2020-01-01T00:00:00Z",
  last_sign_in_at: "2020-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [],
  created_at: "2020-01-01T00:00:00Z",
  updated_at: "2020-01-01T00:00:00Z",
};

function session() {
  return {
    access_token: FAKE_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "fake-refresh-token",
    user: ADMIN_USER,
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(),
  });
  res.end(payload);
}

async function drainBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

export function startMockSupabase() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:8787");

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // Always drain the body so the client's request stream completes cleanly.
    await drainBody(req);

    if (req.method === "POST" && url.pathname === "/auth/v1/token") {
      sendJson(res, 200, session());
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      const auth = req.headers["authorization"];
      if (auth === `Bearer ${FAKE_ACCESS_TOKEN}`) {
        sendJson(res, 200, ADMIN_USER);
      } else {
        sendJson(res, 401, { code: 401, msg: "invalid token" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/app_user")) {
      const accept = req.headers["accept"] ?? "";
      if (accept.includes("pgrst.object")) {
        sendJson(res, 200, { is_admin: true });
      } else {
        sendJson(res, 200, [{ is_admin: true }]);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/v1/logout") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    console.log(`[mock-supabase] unhandled ${req.method} ${url.pathname}${url.search}`);
    sendJson(res, 200, {});
  });

  return new Promise((resolve) => {
    server.listen(8787, "127.0.0.1", () => resolve(server));
  });
}

export default startMockSupabase;
