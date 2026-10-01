import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "KUnnect", template: "%s · KUnnect" },
  description: "건국대학교 글로컬 캠퍼스 분실물 연결 서비스",
  appleWebApp: { capable: true, title: "KUnnect", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#0f6e3a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
