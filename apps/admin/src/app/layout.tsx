import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Take & Go | لوحة الإدارة",
  description: "إدارة الكباتن والرسوم والأرصدة في Take & Go"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
