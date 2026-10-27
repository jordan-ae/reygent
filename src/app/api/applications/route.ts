import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Tracked listings; filter with ?stage=, ?tier= and ?q=. */
export function GET(request: Request): Promise<Response> {
  return handle(request, (app, { query }) => app.applications(query));
}

/** Track a listing typed in by hand. */
export function POST(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.addApplication(body));
}
