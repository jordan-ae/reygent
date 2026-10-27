import type { Metadata } from "next";

import { CostsView } from "@/components/views/CostsView";

export const metadata: Metadata = { title: "Costs" };

export default function CostsPage() {
  return <CostsView />;
}
