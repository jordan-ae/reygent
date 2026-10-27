import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Send a held draft's job back to drafting: { ids, answers?: [{ question, answer }] }. */
export function POST(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.retryQuarantine(body));
}
