import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

/*
 * Self-hosted from the `geist` npm package rather than `next/font/google`.
 *
 * `next/font/google` fetches the CSS from fonts.googleapis.com AT BUILD TIME, so
 * a build in any offline, proxied or firewalled environment fails outright — not
 * with a fallback font, with a hard error. Self-hosting removes the network
 * dependency and is also faster: no third-party request from the browser either.
 *
 * The exported `variable` names are `--font-geist-sans` and `--font-geist-mono`,
 * which is what globals.css already references.
 */

export const metadata: Metadata = {
  title: {
    default: "SaveIt — upload a statement, not forty expenses",
    template: "%s · SaveIt",
  },
  description:
    "Upload a bank, UPI or tracker statement and SaveIt categorizes every transaction, learns how you describe money, and tells you where you can actually save.",
};

export const viewport: Viewport = {
  themeColor: "#0f766e",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-ink">{children}</body>
    </html>
  );
}
