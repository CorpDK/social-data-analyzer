import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Outfit } from "next/font/google";
import Script from "next/script";
import { AppNav } from "@/components/app-nav";
import { LibraryStatusCard } from "@/components/library-status-card";
import { getLibraryStatus } from "@/lib/storage";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const dynamic = "force-dynamic";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const ibm = IBM_Plex_Mono({
  variable: "--font-ibm",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Instagram Saves",
  description:
    "Import and analyze your Instagram saved posts and reels from official data exports.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const libraryStatus = await getLibraryStatus();
  const libraryBlocked = libraryStatus.state !== "up_to_date";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${outfit.variable} ${fraunces.variable} ${ibm.variable} h-full antialiased`}
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col text-[15px] leading-relaxed">
        <AppNav />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-8 sm:px-6">
          {libraryBlocked ? (
            <div className="mx-auto max-w-3xl space-y-4">
              <p className="text-sm text-[var(--muted)]">
                Instagram Saves needs your library to be ready before the rest
                of the app can open.
              </p>
              <LibraryStatusCard initialStatus={libraryStatus} />
            </div>
          ) : (
            children
          )}
        </main>
      </body>
    </html>
  );
}
