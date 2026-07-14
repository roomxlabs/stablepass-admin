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

// Posts library (T7 / ENG-177). Rows mirror the shape T5's GET /api/admin/posts
// returns: post columns + embedded horse (with photo) + source trainer. A mix of
// statuses so the row-action variants render. photo_url is null so the neutral
// thumb fallback shows (no external asset needed).
const POST_FIXTURES = [
  { id: "p1", horse_id: "h1", type: "video", status: "published", title: "Last fast gallop before Saturday", body: "He's spot-on. Track was rolling and he came home strong.", like_count: 142, published_at: "2026-07-11T04:10:00Z", scheduled_for: null, created_at: "2026-07-11T04:00:00Z", horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", photo_url: null }, trainer: { name: "Chris Waller" } },
  { id: "p2", horse_id: "h3", type: "photo", status: "published", title: "Track session — three furlongs strong", body: "Morning at Caulfield, going was good.", like_count: 89, published_at: "2026-07-11T00:10:00Z", scheduled_for: null, created_at: "2026-07-11T00:00:00Z", horse: { display_name: "Black Caviar", racing_name: "BLACK CAVIAR (AUS)", photo_url: null }, trainer: { name: "Peter Moody" } },
  { id: "p3", horse_id: "h4", type: "video", status: "scheduled", title: "Saturday preview — race morning walk", body: "Set to go live race morning, 6:00am.", like_count: 0, published_at: null, scheduled_for: "2026-07-18T20:00:00Z", created_at: "2026-07-10T22:00:00Z", horse: { display_name: "Northern Star", racing_name: null, photo_url: null }, trainer: { name: "Peter Moody" } },
  { id: "p4", horse_id: "h2", type: "text", status: "published", title: "Routine day — barrier trial complete", body: "Pleased with the way he finished off.", like_count: 56, published_at: "2026-07-10T09:00:00Z", scheduled_for: null, created_at: "2026-07-10T09:00:00Z", horse: { display_name: "Verry Elleegant", racing_name: "VERRY ELLEEGANT (NZ)", photo_url: null }, trainer: { name: "Chris Waller" } },
  { id: "p5", horse_id: "h6", type: "photo", status: "draft", title: "Quiet day in the box", body: "Draft, waiting on photo from Chris.", like_count: 0, published_at: null, scheduled_for: null, created_at: "2026-07-10T06:00:00Z", horse: { display_name: "Winx", racing_name: "WINX (AUS)", photo_url: null }, trainer: { name: "Chris Waller" } },
  { id: "p6", horse_id: "h1", type: "video", status: "published", title: "Track gallop — pack work", body: "Group session from Rosehill.", like_count: 118, published_at: "2026-07-09T05:00:00Z", scheduled_for: null, created_at: "2026-07-09T05:00:00Z", horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", photo_url: null }, trainer: { name: "Chris Waller" } },
  { id: "p7", horse_id: "h1", type: "photo", status: "unpublished", title: "Stable life — Mahogany on the walker", body: "Cool-down after morning work.", like_count: 34, published_at: "2026-07-08T05:00:00Z", scheduled_for: null, created_at: "2026-07-08T05:00:00Z", horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", photo_url: null }, trainer: { name: "Chris Waller" } },
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

// Emulates a PostgREST list/count response: sets Content-Range so supabase-js
// can read `count` from `count: 'exact'` queries (dashboard tiles rely on this),
// and returns no body for the HEAD requests that `head: true` issues.
function sendTable(res, method, rows, total) {
  const count = total ?? rows.length;
  const headers = {
    "Content-Type": "application/json",
    "Content-Range": `0-${Math.max(0, rows.length - 1)}/${count}`,
    ...corsHeaders(),
  };
  if (method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(rows));
}

// Dashboard (ENG-174 / T4) fixtures. One published-post set feeds three reads:
// the recently-published table, the quiet-horse recency check, and race-day
// per-runner post recency. h1 posted this week (loud); h2/h3 are stale (quiet).
const DASH_POSTS = [
  { id: "p1", horse_id: "h1", type: "video", title: "Last fast gallop before Saturday", like_count: 142, published_at: new Date(Date.now() - 2 * 36e5).toISOString(), horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)" }, trainer: { name: "Chris Waller" } },
  { id: "p4", horse_id: "h1", type: "photo", title: "Morning trackwork in the fog", like_count: 73, published_at: new Date(Date.now() - 26 * 36e5).toISOString(), horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)" }, trainer: { name: "Chris Waller" } },
  { id: "p2", horse_id: "h2", type: "photo", title: "Track session - three furlongs strong", like_count: 89, published_at: new Date(Date.now() - 9 * 864e5).toISOString(), horse: { display_name: "Black Caviar", racing_name: "BLACK CAVIAR (AUS)" }, trainer: { name: "Peter Moody" } },
  { id: "p3", horse_id: "h3", type: "text", title: "Routine day - barrier trial complete", like_count: 56, published_at: new Date(Date.now() - 12 * 864e5).toISOString(), horse: { display_name: "Winx", racing_name: "WINX (AUS)" }, trainer: { name: "Chris Waller" } },
];

// Upcoming races within 24h. h1 posted 2h ago (green "Posted"), h9 never
// posted (amber "No post yet"), h2 posted 9d ago (neutral "Last post").
const DASH_RACES = [
  { id: "r1", venue: "Caulfield", race_number: 3, race_class: "Maiden", scheduled_at: new Date(Date.now() + 2 * 36e5).toISOString(), race_horse: [{ horse_id: "h1", horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", trainer: { name: "Chris Waller", display_name: "Chris Waller" } } }] },
  { id: "r2", venue: "Randwick", race_number: 5, race_class: "BM78", scheduled_at: new Date(Date.now() + 4 * 36e5).toISOString(), race_horse: [{ horse_id: "h9", horse: { display_name: "Northern Star", racing_name: null, trainer: { name: "Peter Moody", display_name: "Peter Moody" } } }] },
  { id: "r3", venue: "Rosehill", race_number: 7, race_class: "G2", scheduled_at: new Date(Date.now() + 6 * 36e5).toISOString(), race_horse: [{ horse_id: "h2", horse: { display_name: "Black Caviar", racing_name: "BLACK CAVIAR (AUS)", trainer: { name: "Peter Moody", display_name: "Peter Moody" } } }] },
];

// Active horses for the quiet-horse check. h1 posted this week (loud); h2/h3
// stale; h5 never posted — so three quiet horses, one retired (matches mockup).
const DASH_HORSES = [
  { id: "h1", display_name: "Mahogany", racing_name: "MAHOGANY (AUS)", training_status: "racing", photo_url: null, status: "active" },
  { id: "h2", display_name: "Black Caviar", racing_name: "BLACK CAVIAR (AUS)", training_status: "city_training", photo_url: null, status: "active" },
  { id: "h3", display_name: "Winx", racing_name: "WINX (AUS)", training_status: "retired", photo_url: null, status: "active" },
  { id: "h5", display_name: "Anamoe", racing_name: "ANAMOE (AUS)", training_status: "spelling", photo_url: null, status: "active" },
];

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

    // Dashboard (ENG-174 / T4) reads. These run BEFORE the generic DB-backed
    // Trainers handler below, which otherwise shadows /rest/v1/post and
    // /rest/v1/horse. Disambiguated by the dashboard's own query signatures: its
    // post reads filter status=eq.published and its horse read filters
    // status=eq.active — trainers' post/horse reads carry neither, so they fall
    // through to the DB handler untouched. GET returns rows; HEAD returns the
    // Content-Range count for the `count: 'exact'` tile queries.
    if (req.method === "GET" || req.method === "HEAD") {
      const p = url.pathname;
      const qs = url.search;
      if (p.startsWith("/rest/v1/reaction")) { sendTable(res, req.method, [], 3420); return; }
      if (p.startsWith("/rest/v1/bookmark")) { sendTable(res, req.method, [], 612); return; }
      if (p.startsWith("/rest/v1/subscription")) { sendTable(res, req.method, [], 412); return; }
      if (p.startsWith("/rest/v1/race")) { sendTable(res, req.method, DASH_RACES, DASH_RACES.length); return; }
      if (p.startsWith("/rest/v1/post") && qs.includes("status=eq.published")) {
        sendTable(res, req.method, DASH_POSTS, 68); // 68 = posts-this-week tile
        return;
      }
      if (p.startsWith("/rest/v1/horse") && qs.includes("status=eq.active")) {
        sendTable(res, req.method, DASH_HORSES, DASH_HORSES.length);
        return;
      }
    }
    // Posts library (T7 / ENG-177). The list read selects `status` — which the
    // trainers' post read (source_trainer_id,published_at,created_at) does not —
    // so use that to serve the full post-library fixtures here, ahead of the
    // generic table reader below (whose synthetic `post` rows exist only for the
    // trainers "last activity" grouping). The list requests count=exact, so the
    // total rides the Content-Range header; the __none__ sentinel drives empty.
    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/post") && url.search.includes("status")) {
      if (url.search.includes("__none__")) {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Range": "*/0", ...corsHeaders() });
        res.end("[]");
        return;
      }
      const total = POST_FIXTURES.length;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Range": `0-${Math.max(0, total - 1)}/${total}`,
        ...corsHeaders(),
      });
      res.end(JSON.stringify(POST_FIXTURES));
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

    // Compose (ENG-176) reads the pickable horses + full trainer list as
    // Layer A PostgREST reads from the server client. Return fixtures with the
    // trainer embedded (as `trainer:trainer_id(...)` yields).
    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/horse")) {
      sendJson(res, 200, [
        { id: "h1", display_name: "Mahogany", racing_name: "Mahogany", photo_url: null, stable_name: "Randwick", trainer_id: "t1", trainer: { id: "t1", name: "Chris Waller", display_name: "Chris Waller" } },
        { id: "h2", display_name: "Black Caviar", racing_name: "Black Caviar", photo_url: null, stable_name: "Caulfield", trainer_id: "t2", trainer: { id: "t2", name: "Peter Moody", display_name: "Peter Moody" } },
        { id: "h3", display_name: "Winx", racing_name: "Winx", photo_url: null, stable_name: "Rosehill", trainer_id: "t1", trainer: { id: "t1", name: "Chris Waller", display_name: "Chris Waller" } },
      ]);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/rest/v1/trainer")) {
      sendJson(res, 200, [
        { id: "t1", name: "Chris Waller", display_name: "Chris Waller" },
        { id: "t2", name: "Peter Moody", display_name: "Peter Moody" },
        { id: "t3", name: "Gai Waterhouse", display_name: "Gai Waterhouse" },
      ]);
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
