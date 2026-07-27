import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactElement } from "react";

// Guardrail test for the forced-enrolment page's INLINE gate (ENG-371).
//
// This page cannot use requireAdminPage(): that helper redirects an AAL1 admin
// with no factor to /signin/mfa-setup, i.e. to itself — an infinite redirect.
// So the gate is written out by hand here, and this file is what proves it
// still denies everyone requireAdminPage() would have denied:
//   no session -> /signin, non-admin -> /signin?error=forbidden,
//   already-enrolled -> onward, and NO factor is ever created in those cases.
//
// NOTE ON `aal`: the shared `lib/testing/supabase-fake.ts` defaults `aal` to
// "aal2" so A1 could add the gate without rewriting every older route test.
// This screen's whole subject is the AAL1-with-no-factor admin, so that default
// would quietly exercise the wrong branch and pass for the wrong reason. This
// file hand-rolls its client and sets `aal` EXPLICITLY in every test.
type Factor = { id: string; factor_type: string; status: string };

const state: {
  user: { id: string; email?: string } | null;
  isAdmin: boolean | null;
  aal: "aal1" | "aal2";
  factors: Factor[];
  listFails: boolean;
  enrollFails: boolean;
  enrollNoTotp: boolean;
  trace: string[];
  reads: string[];
} = {
  user: null,
  isAdmin: null,
  aal: "aal1",
  factors: [],
  listFails: false,
  enrollFails: false,
  enrollNoTotp: false,
  trace: [],
  reads: [],
};

const QR_DATA_URI = "data:image/svg+xml;utf-8,<svg/>";
const SECRET = "JBSWY3DPEHPK3PXP";

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      mfa: {
        listFactors: async () =>
          state.listFails
            ? { data: null, error: { message: "network" } }
            : {
                data: {
                  all: state.factors,
                  totp: state.factors.filter((f) => f.status === "verified"),
                  phone: [],
                },
                error: null,
              },
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: state.aal, nextLevel: "aal2", currentAuthenticationMethods: [] },
          error: null,
        }),
        unenroll: async ({ factorId }: { factorId: string }) => {
          state.trace.push(`unenroll:${factorId}`);
          return { data: { id: factorId }, error: null };
        },
        enroll: async () => {
          state.trace.push("enroll");
          // A 200 whose body carries no `totp` — what a proxy, or the shared e2e
          // mock's catch-all `200 {}`, actually returns. Distinct from the
          // {data:null,error} shape, and the case that would throw on
          // `.qr_code` if the page guarded only on `error`.
          if (state.enrollNoTotp) {
            return { data: { id: "factor-new", type: "totp" }, error: null };
          }
          return state.enrollFails
            ? { data: null, error: { message: "too many factors" } }
            : {
                data: {
                  id: "factor-new",
                  type: "totp",
                  totp: { qr_code: QR_DATA_URI, secret: SECRET, uri: "otpauth://totp/x" },
                },
                error: null,
              };
        },
      },
    },
    // Records the FILTER, not just the result. A builder that swallows its
    // arguments would let `.eq("id", <anyone else>)` pass every assertion here
    // — i.e. it could not tell an authz check scoped to the caller from one
    // reading a stranger's row. `reads` is kept separate from `trace` so the
    // deny tests can still assert `trace === []` for "no factor was created".
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => {
          state.reads.push(`${table}.${col}=${val}`);
          return {
            single: async () => ({
              data: state.isAdmin === null ? null : { is_admin: state.isAdmin },
              error: null,
            }),
          };
        },
      }),
    }),
  }),
}));

class RedirectError extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

import MfaSetupPage from "./page";

