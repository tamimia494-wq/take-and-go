import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Take & Go | احجز رحلتك",
  description: "احجز سيارتك الخاصة بسهولة وأرسل طلبك مباشرة عبر واتساب."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
