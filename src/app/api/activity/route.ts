import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** The merged activity feed; filter with ?kind= and ?limit=. */
export function GET(request: Request): Promise<Response> {
  return handle(request, (app, { query }) => app.activity(query));
}
