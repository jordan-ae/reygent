import type { Metadata } from "next";
import { Suspense } from "react";

import { ApplicationsView } from "@/components/views/ApplicationsView";

export const metadata: Metadata = { title: "Applications" };

export default function ApplicationsPage() {
  // The view reads ?stage= from the URL, which a prerendered page only knows in the browser.
  return (
    <Suspense>
      <ApplicationsView />
    </Suspense>
  );
}
