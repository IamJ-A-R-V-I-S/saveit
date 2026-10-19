import type { NextConfig } from "next";

/**
 * The dev server is reached through a reverse proxy in this environment, so the
 * host in the browser's address bar is not the host Next.js reports. Both lists
 * below need the proxy hostname or every Server Action and dev asset request is
 * rejected as cross-origin.
 *
 * `**` is only honoured at the start of a pattern and a port cannot be
 * wildcarded, hence the two explicit entries.
 */
const devOrigins = ["*.e2b.app", "*.e2b.dev"];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,

  experimental: {
    serverActions: {
      allowedOrigins: devOrigins,
      // Statements go up to the 25 MB the storage bucket allows. The default
      // 1 MB action body limit would reject every real upload.
      bodySizeLimit: "26mb",
    },
  },

  // Deliberately OFF. Cache Components requires a Suspense boundary around
  // every read of a per-request dynamic API, and almost every page here reads
  // the session cookie to scope its queries. Revisit once the app is stable.
  cacheComponents: false,

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
