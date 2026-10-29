import type { Metadata } from "next";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-sans-thai/index.css";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000",
  ),
  title: "MEA Synapse — Warehouse Operations",
  description: "Verified inventory, replenishment and road-aware smart logistics for MEA warehouse operations.",
  openGraph: {
    title: "MEA Synapse — Warehouse Operations",
    description: "A verified-data workspace for inventory, replenishment and road-aware smart logistics.",
    images: [{ url: "/og.png", width: 1662, height: 946, alt: "MEA Synapse Warehouse Operations" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body suppressHydrationWarning>{children}</body></html>;
}
