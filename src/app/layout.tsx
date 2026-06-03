import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Valley View",
  description: "UNIS WMS operational dashboard",
  icons: {
    icon: "https://unisco.sfo3.digitaloceanspaces.com/design-unisco-com/svg/unis-logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
