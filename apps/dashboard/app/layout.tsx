import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnapPOS Back Office",
  description: "Sales, customers, and shop management for SnapPOS.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#070a12" },
    { media: "(prefers-color-scheme: light)", color: "#f3f5f9" },
  ],
};

// Self-hosted by next/font at build time: no request to Google from the
// browser, and no layout shift while a font arrives.
const sans = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

/*
 * Runs before the first paint. The server always renders dark (it cannot know
 * the choice, which lives in this browser), so without this a light-theme user
 * would see a dark flash on every page load. Anything but a stored "light"
 * means dark, and a browser that refuses storage simply gets dark.
 */
const THEME_BOOT = `try{document.documentElement.dataset.theme=localStorage.getItem("bo-theme")==="light"?"light":"dark"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script may change data-theme before
    // React hydrates, which is intended rather than a mismatch.
    <html
      lang="en"
      data-theme="dark"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
