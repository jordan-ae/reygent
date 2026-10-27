import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ConsoleShell } from "@/components/ConsoleShell";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Reygent", template: "%s · Reygent" },
  // A private, local tool: nothing here should ever be indexed or leak a referrer.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* The shell lives in the layout so the unsaved config draft survives moving between pages. */}
        <ConsoleShell>{children}</ConsoleShell>
      </body>
    </html>
  );
}
