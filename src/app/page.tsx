import type { Metadata } from "next";

import { OverviewView } from "@/components/views/OverviewView";

// The layout's title template only reaches child segments, and this page shares the layout's own.
export const metadata: Metadata = { title: { absolute: "Overview · Reygent" } };

export default function OverviewPage() {
  return <OverviewView />;
}
