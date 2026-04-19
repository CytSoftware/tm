import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Shell } from "@/components/layout/Shell";
import { RegisterSW } from "@/components/pwa/RegisterSW";

/**
 * Inter is the Linear / Vercel / Stripe standard — renders consistently on
 * every platform including Linux (unlike Geist which looks thin on some
 * Linux font rendering stacks).
 */
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cyt Task Tracker",
  description: "Phase 1 of the Cyt internal infrastructure app.",
  applicationName: "Cyt",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Cyt",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfc" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

/**
 * Root layout.
 *
 * HARD INVARIANT: the page itself must NEVER scroll.
 *
 *   <html class="h-full">
 *     <body class="h-full overflow-hidden">     ← no page scroll
 *       <div class="h-screen flex flex-col">    ← the shell
 *         ...fixed regions + min-h-0 scrollable children
 *
 * Every flex child that contains a scrollable descendant must carry `min-h-0`
 * (or `min-w-0` for horizontal). Without it, flex children refuse to shrink
 * below their content size and the page grows. This is the #1 source of
 * "why is my page scrolling" bugs. Do NOT remove the class without verifying
 * that every view still satisfies:
 *
 *     document.documentElement.scrollHeight === window.innerHeight
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden bg-background text-foreground">
        <Providers>
          <Shell>{children}</Shell>
          <RegisterSW />
        </Providers>
      </body>
    </html>
  );
}
