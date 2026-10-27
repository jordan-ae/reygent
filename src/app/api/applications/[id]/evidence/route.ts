import { handleImage } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** The screenshot the operator kept of this application's confirmation page, as a PNG. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handleImage(request, (app) => app.evidenceFile(id));
}
