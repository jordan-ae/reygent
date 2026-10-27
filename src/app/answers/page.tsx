import type { Metadata } from "next";

import { AnswersView } from "@/components/views/AnswersView";

export const metadata: Metadata = { title: "Answers" };

export default function AnswersPage() {
  return <AnswersView />;
}
