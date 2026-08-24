// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TrainerForm, { type TrainerData } from "./TrainerForm";
import { WEBSITE_URL_MESSAGE } from "@/lib/trainers/website-url";

// ENG-766 — the "Show on marketing site" toggle and the public photo copy.
//
// The Supabase BROWSER client is faked rather than the ./marketingPhoto module,
// so these tests exercise the real copy path and can assert the actual storage
// calls the ticket names: signed read from the PRIVATE bucket, upload into the
// PUBLIC one, delete on un-publish.

const h = vi.hoisted(() => ({
  storage: [] as {
    bucket: string;
    op: string;
    path?: string;
    paths?: string[];
    // ENG-749: what was actually PUT. The whole point of the crop is that the
    // bytes change, so a test that only checks the path proves nothing.
    body?: unknown;
    contentType?: string;
  }[],
  script: {
    uploadError: null as { message: string } | null,
    removeError: null as { message: string } | null,
    contactsThrow: false,
    // ENG-749. jsdom implements no canvas, so the shipped fallback (upload the
    // original) is what runs by default — which is exactly the behaviour every
    // pre-existing test in this file was written against. Flipping this on
    // simulates a real browser so the crop path itself can be exercised.
    canvas: false,
    cropBlob: null as Blob | null,
    // ENG-749: how many times the picked file was decoded. A second decode
    // means the load effect re-ran, which resets the admin's framing.
    loads: 0,
    // ENG-746: script the CREATE response so the 409 branch can be exercised.
    // Carries the status AND the server's own envelope, so a test can prove the
    // form substitutes its own honest copy for a 409 while still passing the
    // server's message straight through for any other 4xx.
    createFailure: null as { status: number; code: string; message: string } | null,
  },
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
// ENG-749 — ONLY the canvas half is mocked. The crop arithmetic in
// photoCrop.ts stays real (it is covered for its own sake in photoCrop.test.ts),
// so these tests exercise the actual rect the component computes and hand it to
// a stand-in encoder. jsdom cannot run `getContext`, so there is no version of
// this that encodes real bytes here — that is what the Playwright shots prove.
vi.mock("../components/photoCropCanvas", () => ({
  canvasSupported: () => h.script.canvas,
  loadImage: async () => {
    h.script.loads += 1;
    return h.script.canvas
      ? {
          el: {} as HTMLImageElement,
          url: "blob:crop-source",
          width: 4000,
          height: 2000,
          release: () => {},
        }
      : null;
  },
  cropToBlob: async () => h.script.cropBlob,
}));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          h.storage.push({ bucket, op: "createSignedUrl", path });
          return { data: { signedUrl: `https://signed.local/${bucket}/${path}` }, error: null };
        },
        upload: async (path: string, body: unknown, opts?: { contentType?: string }) => {
          h.storage.push({ bucket, op: "upload", path, body, contentType: opts?.contentType });
          // Only the PUBLIC bucket honours the scripted failure; the form's own
          // upload into the private bucket must still succeed, otherwise a test
          // that needs a photo to copy could never get one.
          return { data: null, error: bucket === "marketing-photos" ? h.script.uploadError : null };
        },
        remove: async (paths: string[]) => {
          h.storage.push({ bucket, op: "remove", paths });
          // Mirrors storage-api: the response lists the rows actually removed.
          return { data: paths.map((name) => ({ name })), error: h.script.removeError };
        },
      }),
    },
  }),
}));

const NEW_ID = "99999999-8888-7777-6666-555555555555";
const EDIT_ID = "11111111-2222-3333-4444-555555555555";

