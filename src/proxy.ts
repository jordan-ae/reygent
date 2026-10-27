import type { NextRequest } from "next/server";

import { refuse } from "@/core/web/guard";

/**
 * Refuse any API request that is not a same-origin request to this console, before it
 * is routed. This is the outer line: it covers every path under /api, including ones
 * added later and ones that do not exist. Each route handler applies the same check
 * again (see `serve`), so a change to the matcher below cannot silently open the API.
 */
export function proxy(request: NextRequest): Response | undefined {
  return refuse(request) ?? undefined;
}

export const config = { matcher: "/api/:path*" };
