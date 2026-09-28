import { describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import manifest from "./manifest";
import { metadata, viewport } from "./layout";

// app/layout.tsx loads next/font, which only resolves inside the Next compiler.
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "--font-inter" }),
  Cormorant_Garamond: () => ({ variable: "--font-cormorant" }),
}));


// ENG-1591 (A3c) — installable admin PWA.
const root = join(__dirname, "..");

// First pixel of the first scanline. Every PNG filter predicts it from zeros,
// so after inflating the IDAT stream it is the raw bytes after the filter byte.
function cornerPixel(file: string) {
  const b = readFileSync(file);
  const idat: Buffer[] = [];
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    const type = b.subarray(o + 4, o + 8).toString("ascii");
    if (type === "IDAT") idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

function pngSize(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("app/manifest.ts", () => {
  const m = manifest();

  it("installs standalone as StablePass Admin, rooted at /", () => {
    expect(m.name).toBe("StablePass Admin");
    expect(m.short_name).toBe("StablePass Admin");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
  });

  it("uses the admin tokens for theme + background", () => {
    const css = readFileSync(join(root, "app/globals.css"), "utf8");
    expect(css).toContain(`--brand-green-darker: ${m.theme_color}`);
    expect(css).toContain(`--cream: ${m.background_color}`);
  });

  it("ships 192, 512 and a maskable 512 PNG that exist at their declared size", () => {
    const icons = m.icons ?? [];
    const want = [
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ];
    for (const [sizes, purpose] of want) {
      const icon = icons.find((i) => i.sizes === sizes && i.purpose === purpose);
      expect(icon, `${sizes} ${purpose}`).toBeDefined();
      const file = join(root, "public", icon!.src);
      expect(existsSync(file), icon!.src).toBe(true);
      const [w, h] = sizes.split("x").map(Number);
      expect(pngSize(file)).toEqual({ w, h });
    }
  });

  it("is NOT the member app's green icon (so the two differ on one home screen)", () => {
    // The member icon is a full-bleed brand-green #285D50 square; the admin
    // mark is on navy #1A2B3F. Every admin icon's corner pixel must be navy.
    const files = [
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/icons/icon-maskable-512.png",
      "app/icon.png",
      "app/apple-icon.png",
    ];
    for (const f of files) expect(cornerPixel(join(root, f)), f).toEqual([0x1a, 0x2b, 0x3f]);
  });
});

describe("app/layout.tsx install metadata", () => {
  it("declares iOS standalone via appleWebApp", () => {
    expect(metadata.appleWebApp).toEqual({
      capable: true,
      title: "StablePass Admin",
      statusBarStyle: "black",
    });
  });

  it("tints the browser/status bar with the admin theme colour", () => {
    expect(viewport.themeColor).toBe(manifest().theme_color);
  });
});

describe("no service worker", () => {
  it("nothing registers one and none is shipped", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".claude", ".git", "e2e"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|m?js)$/.test(name) && !name.endsWith(".test.ts")) {
          if (readFileSync(p, "utf8").includes("serviceWorker")) hits.push(p);
        }
      }
    };
    walk(join(root, "app"));
    walk(join(root, "lib"));
    expect(hits).toEqual([]);
    expect(existsSync(join(root, "public/sw.js"))).toBe(false);
  });
});
