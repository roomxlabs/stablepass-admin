// Minimal mock Supabase HTTP server for e2e screenshots.
// Covers just enough of the GoTrue + PostgREST surface for the auth-shell
// flow: password sign-in, getUser(), and the app_user.is_admin lookup.
import http from "node:http";

const FAKE_ACCESS_TOKEN = "fake-access-token";

// NOTE: there is deliberately no standalone TRAINER_FIXTURES set. Every trainer
// read is served from the DB built off TRAINER_SEED below, so the /__control
// empty toggle applies uniformly and a second trainer source can't drift out of
// sync with the first (that duplication is what made the horse reads ambiguous).

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

// Racing match queue (RF4 / ENG-296). The horses behind the pending proposals,
// shaped for the screen's own select (which is what routes them here — see the
// `racing_api_id` branch in the /rest/v1/horse block). trainer_id points at the
// TRAINER_SEED ids so the trainer name resolves through the generic DB reader.
const RACING_MATCH_HORSES = [
  { id: "h4", display_name: "Northern Star", racing_name: null, sire: "Snitzel", dam: "Aurora", foaling_year: 2022, sex: "gelding", colour: "Brown", trainer_id: "t2", racing_api_id: null },
  { id: "h7", display_name: "Magic Time", racing_name: null, sire: "Fastnet Rock", dam: "Illusion", foaling_year: 2021, sex: "mare", colour: "Grey", trainer_id: "t2", racing_api_id: null },
];

// Two pending proposals: one where every field lines up (the easy confirm) and
// one with name/dam/trainer disagreements (the reason the screen shows the two
// sources side by side). `evidence` carries ONLY the seven allowlisted racing
// fields — never the feed's owner (RF1's CHECK + the BFF allowlist).
const RACING_MATCH_PROPOSALS = [
  {
    id: "p1", horse_id: "h4", racing_api_id: "RA-88213", created_at: "2026-07-20T22:10:00Z",
    evidence: { name: "Northern Star", sire: "Snitzel", dam: "Aurora", age: 4, sex: "Gelding", colour: "Brown", trainer: "Peter Moody" },
  },
  {
    id: "p2", horse_id: "h7", racing_api_id: "RA-90455", created_at: "2026-07-20T23:40:00Z",
    // This fixture deliberately carries owner PII and an odds field that a
    // real feed might smuggle in. RF1's CHECK is case-sensitive, so a cased
    // "Owner" key WOULD store — which makes the BFF allowlist the only thing
    // standing between it and a browser. The spec asserts none of these
    // strings reach the page, so if pickEvidence ever regresses, e2e goes red.
    evidence: {
      name: "Magic Times", sire: "Fastnet Rock", dam: "Delusion", age: 5, sex: "Mare", colour: "Grey", trainer: "P. Moody",
      owner: "PIILEAKOWNER", Owner: "PIILEAKCASED", owner_email: "leak@example.com",
      odds: "PIILEAKODDS", profile: { owner: "PIILEAKNESTED" },
    },
  },
];

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
// Analytics (ENG-276) shares the /__control empty toggle so one spec captures
// both the populated and the empty (new-platform, all-zeros) states.
let ANALYTICS_EMPTY = false;
function setEmpty(empty) {
  DB = empty ? { trainer: [], horse: [], post: [], trainer_contact: [] } : buildDb(TRAINER_SEED);
  ANALYTICS_EMPTY = empty;
}

// ---- Analytics fixtures (ENG-276 / A4) --------------------------------------
// Seeded, fake data only. Shapes are the snake_case rows the A3 RPCs return
// (see lib/analytics/queries.ts), NOT the camelCase response types.

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// 14 days of opens, with two race-day peaks matching the mockup's shape.
const OPENS_BY_DAY = [
  480, 620, 400, 730, 540, 940, 780, 460, 600, 380, 680, 560, 900, 720,
].map((opens, i) => ({ day: isoDaysAgo(13 - i), opens }));

// UTC hours. The screen buckets these into 12 two-hour AEST buckets, so the
// 6-8am and 6-8pm AEST peaks live at UTC 20-21 and UTC 08-09.
const OPENS_BY_HOUR = [
  { hour: 20, opens: 820 }, { hour: 21, opens: 640 },
  { hour: 8, opens: 940 }, { hour: 9, opens: 700 },
  { hour: 22, opens: 500 }, { hour: 23, opens: 360 },
  { hour: 0, opens: 440 }, { hour: 1, opens: 580 },
  { hour: 2, opens: 660 }, { hour: 3, opens: 300 },
  { hour: 12, opens: 140 }, { hour: 14, opens: 80 },
];

