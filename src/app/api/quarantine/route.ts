import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Drafts held by the Cop Tool; ?status= is pending (default), reviewed or all. */
export function GET(request: Request): Promise<Response> {
  return handle(request, (app, { query }) => app.quarantine(query));
}
