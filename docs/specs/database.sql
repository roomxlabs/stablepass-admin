-- ============================================================================
-- StablePass — Database Design (PostgreSQL / Supabase, Sydney ap-southeast-2)
-- Generated from the Stage 1 blueprint (Data Model 02, API 03, Auth/RBAC 04,
-- Content Model 07). Decision cross-references (§6.x) point at Data Model 02.
--
-- Conventions:
--   * UUID primary keys everywhere (uuid v4), except app_user.id which EQUALS
--     the Supabase auth.users id (1:1, no separate join).
--   * All timestamps are timestamptz (UTC, stored with zone).
--   * Enums are text columns with CHECK constraints (readable in queries;
--     adding a value is a small, reviewable migration).
--   * Money is integer cents (bigint) — never a float.
--   * No owner PII exists on ANY table — a structural invariant (§6.6).
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ============================================================================
-- 1. USERS & AUTH
-- ============================================================================

-- A paying / trialling end user. id == Supabase auth.users id (1:1, no join).
create table app_user (
    id          uuid primary key,                       -- == auth.users.id
    name        text        not null,                    -- display name at sign-up
    email       text        not null unique,             -- email/password login id
    phone       text,                                    -- captured at sign-up
    is_admin    boolean     not null default false,      -- true only for the operator (Justin)
    -- Global notification-type preferences (Account screen master switches).
    -- A push fires only if the per-type pref is on AND a notify_optin matches.
    pref_new_post    boolean not null default true,
    pref_race_day    boolean not null default true,
    pref_race_result boolean not null default true,
    pref_milestone   boolean not null default true,
    created_at  timestamptz not null default now()
);