const TRAINER_ENGAGEMENT = [
  { trainer_id: "t1", name: "Chris Waller", horses: 12, posts: 38, opens: 4120, reactions: 4882, saves: 964, website_clicks: 210 },
  { trainer_id: "t2", name: "Peter Moody", horses: 6, posts: 24, opens: 2905, reactions: 3246, saves: 701, website_clicks: 146 },
  { trainer_id: "t3", name: "Gai Waterhouse", horses: 4, posts: 17, opens: 1844, reactions: 2010, saves: 438, website_clicks: 98 },
  { trainer_id: "t4", name: "Ciaron Maher", horses: 2, posts: 9, opens: 991, reactions: 1066, saves: 268, website_clicks: 34 },
];

const HORSE_ENGAGEMENT = [
  { horse_id: "h1", name: "Mahogany", trainer_name: "Chris Waller", posts: 11, opens: 1682, reactions: 1913, saves: 402 },
  { horse_id: "h2", name: "Black Caviar", trainer_name: "Peter Moody", posts: 8, opens: 1347, reactions: 1588, saves: 344 },
  { horse_id: "h3", name: "Verry Elleegant", trainer_name: "Chris Waller", posts: 9, opens: 1120, reactions: 1204, saves: 287 },
  { horse_id: "h4", name: "Anamoe", trainer_name: "Gai Waterhouse", posts: 6, opens: 846, reactions: 922, saves: 198 },
];

const TOP_POSTS = [
  { post_id: "pa1", title: "Last fast gallop before Saturday", horse_name: "Mahogany", type: "video", opens: 598, reactions: 142, saves: 28 },
  { post_id: "pa2", title: "Track session - three furlongs strong", horse_name: "Black Caviar", type: "photo", opens: 431, reactions: 89, saves: 19 },
  { post_id: "pa3", title: "Routine day - barrier trial complete", horse_name: "Verry Elleegant", type: "voice", opens: 302, reactions: 56, saves: 11 },
];

const TRIALS_BY_MONTH = [
  { month: "2026-02", started: 24, converted: 9 },
  { month: "2026-03", started: 32, converted: 14 },
  { month: "2026-04", started: 48, converted: 21 },
  { month: "2026-05", started: 60, converted: 28 },
  { month: "2026-06", started: 76, converted: 41 },
  { month: "2026-07", started: 96, converted: 58 },
];

const CLICKS_BY_TRAINER = TRAINER_ENGAGEMENT.map((t) => ({
  trainer_id: t.trainer_id, name: t.name, clicks: t.website_clicks, last_click: null,
}));

// Subscription rows for the trials list. `user` is the embedded select alias.
// Fake members only — never real subscriber data.
function trialSub(name, email, startedDaysAgo, endsInDays, status) {
  return {
    status,
    created_at: new Date(Date.now() - startedDaysAgo * 864e5).toISOString(),
    trial_ends_at: new Date(Date.now() + endsInDays * 864e5).toISOString(),
    user: { name, email },
  };
}
const TRIAL_SUBSCRIPTIONS = [
  trialSub("Sarah Mitchell", "sarah.m@example.test", 26, 5, "trial"),
  trialSub("Tom Nguyen", "tom.nguyen@example.test", 22, 9, "trial"),
  trialSub("Rebecca Hartley", "bec.hartley@example.test", 14, 17, "trial"),
  trialSub("David Okafor", "d.okafor@example.test", 5, 26, "trial"),
  trialSub("Alex Reid", "alex.reid@example.test", 90, -60, "active"),
  trialSub("Jo Bennett", "jo.bennett@example.test", 120, -90, "active"),
];

// Per-post screen fixtures, keyed by the top-post ids above.
const POST_ANALYTICS_POSTS = [
  {
    id: "pa1",
    title: "Last fast gallop before Saturday",
    type: "video",
    published_at: new Date(Date.now() - 4 * 864e5).toISOString(),
    horse_id: "h1",
    horse: { display_name: "Mahogany", racing_name: "Mahogany" },
    trainer: { name: "Chris Waller", display_name: "Chris Waller" },
  },
];

