"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login } from "@/lib/auth";
import { meKey } from "@/lib/query-keys";

/**
 * LoginPage wraps LoginForm in a Suspense boundary because LoginForm uses
 * useSearchParams(), which forces CSR bailout. Without Suspense, Next's
 * static prerender on `/login` errors out with `missing-suspense-with-csr-bailout`.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginShell() {
  // Identical chrome to LoginForm's output so there's no layout shift while
  // the router suspends.
  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[360px] space-y-5 rounded-xl border border-border/80 bg-card p-6" />
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () => login(username, password),
    onSuccess: async (user) => {
      queryClient.setQueryData(meKey(), user);
      // If there's a `next` URL (e.g. from an OAuth authorize redirect),
      // send the user back there after login. Only allow URLs to the
      // same root domain to prevent open-redirect attacks.
      const next = searchParams.get("next");
      if (next) {
        try {
          const url = new URL(next, window.location.origin);
          const isAllowed =
            url.hostname === window.location.hostname ||
            url.hostname.endsWith(".cytsoftware.com");
          if (isAllowed) {
            window.location.href = url.toString();
            return;
          }
        } catch {
          // Fall through to default redirect
        }
      }
      router.replace("/board");
    },
  });

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <form
        className="w-full max-w-[360px] space-y-5 rounded-xl border border-border/80 bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-md bg-foreground grid place-items-center text-background text-[12px] font-semibold">
            C
          </div>
          <div>
            <div className="text-[14px] font-semibold tracking-tight">
              Cyt Task Tracker
            </div>
            <div className="text-[11px] text-muted-foreground">
              Sign in to continue
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="username"
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            Username
          </Label>
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="h-9 text-[13px]"
            required
          />
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="password"
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            Password
          </Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="h-9 text-[13px]"
            required
          />
        </div>
        {mutation.isError && (
          <p className="text-[12px] text-destructive">Invalid credentials.</p>
        )}
        <Button
          className="w-full h-9 text-[13px]"
          type="submit"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
