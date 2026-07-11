// Minimal mock Supabase HTTP server for e2e screenshots.
// Covers just enough of the GoTrue + PostgREST surface for the auth-shell
// flow: password sign-in, getUser(), and the app_user.is_admin lookup.
import http from "node:http";

const FAKE_ACCESS_TOKEN = "fake-access-token";

const TRAINER_FIXTURES = [
  { id: "t1", display_name: "Chris Waller", stable_name: "Chris Waller Racing" },
  { id: "t2", display_name: "Peter Moody", stable_name: "Moody Racing" },
  { id: "t3", display_name: "James Cummings", stable_name: "Godolphin Australia" },
];

const HORSE_FIXTURES = [
  { id: "h1", trainer_id: "t1", display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", stable_name: "Mahogany", sire: "Snitzel", dam: "Polar Success", sex: "gelding", colour: "Bay", foaling_year: 2020, status: "active", training_status: "racing", starts: 24, wins: 6, places: 9, prize_money_cents: 1200000, story: "A consistent city performer with a bright staying future.", photo_url: null, created_at: "2026-01-08T00:00:00Z", trainer: { display_name: "Chris Waller" }, follows: [{ count: 3400 }], posts: [{ count: 28 }] },
  { id: "h2", trainer_id: "t1", display_name: "Verry Elleegant", racing_name: "VERRY ELLEEGANT (NZ)", stable_name: "Verry Elleegant", sire: "Zed", dam: "Opulence", sex: "mare", colour: "Chestnut", foaling_year: 2018, status: "active", training_status: "racing", starts: 44, wins: 11, places: 14, prize_money_cents: 1400000000, story: "", photo_url: null, created_at: "2026-01-07T00:00:00Z", trainer: { display_name: "Chris Waller" }, follows: [{ count: 5100 }], posts: [{ count: 62 }] },
  { id: "h3", trainer_id: "t2", display_name: "Black Caviar", racing_name: "BLACK CAVIAR (AUS)", stable_name: "Black Caviar", sire: "Bel Esprit", dam: "Helsinge", sex: "mare", colour: "Bay", foaling_year: 2019, status: "active", training_status: "city_training", starts: 25, wins: 25, places: 0, prize_money_cents: 780000000, story: "", photo_url: null, created_at: "2026-01-06T00:00:00Z", trainer: { display_name: "Peter Moody" }, follows: [{ count: 8900 }], posts: [{ count: 104 }] },
  { id: "h4", trainer_id: "t2", display_name: "Northern Star", racing_name: null, stable_name: "Northern Star", sire: "Snitzel", dam: "Aurora", sex: "gelding", colour: "Brown", foaling_year: 2022, status: "active", training_status: "racing", starts: 6, wins: 2, places: 3, prize_money_cents: 32000000, story: "", photo_url: null, created_at: "2026-01-05T00:00:00Z", trainer: { display_name: "Peter Moody" }, follows: [{ count: 1200 }], posts: [{ count: 11 }] },
  { id: "h5", trainer_id: "t3", display_name: "Anamoe", racing_name: "ANAMOE (AUS)", stable_name: "Anamoe", sire: "Street Boss", dam: "Anamato", sex: "colt", colour: "Bay", foaling_year: 2021, status: "active", training_status: "spelling", starts: 20, wins: 12, places: 5, prize_money_cents: 1600000000, story: "", photo_url: null, created_at: "2026-01-04T00:00:00Z", trainer: { display_name: "James Cummings" }, follows: [{ count: 4200 }], posts: [{ count: 48 }] },
  { id: "h6", trainer_id: "t1", display_name: "Winx", racing_name: "WINX (AUS)", stable_name: "Winx", sire: "Street Cry", dam: "Vegas Showgirl", sex: "mare", colour: "Bay", foaling_year: 2011, status: "active", training_status: "retired", starts: 43, wins: 37, places: 3, prize_money_cents: 2600000000, story: "", photo_url: null, created_at: "2026-01-03T00:00:00Z", trainer: { display_name: "Chris Waller" }, follows: [{ count: 12400 }], posts: [{ count: 211 }] },
  { id: "h7", trainer_id: "t2", display_name: "Magic Time", racing_name: null, stable_name: "Magic Time", sire: "Fastnet Rock", dam: "Illusion", sex: "mare", colour: "Grey", foaling_year: 2021, status: "active", training_status: "farm_training", starts: 4, wins: 1, places: 1, prize_money_cents: 4500000, story: "", photo_url: null, created_at: "2026-01-02T00:00:00Z", trainer: { display_name: "Peter Moody" }, follows: [{ count: 820 }], posts: [{ count: 9 }] },
  { id: "h8", trainer_id: "t3", display_name: "Saxon Warrior", racing_name: "SAXON WARRIOR (JPN)", stable_name: "Saxon Warrior", sire: "Deep Impact", dam: "Maybe", sex: "gelding", colour: "Bay", foaling_year: 2020, status: "active", training_status: "racing", starts: 12, wins: 3, places: 4, prize_money_cents: 210000000, story: "", photo_url: null, created_at: "2026-01-01T00:00:00Z", trainer: { display_name: "James Cummings" }, follows: [{ count: 2100 }], posts: [{ count: 23 }] },
];

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

    // Horses DB (T8 / ENG-178). The __none__ sentinel drives the empty-list state.
    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/horse")) {
      const accept = req.headers["accept"] ?? "";
      if (url.search.includes("__none__")) {
        sendJson(res, 200, accept.includes("pgrst.object") ? null : []);
        return;
      }
      // .maybeSingle() does NOT set the pgrst.object Accept header in this
      // postgrest-js version (workaround for supabase/postgrest-js#361) — it
      // fetches as a list and enforces cardinality client-side. So an
      // `id=eq.<id>` filter must be honoured here regardless of Accept,
      // otherwise the full fixture list reads as "multiple rows" and the
      // edit page 404s.
      const idParam = url.searchParams.get("id");
      if (idParam && idParam.startsWith("eq.")) {
        const id = idParam.slice(3);
        const match = HORSE_FIXTURES.find((h) => h.id === id) ?? null;
        if (accept.includes("pgrst.object")) {
          sendJson(res, 200, match);
          return;
        }
        sendJson(res, 200, match ? [match] : []);
        return;
      }
      if (accept.includes("pgrst.object")) {
        sendJson(res, 200, HORSE_FIXTURES[0]);
        return;
      }
      sendJson(res, 200, HORSE_FIXTURES);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/trainer")) {
      if (url.search.includes("__none__")) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(res, 200, TRAINER_FIXTURES);
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
