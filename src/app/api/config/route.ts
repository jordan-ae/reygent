import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Validate and write config.yaml, then sync the fact bank. */
export function PUT(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.saveConfig(body));
}
