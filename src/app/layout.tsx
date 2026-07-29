import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Outfit } from "next/font/google";
import Script from "next/script";
import { AppNav } from "@/components/app-nav";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
          {children}
        </main>
      </body>
    </html>
  );
}
