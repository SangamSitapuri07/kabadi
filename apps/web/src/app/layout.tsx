import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kabadiwala Connect — Multi-Tier Scrap Marketplace, AI X-Ray & Traceability",
  description:
    "Connect households, local kabadiwalas, area scrap shops, wholesale baling hubs and authorised recyclers with transparent rate cards, AI X-Ray valuation, and OWASP security.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased selection:bg-emerald-200 selection:text-emerald-950">
        {children}
      </body>
    </html>
  );
}
