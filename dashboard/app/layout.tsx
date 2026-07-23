import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000",
  ),
  title: "MEA Synapse — Warehouse Operations",
  description: "Verified inventory sources, replenishment readiness, demand history and transport preparation for MEA warehouse operations.",
  openGraph: {
    title: "MEA Synapse — Warehouse Operations",
    description: "A verified-data workspace for inventory, replenishment, demand planning and transport readiness.",
    images: [{ url: "/og.png", width: 1662, height: 946, alt: "MEA Synapse Warehouse Operations" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
