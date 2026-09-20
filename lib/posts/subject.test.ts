import { describe, it, expect } from "vitest";
import { subjectLabel } from "./subject";

// The ONE formatter for "who is this post by" (ENG-1269 / A4). Every admin
// surface that names a post's subject — the posts library, the preview route,
// the dashboard and per-post analytics — goes through this, so it is pinned
// here rather than re-proven in each caller's own test file.

describe("subjectLabel", () => {
  describe("horse", () => {
    it("names the horse, with its trainer as the detail", () => {
      const label = subjectLabel({ subject: "horse", horseName: "Mahogany", trainerName: "Chris Waller" });
      expect(label).toEqual({
        subject: "horse",
        name: "Mahogany",
        tag: null,
        detail: "Chris Waller",
        text: "Mahogany",
      });
    });

    it("has no detail when there is no trainer", () => {
      const label = subjectLabel({ subject: "horse", horseName: "Mahogany" });
      expect(label.detail).toBeNull();
      expect(label.text).toBe("Mahogany");
    });

    it("falls back to 'Unassigned' when there is no horse name", () => {
      const label = subjectLabel({ subject: "horse" });
      expect(label.name).toBe("Unassigned");
      expect(label.text).toBe("Unassigned");
    });
  });

  describe("trainer", () => {
    it("names the trainer, tagged 'Trainer', with no detail", () => {
      const label = subjectLabel({ subject: "trainer", trainerName: "Chris Waller" });
      expect(label).toEqual({
        subject: "trainer",
        name: "Chris Waller",
        tag: "Trainer",
        detail: null,
        text: "Chris Waller · Trainer",
      });
    });

    it("falls back to 'Unknown trainer' — NOT 'Unassigned' — when the trainer name is missing", () => {
      // A trainer post always HAS a trainer (B1's post_subject_shape CHECK
      // requires source_trainer_id); a blank name here means the embed
      // failed, not that the operator left a field empty.
      const label = subjectLabel({ subject: "trainer" });
      expect(label.name).toBe("Unknown trainer");
      expect(label.text).toBe("Unknown trainer · Trainer");
    });
  });

  describe("stablepass", () => {
    it("names the brand handle, with the byline as the detail", () => {
      const label = subjectLabel({ subject: "stablepass", byline: "Racing TV" });
      expect(label).toEqual({
        subject: "stablepass",
        name: "stablepass",
        tag: null,
        detail: "Racing TV",
        text: "stablepass · Racing TV",
      });
    });

    it("collapses to just the handle when there is no byline", () => {
      const label = subjectLabel({ subject: "stablepass" });
      expect(label.detail).toBeNull();
      expect(label.text).toBe("stablepass");
    });
  });

  describe("absent-vs-blank normalisation", () => {
    it("treats a whitespace-only horse name, trainer name or byline as absent", () => {
      expect(subjectLabel({ subject: "horse", horseName: "   " }).name).toBe("Unassigned");
      expect(subjectLabel({ subject: "horse", horseName: "Mahogany", trainerName: "  " }).detail).toBeNull();
      expect(subjectLabel({ subject: "trainer", trainerName: "   " }).name).toBe("Unknown trainer");
      expect(subjectLabel({ subject: "stablepass", byline: "   " }).detail).toBeNull();
    });
  });

  describe("degrades to horse for anything it does not recognise", () => {
    it("an unrecognised subject string", () => {
      const label = subjectLabel({ subject: "bogus", horseName: "Mahogany" });
      expect(label.subject).toBe("horse");
      expect(label.name).toBe("Mahogany");
    });

    it("subject: null", () => {
      const label = subjectLabel({ subject: null, horseName: "Mahogany" });
      expect(label.subject).toBe("horse");
    });

    it("subject: undefined (the key omitted entirely)", () => {
      const label = subjectLabel({ horseName: "Mahogany" });
      expect(label.subject).toBe("horse");
    });
  });
});
