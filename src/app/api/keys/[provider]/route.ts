import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ provider: string }> };

/** Store a provider's API key. The key is never sent back. */
export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const { provider } = await params;
  return handle(request, (app, { body }) => app.setKey(provider, body));
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const { provider } = await params;
  return handle(request, (app) => app.deleteKey(provider));
}
