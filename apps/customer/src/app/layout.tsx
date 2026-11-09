import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Take & go | احجز مشوارك",
  description: "احجز مشوارك بسيارة خاصة بدون تسجيل دخول، شوف السعر، وابعث طلبك على واتساب."
};

export const viewport: Viewport = {
  themeColor: "#0c1424"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
