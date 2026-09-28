import type { Metadata, Viewport } from "next";
import { Inter, Cormorant_Garamond } from "next/font/google";
import "./globals.css";
import { ADMIN_APP_NAME, ADMIN_THEME_COLOR } from "@/lib/pwa";

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});

export const metadata: Metadata = {
  title: "stablepass admin",
  description: "Stablepass internal operator dashboard.",
  // ENG-1591: installed from iOS Safari's "Add to Home Screen", the admin opens
  // standalone (no Safari chrome) under this name. `app/manifest.ts` covers
  // Android/desktop; iOS still reads these apple-mobile-web-app-* tags. The
  // apple-touch-icon comes from the `app/apple-icon.png` file convention.
  // "black" (not "black-translucent") so the status bar never overlaps the
  // phone bar — the shell has no safe-area padding to spare.
  appleWebApp: {
    capable: true,
    title: ADMIN_APP_NAME,
    statusBarStyle: "black",
  },
};

export const viewport: Viewport = {
  themeColor: ADMIN_THEME_COLOR,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${cormorant.variable}`}>
      <body className="screen-body">{children}</body>
    </html>
  );
}
