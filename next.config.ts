import type { NextConfig } from "next";

/** Sent with every response — pages, assets and API alike. */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  // The console is never legitimately framed, so no other page can overlay it (clickjacking).
  { key: "X-Frame-Options", value: "DENY" },
];

const config: NextConfig = {
  // Browser automation stays out of the server bundle; it only runs in the CLI daemon.
  serverExternalPackages: ["playwright-core"],
  poweredByHeader: false,
  // `npm run web` is the dev server, so its floating badge would sit on the sidebar every
  // day. Compile and runtime errors are still shown without it.
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default config;
