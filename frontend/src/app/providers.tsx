"use client";

import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ActiveProjectProvider } from "@/lib/active-project";
import { PaletteProvider } from "@/lib/palette";
import { SidebarProvider } from "@/lib/sidebar-state";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <ActiveProjectProvider>
          <PaletteProvider>
            <SidebarProvider>
              <TooltipProvider delay={200}>
                {children}
                <Toaster position="bottom-right" />
              </TooltipProvider>
            </SidebarProvider>
          </PaletteProvider>
        </ActiveProjectProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