// Walk the returned element tree so we can assert what the screen actually
// renders, not merely that enroll() was called.
function collect(node: unknown, out: { text: string[]; imgs: string[] }): void {
  if (node == null || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  const props = el.props ?? {};
  if (el.type === "img" && typeof props.src === "string") out.imgs.push(props.src);
  if ("children" in props) collect(props.children, out);
}

async function render() {
  const tree = await MfaSetupPage();
  const out = { text: [] as string[], imgs: [] as string[] };
  collect(tree, out);
  return out;
}

beforeEach(() => {
  state.user = { id: "u1", email: "ops@stablepass.co" };
  state.isAdmin = true;
  state.aal = "aal1"; // the case this screen exists for — never left to a default
  state.factors = [];
  state.listFails = false;
  state.enrollFails = false;
  state.enrollNoTotp = false;
  state.trace = [];
  state.reads = [];
});

describe("mfa-setup gate — who never sees a QR", () => {
  it("redirects a visitor with no session to /signin and enrols nothing", async () => {
    state.user = null;
    state.aal = "aal1";
    await expect(MfaSetupPage()).rejects.toThrow("REDIRECT:/signin");
    expect(state.trace).toEqual([]);
  });

  it("redirects a signed-in NON-admin to /signin?error=forbidden and enrols nothing", async () => {
    state.isAdmin = false;
    state.aal = "aal1";
    await expect(MfaSetupPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
    expect(state.trace).toEqual([]);
  });

  it("treats a missing app_user row as not-an-admin (fails closed)", async () => {
    state.isAdmin = null;
    state.aal = "aal1";
    await expect(MfaSetupPage()).rejects.toThrow("REDIRECT:/signin?error=forbidden");
    expect(state.trace).toEqual([]);
  });

  it("reads the is_admin flag of THIS caller, not of some other row", async () => {
    // Without this, `.eq("id", <anything>)` satisfies every other assertion in
    // the file — the gate would authorise a visitor against a stranger's row
    // and the suite would stay green.
    state.user = { id: "u-caller", email: "ops@stablepass.co" };
    state.isAdmin = true;
    state.aal = "aal1";
    await render();
    expect(state.reads).toEqual(["app_user.id=u-caller"]);
  });
});

describe("mfa-setup gate — who is already done", () => {
  it("sends an aal2 admin with a verified factor to the dashboard", async () => {
    state.aal = "aal2";
    state.factors = [{ id: "f1", factor_type: "totp", status: "verified" }];
    await expect(MfaSetupPage()).rejects.toThrow("REDIRECT:/");
    expect(state.trace).toEqual([]);
  });

  it("sends an aal1 admin who already has a verified factor to the challenge, not a second enrolment", async () => {
    state.aal = "aal1";
    state.factors = [{ id: "f1", factor_type: "totp", status: "verified" }];
    await expect(MfaSetupPage()).rejects.toThrow("REDIRECT:/signin/mfa");
    expect(state.trace).toEqual([]);
  });

  it("hands an unreadable factor list to the challenge screen rather than enrolling blind", async () => {
    state.aal = "aal1";
    state.listFails = true;
    await expect(MfaSetupPage()).rejects.toThrow("REDIRECT:/signin/mfa");
    expect(state.trace).toEqual([]);
  });
});

describe("mfa-setup — the enrolling admin stays here", () => {
  it("renders the QR data-URI and the secret for an AAL1 admin with no factor", async () => {
    state.aal = "aal1";
    state.factors = [];
    const out = await render();
    expect(state.trace).toEqual(["enroll"]);
    expect(out.imgs).toContain(QR_DATA_URI);
    expect(out.text).toContain(SECRET);
    expect(out.text.join(" ")).toContain("Set up 2FA.");
  });

  it("unenrolls a stale unverified factor BEFORE enrolling a fresh one", async () => {
    // Otherwise every abandoned visit stacks another dead factor and the admin
    // eventually hits the enrolled-factor cap.
    state.aal = "aal1";
    state.factors = [{ id: "stale-1", factor_type: "totp", status: "unverified" }];
    await render();
    expect(state.trace).toEqual(["unenroll:stale-1", "enroll"]);
  });

  it("clears every stale factor, not just the first", async () => {
    state.aal = "aal1";
    state.factors = [
      { id: "stale-1", factor_type: "totp", status: "unverified" },
      { id: "stale-2", factor_type: "totp", status: "unverified" },
    ];
    await render();
    expect(state.trace).toEqual(["unenroll:stale-1", "unenroll:stale-2", "enroll"]);
  });

  it("shows a recoverable error instead of a broken QR when enrolment fails", async () => {
    state.aal = "aal1";
    state.enrollFails = true;
    const out = await render();
    expect(out.imgs).not.toContain(QR_DATA_URI);
    expect(out.text.join(" ")).toMatch(/couldn't start enrolment/i);
  });

  it("survives a 200 whose body carries no totp payload, rather than 500-ing", async () => {
    // Guards the PAYLOAD as well as the error. Reaching `.qr_code` on a body
    // without `totp` throws, and this is the one screen an admin cannot route
    // around — a 500 here is a hard lockout, not a degraded page.
    state.aal = "aal1";
    state.enrollNoTotp = true;
    const out = await render();
    expect(out.imgs).not.toContain(QR_DATA_URI);
    expect(out.text.join(" ")).toMatch(/couldn't start enrolment/i);
  });
});