const POST_OPENS_BY_DAY = [312, 148, 74, 41, 23].map((opens, i) => ({
  day: isoDaysAgo(4 - i),
  opens,
}));

// Deliberately NOT the canonical set — the screen must render whatever the API
// returns, since the final reaction set is still due from the client.
const POST_REACTIONS = [
  { emoji: "👍", count: 58 },
  { emoji: "❤️", count: 39 },
  { emoji: "👏", count: 21 },
  { emoji: "🔥", count: 13 },
  { emoji: "🐎", count: 7 },
  { emoji: "💪", count: 3 },
  { emoji: "🙏", count: 1 },
];

function analyticsRpc(fn) {
  if (ANALYTICS_EMPTY) return [];
  switch (fn) {
    case "admin_opens_by_day": return OPENS_BY_DAY;
    case "admin_opens_by_hour": return OPENS_BY_HOUR;
    case "admin_trainer_engagement": return TRAINER_ENGAGEMENT;
    case "admin_horse_engagement": return HORSE_ENGAGEMENT;
    case "admin_top_posts": return TOP_POSTS;
    case "admin_trials_by_month": return TRIALS_BY_MONTH;
    case "admin_clicks_by_trainer": return CLICKS_BY_TRAINER;
    case "admin_post_opens_by_day": return POST_OPENS_BY_DAY;
    case "admin_post_reactions": return POST_REACTIONS;
    default:
      console.log(`[mock-supabase] unhandled rpc ${fn}`);
      return [];
  }
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

// Manual races (ENG-180 / RF6) fixtures. Deliberately mixed provenance, because
// the screen exists to make provenance legible: a hand-entered race, an untouched
// feed race, and a feed race a human has corrected (manual_override=true, so the
// RF3 poll leaves it alone). `manual_override` in the select is the discriminator
// that separates these reads from the dashboard's race-day read of DASH_RACES.
const MANUAL_RACES = [
  { id: "mr1", venue: "Randwick", race_date: "2026-08-01", race_number: 5, race_class: "BM78", distance_m: 1400, scheduled_at: new Date(Date.now() + 3 * 36e5).toISOString(), status: "upcoming", source: "manual", manual_override: false, finished_at: null },
  { id: "mr2", venue: "Flemington", race_date: "2026-07-26", race_number: 2, race_class: "Maiden", distance_m: 1200, scheduled_at: new Date(Date.now() + 26 * 36e5).toISOString(), status: "upcoming", source: "api", manual_override: true, finished_at: null },
  { id: "mr3", venue: "Caulfield", race_date: "2026-07-11", race_number: 7, race_class: "G2", distance_m: 1600, scheduled_at: new Date(Date.now() - 9 * 864e5).toISOString(), status: "finished", source: "api", manual_override: false, finished_at: new Date(Date.now() - 9 * 864e5).toISOString() },
];

// Runners on mr1: one still confirmed (result form open), one already ran (its
// result is read-only, because the career counters have already moved).
const MANUAL_RUNNERS = [
  { id: "mrh1", race_id: "mr1", horse_id: "h1", barrier: 4, jockey: "T. Berry", result: null, finish_position: null, entry_status: "confirmed", horse: { display_name: "Mahogany", racing_name: "MAHOGANY (AUS)" } },
  { id: "mrh2", race_id: "mr1", horse_id: "h2", barrier: 9, jockey: "J. McDonald", result: "2nd of 12", finish_position: 2, entry_status: "ran", horse: { display_name: "Black Caviar", racing_name: "BLACK CAVIAR (AUS)" } },
];

// Compose (ENG-176 / T6) pickable horses. Distinct from DASH_HORSES: compose
// needs the embedded `trainer` (its byline auto-fills from the horse's trainer,
// asserted by compose.spec.ts) and `stable_name`. DASH_HORSES has neither, so
// serving the dashboard set here silently breaks the byline — see the horse
// dispatch block below for why these must be discriminated, not overlapped.
const COMPOSE_HORSES = [
  { id: "h1", display_name: "Mahogany", racing_name: "Mahogany", photo_url: null, stable_name: "Randwick", trainer_id: "t1", trainer: { id: "t1", name: "Chris Waller", display_name: "Chris Waller" } },
  { id: "h2", display_name: "Black Caviar", racing_name: "Black Caviar", photo_url: null, stable_name: "Caulfield", trainer_id: "t2", trainer: { id: "t2", name: "Peter Moody", display_name: "Peter Moody" } },
  { id: "h3", display_name: "Winx", racing_name: "Winx", photo_url: null, stable_name: "Rosehill", trainer_id: "t1", trainer: { id: "t1", name: "Chris Waller", display_name: "Chris Waller" } },
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

    // ---- Analytics (ENG-276 / A4) -------------------------------------------
    // These MUST stay ahead of the dashboard reads and the generic DB reader
    // below: the dashboard's /rest/v1/subscription handler returns an empty
    // list, and the generic reader shadows /rest/v1/post with trainer-shaped
    // stubs (see .rx/gotchas.md). Each is discriminated by a query signature
    // unique to the analytics reads so the other screens are untouched.

    // Postgres RPCs (PostgREST serves them as POST /rest/v1/rpc/<name>). The
    // base mock had no RPC handler at all, so these fell through to the
    // catch-all `200 {}` and every chart rendered blank.
    if (req.method === "POST" && url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.slice("/rest/v1/rpc/".length);
      sendJson(res, 200, analyticsRpc(fn));
      return;
    }

    // Trials list: getTrials() selects trial_ends_at, which no other screen does.
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      url.pathname.startsWith("/rest/v1/subscription") &&
      url.search.includes("trial_ends_at")
    ) {
      const rows = ANALYTICS_EMPTY ? [] : TRIAL_SUBSCRIPTIONS;
      sendTable(res, req.method, rows, rows.length);
      return;
    }

    // Per-post analytics reads the post by PK. Two traps here, both hit during
    // this ticket:
    //  1. The `id=eq.` filter must be ANCHORED — unanchored it also matches
    //     `horse_id=eq.` (the posts library's horse filter) and hijacks it.
    //  2. url.search is PERCENT-ENCODED, so `:` arrives as `%3A` and a raw
    //     substring test for an embed alias never fires. Decode first.
    // The select signature must also be analytics-only: `trainer:source_trainer_id`
    // alone is shared with the posts library and the preview route, so key on
    // the full `(name,display_name)` embed, which only this read uses.
    // `.maybeSingle()` fetches as a LIST and enforces cardinality client side,
    // so return exactly the one matching row (see .rx/gotchas.md).
    const decodedSearch = decodeURIComponent(url.search);
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/rest/v1/post") &&
      /[?&]id=eq\./.test(url.search) &&
      decodedSearch.includes("trainer:source_trainer_id(name,display_name)")
    ) {
      const id = decodeURIComponent(url.search.match(/[?&]id=eq\.([^&]+)/)?.[1] ?? "");
      const row = POST_ANALYTICS_POSTS.find((p) => p.id === id) ?? null;
      const accept = req.headers["accept"] ?? "";
      if (accept.includes("pgrst.object")) sendJson(res, 200, row);
      else sendJson(res, 200, row ? [row] : []);
      return;
    }

    // Saves + reach counts for the per-post screen (head:true count queries —
    // the total rides Content-Range, so an absent header renders 0).
    if ((req.method === "GET" || req.method === "HEAD") && url.search.includes("post_id=eq.")) {
      if (url.pathname.startsWith("/rest/v1/bookmark")) {
        sendTable(res, req.method, [], ANALYTICS_EMPTY ? 0 : 28);
        return;
      }
    }
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      url.pathname.startsWith("/rest/v1/follow")
    ) {
      sendTable(res, req.method, [], ANALYTICS_EMPTY ? 0 : 204);
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
      // Manual races (ENG-180 / RF6) — MUST precede the `/rest/v1/race` prefix
      // match below, which is over-broad and would otherwise swallow both the
      // race_horse table and these reads (the same shadowing bug class the horse
      // block below documents). Each branch names its discriminator.
      //
      // (a) runners on a race: exact table match on race_horse.
      if (url.pathname === "/rest/v1/race_horse") {
        const raceId = url.searchParams.get("race_id");
        const rows = raceId?.startsWith("eq.")
          ? MANUAL_RUNNERS.filter((r) => r.race_id === raceId.slice(3))
          : MANUAL_RUNNERS;
        sendTable(res, req.method, rows, rows.length);
        return;
      }
      // (b) the manual-races list + detail reads, identified by `manual_override`
      // in the select — the dashboard's race-day read never asks for it.
      if (url.pathname === "/rest/v1/race" && qs.includes("manual_override")) {
        const accept = req.headers["accept"] ?? "";
        const idParam = url.searchParams.get("id");
        // Detail page uses .eq("id", id).maybeSingle(); per the note in the horse
        // block, maybeSingle does not set the pgrst.object Accept header in this
        // postgrest-js version, so honour the id filter regardless of Accept.
        if (idParam?.startsWith("eq.")) {
          const match = MANUAL_RACES.find((r) => r.id === idParam.slice(3)) ?? null;
          sendJson(res, 200, accept.includes("pgrst.object") ? match : match ? [match] : []);
          return;
        }
        sendTable(res, req.method, MANUAL_RACES, MANUAL_RACES.length);
        return;
      }
      if (p.startsWith("/rest/v1/race")) { sendTable(res, req.method, DASH_RACES, DASH_RACES.length); return; }
      if (p.startsWith("/rest/v1/post") && qs.includes("status=eq.published")) {
        sendTable(res, req.method, DASH_POSTS, 68); // 68 = posts-this-week tile
        return;
      }
      // NOTE: the dashboard's horse read is served by the consolidated
      // /rest/v1/horse dispatch below, NOT here. It used to live here keyed on
      // `status=eq.active` alone, which also swallowed compose's horse read
      // (compose filters status=eq.active too) and handed it DASH_HORSES —
      // rows with no embedded trainer, so the compose byline never auto-filled.
    }

    // -----------------------------------------------------------------------
    // /rest/v1/horse — ALL of it, in ONE place, ahead of the generic DB-backed
    // dispatcher further down.
    //
    // Five different screens read this one table, so the mock MUST discriminate
    // on the query string rather than first-match-wins. Two shadowing bugs came
    // from not doing that (ENG-285):
    //   1. the generic `/rest/v1/<table>` reader answered every horse read with
    //      buildDb()'s bare `{ trainer_id }` stubs — 24 nameless rows, no
    //      display_name — so the horses list rendered 24 empty cards and its
    //      empty-state spec never saw `.horse-empty`;
    //   2. the dashboard handler's `status=eq.active` test also matched
    //      compose's read and returned trainer-less rows.
    // Per .rx/gotchas.md: specific handlers BEFORE the dispatcher, keyed on a
    // discriminator unique to the calling screen. Each branch below names its
    // caller and the marker that identifies it — keep them mutually exclusive.
    // Exact table match, NOT startsWith: `startsWith("/rest/v1/horse")` would
    // also swallow a future `horse_*` table (the way `/rest/v1/race` already
    // captures `race_horse`) — which is the same over-broad-match bug class this
    // block exists to fix. Compare the sliced table name instead.
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/rest/v1/horse") {
      const qs = url.search;
      const accept = req.headers["accept"] ?? "";
      const select = url.searchParams.get("select") ?? "";

      // (a) `__none__` search sentinel → empty list. Drives the horses-list
      // empty state (e2e/horses.spec.ts "horses list — empty").
      if (qs.includes("__none__")) {
        sendJson(res, 200, accept.includes("pgrst.object") ? null : []);
        return;
      }

      // (b) Horse edit/detail page: `.eq("id", id).maybeSingle()`.
      // .maybeSingle() does NOT set the pgrst.object Accept header in this
      // postgrest-js version (supabase/postgrest-js#361) — it fetches as a list
      // and enforces cardinality client-side, so an `id=eq.` filter must be
      // honoured regardless of Accept or the edit page 404s.
      const idParam = url.searchParams.get("id");
      if (idParam && idParam.startsWith("eq.")) {
        const match = HORSE_FIXTURES.find((h) => h.id === idParam.slice(3)) ?? null;
        sendJson(res, 200, accept.includes("pgrst.object") ? match : match ? [match] : []);
        return;
      }

      // (c) Trainers list roster counts: `.from("horse").select("trainer_id")`.
      // The ONLY horse read that wants buildDb()'s stubs — it just counts rows
      // per trainer — so it reads the live DB rather than the fixtures, which
      // also keeps it consistent with the /__control empty toggle.
      // NB: that toggle-consistency is currently unverified by the suite — with
      // empty=true, DB.trainer is [] so no trainer row renders and the roster
      // counts never surface. Swapping this for HORSE_FIXTURES keeps e2e green.
      if (select === "trainer_id") {
        sendTable(res, req.method, DB.horse, DB.horse.length);
        return;
      }

      // (c2) Posts library search: `app/(dash)/posts/page.tsx` resolves a search
      // term to horse ids with `.select("id").or(...ilike...)`. Filters are
      // ignored here (as everywhere in this mock), so every fixture id comes
      // back — that is the same "search matches everything" behaviour the other
      // list screens get. Explicit branch so it doesn't land in the (g) net.
      if (select === "id") {
        sendTable(res, req.method, HORSE_FIXTURES, HORSE_FIXTURES.length);
        return;
      }

      // (d) Horses list: unique marker `follows:follow(count)`.
      if (select.includes("follows:follow(count)")) {
        sendTable(res, req.method, HORSE_FIXTURES, HORSE_FIXTURES.length);
        return;
      }

      // (e) Compose picker: unique marker `trainer:trainer_id(id,name,display_name)`.
      // Checked BEFORE the dashboard branch — compose also filters status=eq.active.
      if (select.includes("trainer:trainer_id(id,name,display_name)")) {
        sendTable(res, req.method, COMPOSE_HORSES, COMPOSE_HORSES.length);
        return;
      }

      // (e2) Racing match queue (RF4 / ENG-296): unique marker `racing_api_id`.
      // No other screen selects that column (grep-verified), and this read
      // carries no status filter, so it cannot collide with (f) below.
      if (select.includes("racing_api_id")) {
        sendTable(res, req.method, RACING_MATCH_HORSES, RACING_MATCH_HORSES.length);
        return;
      }

      // (f) Dashboard quiet-horse check: status=eq.active with none of the above
      // markers. HEAD returns the Content-Range count for `count: 'exact'` tiles.
      if (qs.includes("status=eq.active")) {
        sendTable(res, req.method, DASH_HORSES, DASH_HORSES.length);
        return;
      }

      // (g) Anything else reading horses gets the full named fixtures — never
      // the bare stubs. A new screen landing here renders real data instead of
      // failing silently; add an explicit branch above once it needs its own shape.
      // It logs loudly because it is a safety net, not a routing decision: a read
      // landing here means no branch claimed it, and the fixtures it gets back may
      // not be the shape that screen wants. (Found via mutation testing — this
      // fallback will happily absorb a broken branch above and keep the suite
      // green, so the warning is what makes that visible.)
      console.warn(
        `[mock-supabase] unrouted /rest/v1/horse read — serving HORSE_FIXTURES. Add an explicit branch keyed on this query: ${decodeURIComponent(qs)}`,
      );
      sendTable(res, req.method, HORSE_FIXTURES, HORSE_FIXTURES.length);
      return;
    }

    // /rest/v1/horse_match_proposal (RF4 / ENG-296). Exact table match, ahead of
    // the generic DB reader (which would not claim it today — the table is not a
    // DB key — but would the moment anyone adds one). Honours the /__control
    // empty toggle so one spec captures both the populated queue and the
    // "No pending matches." empty state.
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/rest/v1/horse_match_proposal") {
      // ANALYTICS_EMPTY is the shared /__control toggle (misnamed — it is the
      // whole mock's empty flag, set by setEmpty()).
      const rows = ANALYTICS_EMPTY ? [] : RACING_MATCH_PROPOSALS;
      sendTable(res, req.method, rows, rows.length);
      return;
    }

    // PATCH /rest/v1/horse_match_proposal — confirm/reject writes go through the
    // BFF route, which is exercised by its unit tests; here the write just needs
    // to succeed so the card leaves the queue.
    if (req.method === "PATCH" && url.pathname.startsWith("/rest/v1/horse_match_proposal")) {
      sendJson(res, 200, [{ id: "p1", status: "confirmed", resolved_at: new Date().toISOString() }]);
      return;
    }

    // /rest/v1/trainer — the `__none__` sentinel only. Every other trainer read
    // (trainers list, compose byline options, horse-edit picker) is satisfied by
    // the generic DB rows below, which also honour the /__control empty toggle.
    // Exact match again — `startsWith("/rest/v1/trainer")` would also catch
    // `trainer_contact`, which must keep falling through to the DB.
    if (req.method === "GET" && url.pathname === "/rest/v1/trainer" && url.search.includes("__none__")) {
      sendJson(res, 200, []);
      return;
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
