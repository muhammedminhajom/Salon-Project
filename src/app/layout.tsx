import type { Metadata } from "next";
import { Footer, Header } from "@/components/layout";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/playfair-display";
import "@fontsource-variable/playfair-display/wght-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Bloom & Blush | Book Beauty in Kochi", template: "%s | Bloom & Blush" },
  description:
    "Find and book local salons, nail studios, beauty and makeup artists, and home appointments in Kochi.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
