import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata: Metadata = { title: "Sign in" };

type Props = {
  // Only `page.tsx` receives searchParams in the App Router — a nested
  // component would silently get `undefined`. The page reads it and passes the
  // single value it needs down.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const callbackFailed = params.error === "could-not-confirm";
  const next = typeof params.next === "string" ? params.next : null;

  return (
    <>
      {callbackFailed ? (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-xs leading-relaxed text-warning"
        >
          That confirmation link has expired or was already used.{" "}
          <Link href="/signup" className="font-semibold underline">
            Sign up again
          </Link>{" "}
          or sign in below with your password.
        </p>
      ) : null}

      <AuthForm mode="signin" next={next} />
    </>
  );
}