type Bff = { url: string; method?: string; body: Record<string, unknown> | null };
let bff: Bff[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      // The signed download of the private original.
      if (u.startsWith("https://signed.local/")) return { ok: true, blob: async () => ({ type: "image/jpeg" }) };
      // A network drop on the contacts write, mid-save.
      if (h.script.contactsThrow && u.includes("/contacts")) throw new TypeError("Failed to fetch");
      bff.push({
        url: u,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (u === "/api/admin/trainers") {
        const f = h.script.createFailure;
        if (f)
          return {
            ok: false,
            status: f.status,
            json: async () => ({ error: { code: f.code, message: f.message } }),
          };
        return { ok: true, status: 201, json: async () => ({ data: { id: NEW_ID } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: {} }) };
    }),
  );
}

function editTrainer(over: Partial<TrainerData> = {}): TrainerData {
  return {
    id: EDIT_ID,
    name: "Chris Waller",
    displayName: "Chris Waller",
    stableName: "Chris Waller Racing",
    location: "Rosehill, NSW",
    bio: "Leading Sydney trainer.",
    photoUrl: "chris-waller-172.jpg",
    status: "active",
    marketingVisible: false,
    marketingPhotoPath: null,
    websiteUrl: null,
    ...over,
  };
}

const patches = () => bff.filter((c) => c.method === "PATCH" && c.url.startsWith("/api/admin/trainers/"));
const toggle = () => screen.getByTestId("marketing-visible") as HTMLInputElement;
const website = () => screen.getByTestId("trainer-website") as HTMLInputElement;

beforeEach(() => {
  h.storage.length = 0;
  h.script.uploadError = null;
  h.script.removeError = null;
  h.script.contactsThrow = false;
  h.script.createFailure = null;
  h.script.canvas = false;
  h.script.cropBlob = null;
  h.script.loads = 0;
  bff = [];
  push.mockClear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TrainerForm — the marketing toggle renders and seeds", () => {
  it("renders unchecked on a new trainer (nothing publishes by accident)", () => {
    render(<TrainerForm mode="create" />);
    expect(toggle().checked).toBe(false);
    expect(screen.getByText("Show on marketing site")).toBeTruthy();
  });

  it("carries the helper copy naming what gets published", () => {
    render(<TrainerForm mode="create" />);
    expect(
      screen.getByText(/Publishes this trainer's name, location, bio, horses and photo on stablepass\.co\./),
    ).toBeTruthy();
  });

  it("seeds from the saved trainer when already published", () => {
    render(<TrainerForm mode="edit" trainer={editTrainer({ marketingVisible: true })} contacts={[]} />);
    expect(toggle().checked).toBe(true);
  });

  it("keeps the control OUT of the Contacts block (contacts are internal, this is public)", () => {
    // Guardrail #3: trainer_contact is admin-only. The marketing control must not
    // sit in, or read anything from, that block.
    render(<TrainerForm mode="edit" trainer={editTrainer()} contacts={[]} />);
    const contactsCard = screen.getByText("Contacts").closest(".adm-card");
    expect(contactsCard).toBeTruthy();
    expect(contactsCard!.contains(toggle())).toBe(false);
    expect(screen.getByText("Marketing site").closest(".adm-card")!.contains(toggle())).toBe(true);
  });

  it("warns that the site will show initials when published with no photo", () => {
    render(<TrainerForm mode="edit" trainer={editTrainer({ photoUrl: null })} contacts={[]} />);
    fireEvent.click(toggle());
    expect(screen.getByTestId("marketing-no-photo")).toBeTruthy();
  });
});

describe("TrainerForm — saving with the toggle ON copies the photo", () => {
  it("signs the private original, uploads to the PUBLIC bucket and PATCHes the path", async () => {
    render(<TrainerForm mode="edit" trainer={editTrainer()} contacts={[]} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));

    // The profile save carries the flag…
    expect(patches()[0].body!.marketingVisible).toBe(true);
    // …the bytes go private → public, direct to storage…
    const signed = h.storage.find((c) => c.op === "createSignedUrl" && c.bucket === "trainer-photos");
    expect(signed?.path).toBe("chris-waller-172.jpg");
    const up = h.storage.find((c) => c.op === "upload");
    expect(up).toMatchObject({ bucket: "marketing-photos", path: `trainers/${EDIT_ID}.jpg` });
    // …and the resulting public path is recorded.
    expect(patches().at(-1)!.body!.marketingPhotoPath).toBe(`trainers/${EDIT_ID}.jpg`);
  });

  it("copies for a brand-new trainer against the id the create returned", async () => {
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    const created = bff.find((c) => c.url === "/api/admin/trainers");
    expect(created!.body!.marketingVisible).toBe(true);
    // No photo on a fresh create, so there is nothing to copy and no path to set.
    expect(h.storage.some((c) => c.op === "upload")).toBe(false);
  });

  it("never uploads anything while the toggle stays off", async () => {
    render(<TrainerForm mode="edit" trainer={editTrainer()} contacts={[]} />);
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    expect(patches()[0].body!.marketingVisible).toBe(false);
    // A save with the toggle off still sweeps the public bucket (cheap,
    // idempotent, and the only way to be sure nothing was left behind by an
    // earlier half-completed publish) — but it must never PUT anything there.
    expect(h.storage.filter((c) => c.op === "upload")).toHaveLength(0);
    // …and it really does sweep. Without this the comment above was the only
    // thing asserting it, so reverting the sweep left this test green.
    expect(h.storage.some((c) => c.op === "remove" && c.bucket === "marketing-photos")).toBe(true);
  });
});

