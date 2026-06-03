import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Valley View",
  description: "Bay 4 Assignments Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
