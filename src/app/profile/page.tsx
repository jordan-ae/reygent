import type { Metadata } from "next";

import { ProfileView } from "@/components/views/ProfileView";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return <ProfileView />;
}
