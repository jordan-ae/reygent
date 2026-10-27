import type { Metadata } from "next";

import { ApplicationView } from "@/components/views/ApplicationView";

export const metadata: Metadata = { title: "Applications" };

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Keyed so moving from one application to another never shows the previous one's data.
  return <ApplicationView key={id} id={id} />;
}