describe("TrainerForm — toggling OFF removes the published photo", () => {
  it("deletes the public object and nulls the stored path", async () => {
    const published = `trainers/${EDIT_ID}.jpg`;
    render(
      <TrainerForm
        mode="edit"
        trainer={editTrainer({ marketingVisible: true, marketingPhotoPath: published })}
        contacts={[]}
      />,
    );
    fireEvent.click(toggle()); // ON -> OFF
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));

    expect(patches()[0].body!.marketingVisible).toBe(false);
    const removed = h.storage.find((c) => c.op === "remove");
    expect(removed!.bucket).toBe("marketing-photos");
    // The sweep is keyed off the trainer id, so it covers the published object
    // AND any stale one a half-completed earlier publish left behind.
    expect(removed!.paths).toContain(published);
    expect(patches().at(-1)!.body!.marketingPhotoPath).toBeNull();
  });
});

describe("TrainerForm — a failed copy never blocks the save", () => {
  it("keeps the save, leaves the path null and offers a retry", async () => {
    h.script.uploadError = { message: "storage unavailable" };
    render(<TrainerForm mode="edit" trainer={editTrainer()} contacts={[]} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const warning = await screen.findByTestId("marketing-photo-warning");
    // The storage reason is surfaced: a permanent rejection (too large, wrong
    // format) must not read as an endlessly retryable transient failure.
    expect(warning.textContent).toMatch(/could not be published/i);
    expect(warning.textContent).toContain("storage unavailable");

    // The profile save itself went through with the flag set…
    expect(patches()[0].body!.marketingVisible).toBe(true);
    // …no path was recorded…
    expect(patches().some((c) => "marketingPhotoPath" in (c.body ?? {}))).toBe(false);
    // …and we stayed on the form so the admin can retry.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("retry-publish")).toBeTruthy();
  });

  it("retry re-runs ONLY the copy, never the profile save", async () => {
    h.script.uploadError = { message: "storage unavailable" };
    render(<TrainerForm mode="edit" trainer={editTrainer()} contacts={[]} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("submit-trainer"));
    await screen.findByTestId("marketing-photo-warning");

    const profilePatches = patches().filter((c) => "marketingVisible" in (c.body ?? {})).length;
    h.script.uploadError = null; // the retry succeeds
    fireEvent.click(screen.getByTestId("retry-publish"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    expect(patches().filter((c) => "marketingVisible" in (c.body ?? {}))).toHaveLength(profilePatches);
    expect(patches().at(-1)!.body!.marketingPhotoPath).toBe(`trainers/${EDIT_ID}.jpg`);
  });

  // Regression: `savedId` used to be recorded only AFTER `saveContacts`, and
  // onSubmit had no catch. A network drop writing contacts therefore unwound
  // past it silently — no message, button re-enabled — and the next submit
  // created a SECOND trainer even though the first was already committed.
  it("re-submitting after the contacts write THROWS updates, it does not create again", async () => {
    h.script.contactsThrow = true;
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    // Give contact 1 a name so saveContacts actually issues a request.
    fireEvent.change(screen.getAllByPlaceholderText("e.g. Sam Freedman")[0], {
      target: { value: "Chris Waller" },
    });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(bff.filter((c) => c.url === "/api/admin/trainers")).toHaveLength(1));
    // The failure must be visible rather than silently re-enabling the button.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/went wrong/i));

    h.script.contactsThrow = false;
    fireEvent.click(screen.getByTestId("submit-trainer"));
    await waitFor(() =>
      expect(bff.some((c) => c.url === `/api/admin/trainers/${NEW_ID}` && c.method === "PATCH")).toBe(true),
    );
    expect(bff.filter((c) => c.url === "/api/admin/trainers")).toHaveLength(1);
  });

  // Regression: `isEdit` came from the props and never updated, so after a
  // create whose copy failed, saving again POSTed a SECOND trainer — and the
  // 409 handler told the admin to change the name, which made that second
  // trainer succeed. Two live trainers from one failed photo copy.
  it("re-submitting after a failed copy on CREATE updates, it does not create again", async () => {
    h.script.uploadError = { message: "storage unavailable" };
    const { container } = render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });

    // A photo must exist for the copy to be attempted at all.
    const file = new File(["x"], "waller.jpg", { type: "image/jpeg" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByText("Photo added");

    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("submit-trainer"));
    await waitFor(() => expect(bff.filter((c) => c.url === "/api/admin/trainers")).toHaveLength(1));

    // Second submit, exactly as an admin who did not notice the warning would.
    fireEvent.click(screen.getByTestId("submit-trainer"));
    await waitFor(() =>
      expect(bff.some((c) => c.url === `/api/admin/trainers/${NEW_ID}` && c.method === "PATCH")).toBe(true),
    );
    expect(bff.filter((c) => c.url === "/api/admin/trainers")).toHaveLength(1);
  });
});

describe("TrainerForm — the Website field (ENG-746)", () => {
  it("renders empty on a new trainer", () => {
    render(<TrainerForm mode="create" />);
    expect(website().value).toBe("");
    expect(screen.getByText("Website")).toBeTruthy();
  });

  it("seeds from the saved trainer", () => {
    render(
      <TrainerForm mode="edit" trainer={editTrainer({ websiteUrl: "https://wallerracing.com.au" })} contacts={[]} />,
    );
    expect(website().value).toBe("https://wallerracing.com.au");
  });

  it("keeps the field OUT of the Contacts block (contacts are internal, this is public)", () => {
    // Guardrail #3. website_url is rendered to MEMBERS by stablepass-web, while
    // trainer_contact never leaves the admin. They must not read as one group.
    render(<TrainerForm mode="edit" trainer={editTrainer()} contacts={[]} />);
    const contactsCard = screen.getByText("Contacts").closest(".adm-card");
    expect(contactsCard).toBeTruthy();
    expect(contactsCard!.contains(website())).toBe(false);
  });

  it("sends the website on create", async () => {
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    fireEvent.change(website(), { target: { value: "https://wallerracing.com.au" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    const created = bff.find((c) => c.url === "/api/admin/trainers");
    expect(created!.body!.websiteUrl).toBe("https://wallerracing.com.au");
  });

  it("trims the website before sending it", async () => {
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    fireEvent.change(website(), { target: { value: "   https://wallerracing.com.au   " } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    const created = bff.find((c) => c.url === "/api/admin/trainers");
    expect(created!.body!.websiteUrl).toBe("https://wallerracing.com.au");
  });

  it("sends null, not an empty string, when the field is left blank", async () => {
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    const created = bff.find((c) => c.url === "/api/admin/trainers");
    expect(created!.body!.websiteUrl).toBeNull();
  });

  it("CLEARS a saved website when the admin empties the field", async () => {
    // The key must still be PRESENT in the PATCH body: the route writes only the
    // keys it receives, so omitting it when empty would make clearing impossible.
    render(
      <TrainerForm mode="edit" trainer={editTrainer({ websiteUrl: "https://wallerracing.com.au" })} contacts={[]} />,
    );
    fireEvent.change(website(), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    const body = patches()[0].body!;
    expect("websiteUrl" in body).toBe(true);
    expect(body.websiteUrl).toBeNull();
  });

  it("carries a saved website through an unrelated edit untouched", async () => {
    // Regression shape: if the field failed to seed, this save would silently
    // NULL a website the admin never went near.
    render(
      <TrainerForm mode="edit" trainer={editTrainer({ websiteUrl: "https://wallerracing.com.au" })} contacts={[]} />,
    );
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller Jr" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    expect(patches()[0].body!.websiteUrl).toBe("https://wallerracing.com.au");
  });

  it("refuses a javascript: url and never sends the request", async () => {
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    fireEvent.change(website(), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(WEBSITE_URL_MESSAGE);
    // Rejected in the form, so the trainer is never written at all.
    expect(bff.some((c) => c.url === "/api/admin/trainers")).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses a bare domain, which the member app would render as no link", async () => {
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    fireEvent.change(website(), { target: { value: "wallerracing.com.au" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(WEBSITE_URL_MESSAGE);
    expect(bff.some((c) => c.url === "/api/admin/trainers")).toBe(false);
  });
});

// `trainer.website_url` is an unconstrained text column that NO admin surface has
// ever written, so any value already in it was put there by hand and may be
// something this form rejects (stablepass-web's own code anticipates a bare
// domain). Validating it on every save would hold an admin's bio fix hostage to
// a Website field they never touched, with no way out.
describe("TrainerForm — a stored website this form cannot parse (ENG-746)", () => {
  const legacy = () => editTrainer({ websiteUrl: "wallerracing.com.au" });

  it("does not block an unrelated edit, and does not rewrite the value", async () => {
    render(<TrainerForm mode="edit" trainer={legacy()} contacts={[]} />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller Jr" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    // Omitted entirely: the route writes only the keys it receives, so the
    // column keeps exactly what it had.
    expect("websiteUrl" in patches()[0].body!).toBe(false);
  });

  it("says so inline rather than tolerating it silently", () => {
    render(<TrainerForm mode="edit" trainer={legacy()} contacts={[]} />);
    expect(screen.getByTestId("website-legacy-invalid")).toBeTruthy();
  });

  it("shows no such note for a valid stored website", () => {
    render(
      <TrainerForm mode="edit" trainer={editTrainer({ websiteUrl: "https://wallerracing.com.au" })} contacts={[]} />,
    );
    expect(screen.queryByTestId("website-legacy-invalid")).toBeNull();
  });

  it("validates again as soon as the admin edits the field", async () => {
    render(<TrainerForm mode="edit" trainer={legacy()} contacts={[]} />);
    fireEvent.change(website(), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(WEBSITE_URL_MESSAGE);
    expect(push).not.toHaveBeenCalled();
  });

  it("lets the admin clear it", async () => {
    render(<TrainerForm mode="edit" trainer={legacy()} contacts={[]} />);
    fireEvent.change(website(), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    expect(patches()[0].body!.websiteUrl).toBeNull();
  });

  it("lets the admin fix it", async () => {
    render(<TrainerForm mode="edit" trainer={legacy()} contacts={[]} />);
    fireEvent.change(website(), { target: { value: "https://wallerracing.com.au" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/trainers"));
    expect(patches()[0].body!.websiteUrl).toBe("https://wallerracing.com.au");
  });
});

// ENG-746 — Mel's block. The old copy ("a matching name already exists — adjust
// the name") named neither the cause nor the safe fix.
describe("TrainerForm — the honest slug-collision message (ENG-746)", () => {
  it("names the real cause: the name becomes the trainer's unique ID", async () => {
    h.script.createFailure = { status: 409, code: "slug_taken", message: "A trainer with that slug already exists." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const alert = await screen.findByRole("alert");
    // The concrete derived value, so the admin can see WHY a name that looked
    // free was refused.
    expect(alert.textContent).toContain("chris-waller");
    expect(alert.textContent).toMatch(/unique ID/i);
  });

  it("does NOT claim the slug is a web address", async () => {
    // Regression on this ticket's own honesty. An earlier draft called the slug
    // the "profile web address" and rendered it as /chris-waller. Nothing in
    // web, admin or mobile reads trainer.slug, and the member profile resolves
    // by id, so that URL does not exist - a claim an admin could disprove from
    // the URL bar in five seconds.
    h.script.createFailure = { status: 409, code: "slug_taken", message: "A trainer with that slug already exists." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const text = (await screen.findByRole("alert")).textContent!;
    expect(text).not.toMatch(/web address/i);
    expect(text).not.toMatch(/\/chris-waller/);
    expect(text).not.toMatch(/\bURL\b/);
  });

  it("does not claim the two NAMES match, because they need not", async () => {
    // The collision is on the derived value, so "Chris Waller", "chris waller"
    // and "Chris  Waller!" all collide while looking different. That is the most
    // likely shape of the block Mel actually hit.
    h.script.createFailure = { status: 409, code: "slug_taken", message: "A trainer with that slug already exists." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "chris  waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const text = (await screen.findByRole("alert")).textContent!;
    expect(text).toMatch(/even when the names look slightly different/i);
    // …and it still shows the value that actually collided.
    expect(text).toContain("chris-waller");
  });

  it("falls through to the generic message for a 409 with a different code", async () => {
    // Only the slug collision gets the specific explanation. Any other 409 the
    // route grows later must not be explained as something it is not.
    h.script.createFailure = { status: 409, code: "some_other_conflict", message: "Conflicting change." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Conflicting change.");
  });

  it("offers both fixes, with the duplicate-safe one FIRST", async () => {
    h.script.createFailure = { status: 409, code: "slug_taken", message: "A trainer with that slug already exists." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const text = (await screen.findByRole("alert")).textContent!;
    const openExisting = text.indexOf("Trainers list");
    const rename = text.indexOf("change the full name slightly");
    expect(openExisting).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(-1);
    // Order is load-bearing, not cosmetic (ENG-766): this 409 is also reachable
    // when the trainer WAS created and the response was lost, and leading with
    // "rename" is what turns that into a second live trainer.
    expect(openExisting).toBeLessThan(rename);
  });

  it("keeps the generic message for a non-409 failure", async () => {
    h.script.createFailure = { status: 400, code: "insert_failed", message: "Location is not valid." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const alert = await screen.findByRole("alert");
    // The server's own message, verbatim, and none of the slug copy.
    expect(alert.textContent).toBe("Location is not valid.");
    expect(alert.textContent).not.toMatch(/web address/i);
  });

  it("does not parrot the server's slug wording back to the admin", async () => {
    h.script.createFailure = { status: 409, code: "slug_taken", message: "A trainer with that slug already exists." };
    render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
    fireEvent.click(screen.getByTestId("submit-trainer"));

    const text = (await screen.findByRole("alert")).textContent!;
    // "slug" is engineering vocabulary; the admin gets the cause in their terms.
    expect(text).not.toContain("slug");
  });
});

// ENG-749 — the crop step. The assertion that matters throughout is on the
// BODY handed to Storage, not the path: a crop that changed the filename and
// nothing else would pass every path-based check while storing the original
// photo, and the member surfaces would look exactly as wrong as before.
describe("TrainerForm — profile photo crop (ENG-749)", () => {
  const pick = (container: HTMLElement, file: File) =>
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

  const jpeg = () => new File(["original-jpeg-bytes"], "waller.jpg", { type: "image/jpeg" });
  const png = () => new File(["original-png-bytes"], "logo.png", { type: "image/png" });

  const privateUpload = () => h.storage.find((c) => c.op === "upload" && c.bucket === "trainer-photos");

  describe("in a browser that can crop", () => {
    beforeEach(() => {
      h.script.canvas = true;
      h.script.cropBlob = new Blob(["cropped-bytes"], { type: "image/jpeg" });
    });

    it("opens the crop step on pick and uploads NOTHING until it is resolved", async () => {
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, jpeg());

      expect(await screen.findByTestId("photo-crop-dialog")).toBeTruthy();
      expect(h.storage.filter((c) => c.op === "upload")).toHaveLength(0);
    });

    it("uploads the CROPPED blob, not the file the admin picked", async () => {
      const file = jpeg();
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, file);
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo added");

      const up = privateUpload()!;
      expect(up.body).toBe(h.script.cropBlob);
      // The original File must NOT be what was stored.
      expect(up.body).not.toBe(file);
      expect(up.body).not.toBeInstanceOf(File);
    });

    it("names the object for the BYTES, not for the picked filename", async () => {
      // ENG-766 derives the PUBLIC marketing object's key and content type from
      // this extension, so a .png key holding JPEG bytes would publish a
      // mislabelled object to a public origin. The output format follows the
      // file's TYPE, so a misnamed pick must still land on the right key.
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, new File(["x"], "misnamed.png", { type: "image/jpeg" }));
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo added");

      expect(privateUpload()!.path).toMatch(/\.jpg$/);
      expect(privateUpload()!.contentType).toBe("image/jpeg");
    });

    it("keeps a PNG a PNG when the crop preserves it, so transparency survives", async () => {
      h.script.cropBlob = new Blob(["cropped-png"], { type: "image/png" });
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, png());
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo added");

      expect(privateUpload()!.path).toMatch(/\.png$/);
      expect(privateUpload()!.contentType).toBe("image/png");
    });

    it("uploads the ORIGINAL file, unchanged, on Use as-is", async () => {
      const file = jpeg();
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, file);
      fireEvent.click(await screen.findByTestId("photo-crop-use-as-is"));
      await screen.findByText("Photo added");

      const up = privateUpload()!;
      // Identity, not content: the very same File object reaches Storage, so
      // nothing re-encoded it. This is the "byte-identical to today" criterion.
      expect(up.body).toBe(file);
      expect(up.body).toBeInstanceOf(File);
      expect(up.path).toMatch(/\.jpg$/);
    });

    it("keeps the picked file's own extension on Use as-is", async () => {
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, new File(["x"], "waller.JPEG", { type: "image/jpeg" }));
      fireEvent.click(await screen.findByTestId("photo-crop-use-as-is"));
      await screen.findByText("Photo added");

      expect(privateUpload()!.path).toMatch(/\.JPEG$/);
    });

    it("uploads nothing at all when the crop is cancelled", async () => {
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, jpeg());
      fireEvent.click(await screen.findByTestId("photo-crop-cancel"));

      await waitFor(() => expect(screen.queryByTestId("photo-crop-dialog")).toBeNull());
      expect(h.storage.filter((c) => c.op === "upload")).toHaveLength(0);
      expect(screen.queryByText("Photo added")).toBeNull();
    });

    it("falls back to the original rather than losing the photo if encoding fails", async () => {
      h.script.cropBlob = null; // canvas.toBlob returned null
      const file = jpeg();
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, file);
      fireEvent.click(await screen.findByTestId("photo-crop-apply"));
      await screen.findByText("Photo added");

      expect(privateUpload()!.body).toBe(file);
    });

    it("tells the admin what the circle will show and what gets saved", async () => {
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, jpeg());
      await screen.findByTestId("photo-crop-dialog");

      expect(screen.getByText(/The circle is what shows on the/)).toBeTruthy();
      // A 4000x2000 source at zoom 1 crops a 2000px square, capped to 1200.
      expect(screen.getByTestId("photo-crop-meta").textContent).toBe(
        "Saving 1200×1200 from a 4000×2000 photo",
      );
    });

    it("survives a parent re-render without re-decoding and losing the framing", async () => {
      // Both forms declare their onApply handler inline, so it is a new function
      // on every parent render. If the load effect depended on it, ANY unrelated
      // re-render of the form — the edit page's signPhoto resolving, an admin
      // typing — would re-run loadImage and reset the pan to centre, throwing
      // away the framing the admin had just dragged. Decoding exactly once is
      // the observable proof that the effect did not re-run.
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, jpeg());
      await screen.findByTestId("photo-crop-dialog");
      expect(h.script.loads).toBe(1);

      // Re-render the PARENT while the dialog is open.
      fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "Chris Waller" } });
      fireEvent.change(screen.getByTestId("trainer-website"), { target: { value: "https://x.com" } });

      await waitFor(() => expect(screen.getByTestId("photo-crop-dialog")).toBeTruthy());
      expect(h.script.loads).toBe(1);
    });

    it("re-cropping the SAME file after a cancel still opens the crop step", async () => {
      // The file input is reset on pick; without that, choosing the same file
      // twice fires no change event and the admin is quietly stuck.
      const { container } = render(<TrainerForm mode="create" />);
      const file = jpeg();
      pick(container, file);
      fireEvent.click(await screen.findByTestId("photo-crop-cancel"));
      await waitFor(() => expect(screen.queryByTestId("photo-crop-dialog")).toBeNull());

      pick(container, file);
      expect(await screen.findByTestId("photo-crop-dialog")).toBeTruthy();
    });
  });

  describe("in a browser with no canvas", () => {
    it("skips the crop step entirely and uploads the original, as before this ticket", async () => {
      const file = jpeg();
      const { container } = render(<TrainerForm mode="create" />);
      pick(container, file);
      await screen.findByText("Photo added");

      expect(screen.queryByTestId("photo-crop-dialog")).toBeNull();
      expect(privateUpload()!.body).toBe(file);
      expect(privateUpload()!.path).toMatch(/\.jpg$/);
    });
  });

  it("still publishes the CROPPED bytes to the marketing bucket, not the original", async () => {
    // ENG-766 copies the private object into the public marketing bucket by
    // re-reading it through a signed URL. Because the crop is baked in BEFORE
    // that upload, the public site gets the cropped photo for free — this pins
    // that the ordering never quietly inverts.
    h.script.canvas = true;
    h.script.cropBlob = new Blob(["cropped-bytes"], { type: "image/jpeg" });

    const { container } = render(<TrainerForm mode="create" />);
    fireEvent.change(screen.getByTestId("trainer-name"), { target: { value: "New Trainer" } });
    pick(container, jpeg());
    fireEvent.click(await screen.findByTestId("photo-crop-apply"));
    await screen.findByText("Photo added");

    const storedPath = privateUpload()!.path!;
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId("submit-trainer"));

    await waitFor(() =>
      expect(h.storage.some((c) => c.op === "upload" && c.bucket === "marketing-photos")).toBe(true),
    );
    // The public copy is read from the object the crop wrote.
    expect(
      h.storage.some((c) => c.op === "createSignedUrl" && c.bucket === "trainer-photos" && c.path === storedPath),
    ).toBe(true);
  });
});
