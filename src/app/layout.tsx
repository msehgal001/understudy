import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Understudy",
  description: "An offboarding agent that independently verifies its own work.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="inline-block h-2 w-2 rounded-full bg-verified" />
              <span className="mono text-[13px] font-medium tracking-tight">understudy</span>
            </Link>
            <div className="flex items-center gap-1">
              <Link href="/" className="mono rounded px-2.5 py-1 text-[12px] text-faint hover:text-fg">runs</Link>
              <Link href="/eval" className="mono rounded px-2.5 py-1 text-[12px] text-faint hover:text-fg">eval</Link>
            </div>
            <div className="ml-auto text-[11px] text-faint">
              every write is confirmed by an independent read
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
