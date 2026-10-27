import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Record what came of a submitted application: { kind, note?, monthlyValueUsd? }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(request, (app, { body }) => app.recordOutcome(id, body));
}
