import type { Metadata } from "next";

import { QuarantineView } from "@/components/views/QuarantineView";

export const metadata: Metadata = { title: "Quarantine" };

export default function QuarantinePage() {
  return <QuarantineView />;
}
