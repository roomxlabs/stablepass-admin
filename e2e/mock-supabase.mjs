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

// ---------------------------------------------------------------------------
// In-memory PostgREST dataset for the Trainers screens (ENG-179). Seeded from
// mockups/web/admin/screens/06-trainers.html so the screenshots match the
// design. The Playwright spec flips `empty` via POST /__control to capture the
// empty state.
const H = 3600e3;
const D = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const TRAINER_SEED = [
  { id: "t1", name: "Chris Waller", stable_name: "Chris Waller Racing", location: "Rosehill, NSW", status: "active", horses: 12, email: "chris@wallerstable.com.au", lastPost: 2 * H },
  { id: "t2", name: "Peter Moody", stable_name: "Moody Racing", location: "Caulfield, VIC", status: "active", horses: 4, email: "peter@moody.com.au", lastPost: 6 * H },
  { id: "t3", name: "James Cummings", stable_name: "Godolphin Australia", location: "Agnes Banks, NSW", status: "active", horses: 3, email: "james@godolphin.com.au", lastPost: D },
  { id: "t4", name: "Anthony & Sam Cummings", stable_name: "Leilani Lodge", location: "Randwick, NSW", status: "active", horses: 2, email: "team@leilanilodge.com.au", lastPost: 2 * D },
  { id: "t5", name: "Ciaron Maher", stable_name: "Ciaron Maher Racing", location: "Ballarat, VIC", status: "active", horses: 1, email: "team@maherracing.com", lastPost: 3 * D },
  { id: "t6", name: "Kris Lees", stable_name: "Lees Racing", location: "Newcastle, NSW", status: "active", horses: 1, email: "kris@leesracing.com.au", lastPost: 5 * D },
  { id: "t7", name: "John Thompson", stable_name: "Thompson Stables", location: "Warwick Farm, NSW", status: "onboarding", horses: 1, email: "john@thompsonracing.au", lastPost: null },
];

function buildDb(seed) {
  const trainers = seed.map((t) => ({
    id: t.id, name: t.name, display_name: t.name, slug: t.id,
    stable_name: t.stable_name, location: t.location, bio: null, photo_url: null, status: t.status,
  }));
  const horses = [];
  const posts = [];
  const contacts = [];
  for (const t of seed) {
    for (let i = 0; i < t.horses; i++) horses.push({ trainer_id: t.id });
    if (t.lastPost != null) posts.push({ source_trainer_id: t.id, published_at: ago(t.lastPost), created_at: ago(t.lastPost) });
    contacts.push({ trainer_id: t.id, role: "Trainer", email: t.email });
  }
  return { trainer: trainers, horse: horses, post: posts, trainer_contact: contacts };
}

let DB = buildDb(TRAINER_SEED);
function setEmpty(empty) {
  DB = empty ? { trainer: [], horse: [], post: [], trainer_contact: [] } : buildDb(TRAINER_SEED);
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
    const rawBody = await drainBody(req);

    // Test control: flip the dataset between populated and empty for screenshots.
    if (req.method === "POST" && url.pathname === "/__control") {
      let empty = false;
      try {
        empty = JSON.parse(rawBody || "{}").empty === true;
      } catch {
        empty = false;
      }
      setEmpty(empty);
      sendJson(res, 200, { ok: true, empty });
      return;
    }

    // PostgREST table reads backing the Trainers list (trainer / horse / post /
    // trainer_contact). Query params (filters/order) are ignored — the spec
    // drives populated vs empty via /__control.
    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.slice("/rest/v1/".length);
      if (Object.prototype.hasOwnProperty.call(DB, table)) {
        const rows = DB[table];
        const accept = req.headers["accept"] ?? "";
        if (accept.includes("pgrst.object")) {
          sendJson(res, 200, rows[0] ?? null);
        } else {
          sendJson(res, 200, rows);
        }
        return;
      }
    }

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