-- Access & billing state — strict 1:1 with subscriber. Single source of truth
-- for access: rule is status IN ('trial','active'). Stripe ids null until
-- conversion (§6.3). One flat monthly plan (~A$19), 30-day no-card trial.
create table subscription (
    id                     uuid        primary key default gen_random_uuid(),
    user_id          uuid        not null unique references app_user(id) on delete cascade,
    status                 text        not null default 'trial'
                               check (status in ('trial','active','lapsed','canceled')),
    trial_ends_at          timestamptz not null,         -- now() + 30 days at sign-up
    stripe_customer_id     text,                          -- null until conversion
    stripe_subscription_id text,                          -- null until conversion
    current_period_end     timestamptz,                   -- canceled keeps access until this
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

-- ============================================================================
-- 2. TRAINERS  (content sources, NOT users — no login, no auth row)
-- ============================================================================

create table trainer (
    id           uuid        primary key default gen_random_uuid(),
    name         text        not null,
    display_name text,                                    -- usually same as name (admin form)
    slug         text        not null unique,             -- URL-safe page identifier
    stable_name  text,                                    -- e.g. "Chris Waller Racing"
    location     text,                                    -- e.g. "Rosehill, NSW"
    bio          text,
    photo_url    text,
    status       text        not null default 'active'    -- roster state (admin list filter)
                     check (status in ('active','onboarding')),
    created_at   timestamptz not null default now()
);

-- Internal contact records for a trainer + key staff (racing manager, foreman).
-- ADMIN-ONLY, never subscriber-facing (§6.10). Internal staff PII lives here.
create table trainer_contact (
    id          uuid        primary key default gen_random_uuid(),
    trainer_id  uuid        not null references trainer(id) on delete cascade,
    role        text        not null,                    -- free text: Trainer, Racing Manager, …
    name        text        not null,
    email       text,
    phone       text,
    created_at  timestamptz not null default now()
);

-- ============================================================================
-- 3. HORSES  (the heart of the product)
-- ============================================================================

-- One horse, one trainer (fixed for life of row, §6.1). id is stable through
-- the foal→named transition (§6.2). Age is COMPUTED from foaling_year on the
-- 1-Aug racing birthday — never stored (§6.8). Race stats manual at launch (§6.9).
create table horse (
    id               uuid        primary key default gen_random_uuid(),
    trainer_id       uuid        not null references trainer(id),
    status           text        not null default 'active'
                         check (status in ('active','disabled')),          -- platform visibility
    training_status  text        not null default 'spelling'
                         check (training_status in                           -- journey incl. retirement
                             ('spelling','pre_training','farm_training','city_training','racing','retired')),
    sire             text,                                                   -- breeding — father
    dam              text,                                                   -- breeding — mother
    display_name     text        not null,                                  -- "sire × dam" while unnamed
    racing_name      text,                                                   -- set once named
    stable_name      text,                                                   -- optional barn nickname
    sex              text,                                                   -- gelding, colt, filly, mare, stallion
    colour           text,
    foaling_year     integer,                                               -- age derived from this
    racing_api_id    text,                                                   -- future feed match key
    starts           integer     not null default 0,                        -- manual stat (§6.9)
    wins             integer     not null default 0,
    places           integer     not null default 0,
    prize_money_cents bigint     not null default 0,                        -- cents, no float
    story            text,                                                   -- landing-page narrative
    photo_url        text,
    created_at       timestamptz not null default now(),
    disabled_at      timestamptz                                            -- set when status→disabled
);

-- ============================================================================
-- 4. POSTS  (a unit of content attached to a horse)
-- ============================================================================

-- Lifecycle draft → scheduled → published → unpublished (soft hide, never
-- hard-deleted, §6.11). like_count is denormalised for feed ranking (§6.4).
create table post (
    id                uuid        primary key default gen_random_uuid(),
    horse_id          uuid        not null references horse(id),
    type              text        not null
                          check (type in ('video','photo','text','voice','news')),
    status            text        not null default 'draft'
                          check (status in ('draft','scheduled','published','unpublished')),
    title             text,
    body              text,                                                  -- caption / text body
    mux_asset_id      text,                                                  -- video posts
    mux_playback_id   text,                                                  -- signed playback handle
    media_url         text,                                                  -- photo / voice storage URL
    source_trainer_id uuid        not null references trainer(id),           -- attribution / consent (§6.6)
    watermarked       boolean     not null default false,
    like_count        integer     not null default 0,                        -- denormalised (§6.4)
    scheduled_for     timestamptz,                                           -- when status = scheduled
    published_at      timestamptz,
    unpublished_at    timestamptz,
    expires_at        timestamptz,                                           -- optional auto-hide
    created_at        timestamptz not null default now()
);

-- ============================================================================
-- 5. ENGAGEMENT  (a subscriber's own rows — RLS: user_id = auth.uid())
-- ============================================================================

-- "Follow" == "favorite" — one concept, one table. Target is a trainer OR a
-- horse, two nullable FKs with a CHECK that exactly one is set (§6.5).
create table follow (
    id            uuid        primary key default gen_random_uuid(),
    user_id uuid        not null references app_user(id) on delete cascade,
    trainer_id    uuid        references trainer(id) on delete cascade,
    horse_id      uuid        references horse(id) on delete cascade,
    created_at    timestamptz not null default now(),
    constraint follow_exactly_one_target check (num_nonnulls(trainer_id, horse_id) = 1),
    constraint follow_no_duplicate       unique (user_id, trainer_id, horse_id)
);

-- Push opt-in, kept separate from follow (§6.5). Targets a horse OR a trainer
-- (trainer opt-in = notify for all that trainer's horses), mirroring `follow`'s
-- two-nullable-FK + CHECK shape so both keep real referential integrity.
create table notify_optin (
    id            uuid        primary key default gen_random_uuid(),
    user_id       uuid        not null references app_user(id) on delete cascade,
    trainer_id    uuid        references trainer(id) on delete cascade,      -- set when opting into a trainer
    horse_id      uuid        references horse(id)   on delete cascade,      -- set when opting into a horse
    created_at    timestamptz not null default now(),
    constraint notify_exactly_one_target check (num_nonnulls(trainer_id, horse_id) = 1),
    constraint notify_no_duplicate       unique (user_id, trainer_id, horse_id)
);

-- Saved posts, newest-first, no limit. Composite PK prevents double-bookmark.
create table bookmark (
    user_id uuid        not null references app_user(id) on delete cascade,
    post_id       uuid        not null references post(id) on delete cascade,
    created_at    timestamptz not null default now(),                        -- sort key
    primary key (user_id, post_id)
);

-- One positive reaction per post per subscriber (§6.13). Curated allow-list.
-- Add/remove moves post.like_count. Composite PK enforces one-per-post-per-user.
create table reaction (
    user_id uuid        not null references app_user(id) on delete cascade,
    post_id       uuid        not null references post(id) on delete cascade,
    emoji         text        not null                                       -- 👍❤️👏🙏🔥💪🐎 (operator finalises)
                      check (emoji in ('like','love','clap','pray','fire','flex','horse')),
    created_at    timestamptz not null default now(),
    primary key (user_id, post_id)
);

-- Records what the feed has shown a subscriber so it isn't re-shown (§6.4).
-- Highest-volume table; prune/rotation window finalised in Stage 2.
create table impression (
    user_id uuid        not null references app_user(id) on delete cascade,
    post_id       uuid        not null references post(id) on delete cascade,
    seen_at       timestamptz not null default now(),
    primary key (user_id, post_id)
);

-- ============================================================================
-- 6. RACE  (manual at launch; API-ready for a licensed feed later, §6.2)
-- ============================================================================

-- A race EVENT — shared, so several platform horses can run in the same race
-- (normalised: race event ⇄ race_horse runner ⇄ horse). Entered BEFORE it runs
-- (feed "Race Day" + horse "Next race" card), flipped finished once results are
-- in. Admin creates this directly (race-first) OR it is find-or-created from the
-- horse-first flow, deduped on (venue, race_date, race_number).
create table race (
    id              uuid        primary key default gen_random_uuid(),
    status          text        not null default 'upcoming'
                        check (status in ('upcoming','finished')),
    venue           text,                                                    -- e.g. "Randwick"
    race_date       date        not null,
    race_number     integer,                                                 -- R5
    race_class      text,                                                    -- grade/class: Maiden, BM78, G2
    distance_m      integer,                                                 -- e.g. 1400
    scheduled_at    timestamptz,                                             -- jump time (drives 2h-before alert)
    racing_api_ref  text,                                                    -- feed ref for the event; null while manual
    source          text        not null default 'manual'
                        check (source in ('manual','api')),
    finished_at     timestamptz,                                             -- set when the race concludes
    created_at      timestamptz not null default now(),
    -- dedup key for the horse-first find-or-create (nulls don't dedup):
    constraint race_natural_key unique (venue, race_date, race_number)
);

-- A horse's RUN in a race (the junction + per-runner attributes). One row per
-- (race, horse); barrier / jockey / result are per-runner. This is what the
-- product actually tracks — a platform horse's participation — while `race`
-- carries the shared event. The full field of non-platform runners is NOT
-- stored (licensing; link out instead).
create table race_horse (
    id              uuid        primary key default gen_random_uuid(),
    race_id         uuid        not null references race(id) on delete cascade,
    horse_id        uuid        not null references horse(id) on delete cascade,
    barrier         integer,                                                 -- barrier draw (per runner)
    jockey          text,                                                    -- e.g. "T. Berry" (per runner)
    result          text,                                                    -- free text, e.g. "2nd of 12"; null until run
    finish_position integer,                                                 -- optional numeric placing
    racing_api_ref  text,                                                    -- per-runner feed match (via horse.racing_api_id)
    created_at      timestamptz not null default now(),
    constraint race_horse_unique unique (race_id, horse_id)                  -- a horse runs once per race
);

-- ============================================================================
-- 7. NOTIFICATIONS  (content events → subscribers; Expo push + in-app red-dot)
-- ============================================================================

-- (target_type, target_id) points at the originating race/post. Acceptable
-- here (write-once log) where a polymorphic key is NOT acceptable on follow.
create table notification (
    id            uuid        primary key default gen_random_uuid(),
    user_id uuid        not null references app_user(id) on delete cascade,
    type          text        not null                                       -- race_day = 2h-before reminder
                      check (type in ('new_post','race_day','race_result','milestone')),
    target_type   text        not null,                                      -- 'race' | 'post' | 'horse'
    target_id     uuid        not null,
    title         text        not null,
    body          text        not null,
    read          boolean     not null default false,                        -- drives in-app red-dot
    pushed        boolean     not null default false,                        -- Expo push dispatched
    created_at    timestamptz not null default now()
);

-- A registered Expo push token for one device. A subscriber may have several.
create table device_token (
    id            uuid        primary key default gen_random_uuid(),
    user_id uuid        not null references app_user(id) on delete cascade,
    expo_token    text        not null,
    platform      text        not null check (platform in ('ios','android')),
    created_at    timestamptz not null default now(),
    last_seen_at  timestamptz not null default now()                         -- prune stale tokens
);

-- ============================================================================
-- 8. INDEXES  (foreign keys + hot query paths)
-- ============================================================================

create index idx_subscription_user   on subscription(user_id);
create index idx_trainer_contact_trainer   on trainer_contact(trainer_id);
create index idx_horse_trainer             on horse(trainer_id);
create index idx_horse_status              on horse(status);
create index idx_post_horse                on post(horse_id);
create index idx_post_source_trainer       on post(source_trainer_id);
create index idx_post_status               on post(status);
create index idx_post_scheduled_for        on post(scheduled_for) where status = 'scheduled';
-- Ranked-feed read path (published-only, ranked by like_count + recency):
create index idx_post_feed                 on post(status, like_count desc, published_at desc);
create index idx_follow_user         on follow(user_id);
create index idx_follow_trainer            on follow(trainer_id);
create index idx_follow_horse              on follow(horse_id);
create index idx_notify_optin_user         on notify_optin(user_id);
create index idx_notify_optin_horse        on notify_optin(horse_id);
create index idx_notify_optin_trainer      on notify_optin(trainer_id);
create index idx_bookmark_post             on bookmark(post_id);
create index idx_reaction_post             on reaction(post_id);
create index idx_impression_post           on impression(post_id);
create index idx_race_scheduled            on race(scheduled_at) where status = 'upcoming';  -- 2h-before sweep
create index idx_race_day                  on race(race_date, status);                        -- Race Day feed
create index idx_race_horse_race           on race_horse(race_id);
create index idx_race_horse_horse          on race_horse(horse_id);                           -- a horse's race history
create index idx_notification_user   on notification(user_id, read);
create index idx_device_token_user   on device_token(user_id);

-- ============================================================================
-- Notes on RLS (specified in full in Auth & RBAC 04 — the access boundary):
--   * Content (trainer/horse/post/race): subscriber SELECT only when the row is
--     published AND their subscription.status IN ('trial','active'); admin all.
--   * Engagement tables: subscriber SELECT/INSERT/DELETE only rows where
--     user_id = auth.uid(); admin SELECT all (analytics).
--   * subscription & notification writes go through the service role only.
--   * trainer_contact is admin-only for every operation.
-- ============================================================================
