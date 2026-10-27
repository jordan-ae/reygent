import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Mark the findings of a held draft as seen. */
export function POST(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.reviewQuarantine(body));
}
