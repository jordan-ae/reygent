import type { Metadata } from "next";

import { FactBankView } from "@/components/views/FactBankView";

export const metadata: Metadata = { title: "Fact bank" };

export default function FactBankPage() {
  return <FactBankView />;
}
