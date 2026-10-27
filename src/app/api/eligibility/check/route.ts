import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Classify a listing without saving it. */
export function POST(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.checkEligibility(body));
}
