import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./template.css";
import "./globals.css";
import "./meridian.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000",
  ),
  title: "MEA Synapse | คลังพัสดุและขนส่ง",
  description: "จัดการสต็อก แผนเติมพัสดุ และเส้นทางขนส่งสำหรับงานคลังของ MEA",
  openGraph: {
    title: "MEA Synapse | คลังพัสดุและขนส่ง",
    description: "จัดการสต็อก แผนเติมพัสดุ และเส้นทางขนส่งจากข้อมูลที่ตรวจสอบแล้ว",
    images: [{ url: "/og.png", width: 1662, height: 946, alt: "MEA Synapse Warehouse Operations" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body suppressHydrationWarning>{children}</body></html>;
}
