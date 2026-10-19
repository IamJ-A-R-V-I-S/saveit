import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Nav, type NavItem } from "@/components/nav";
import { getUnseenInsightCount } from "@/lib/data/insights";
import { getPendingCount } from "@/lib/data/review";
import { getProfile } from "@/lib/data/profile";
import { createClient, currentUser } from "@/lib/supabase/server";

/**
 * The signed-in app shell.
 *
 * The auth check here is authoritative. The proxy also redirects signed-out
 * visitors, but that is an optimistic cookie check running on prefetched routes;
 * this is the one that actually gates the data, and it runs in the same request
 * that reads it, so there is no window where a page renders for the wrong
 * person.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  // The client is created for the profile read; RLS scopes it to this user.
  await createClient();

  // Counts are fetched in parallel with the profile. They are cheap
  // `head: true` count queries, but doing them serially would add a round trip
  // each to every navigation.
  const [reviewCount, pendingCount, insightCount, profile] = await Promise.all([
    getReviewCount(),
    getPendingCount(),
    getUnseenInsightCount(),
    getProfile(),
  ]);

  const items: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "▦" },
    { href: "/transactions", label: "Transactions", icon: "☰" },
    {
      href: "/review",
      label: "Review",
      icon: "◔",
      // The review queue is what needs a human; pending is what needs the model.
      // Both are shown on one badge because both mean "not finished yet".
      badge: reviewCount + pendingCount,
    },
    { href: "/insights", label: "Insights", icon: "◎", badge: insightCount },
    { href: "/upload", label: "Upload", icon: "⇪" },
    { href: "/taxonomy", label: "Taxonomy", icon: "❖" },
    { href: "/budgets", label: "Budgets", icon: "◫" },
    { href: "/documents", label: "Documents", icon: "▤" },
    { href: "/settings", label: "Settings", icon: "⚙" },
  ];

  return (
    <div className="flex min-h-screen w-full">
      <Nav items={items} userEmail={profile?.email ?? user.email} />

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Review-queue size.
 *
 * Kept here rather than in lib/data/review because it is a badge count, and
 * `head: true` makes it a COUNT(*) with no rows transferred.
 */
async function getReviewCount(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("categorize_status", "review");
  if (error) return 0;
  return count ?? 0;
}
