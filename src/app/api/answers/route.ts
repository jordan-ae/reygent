import { handle } from "@/core/web/instance";

export const dynamic = "force-dynamic";

/** Every standing answer. */
export function GET(request: Request): Promise<Response> {
  return handle(request, (app) => app.answers());
}

/** Add or replace an answer: { question, answer }. It becomes the user's own. */
export function PUT(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.saveAnswer(body));
}

/** Forget an answer: { question }. The question is the key, so it travels in the body, not the URL. */
export function DELETE(request: Request): Promise<Response> {
  return handle(request, (app, { body }) => app.deleteAnswer(body));
}
