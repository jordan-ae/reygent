import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Act on the job's draft: { action: "approve" | "decline" | "submitted" | "retry" }. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handle(request, (app, { body }) => app.draftAction(id, body));
}
