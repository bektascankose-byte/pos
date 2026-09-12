import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnapPOS Back Office",
  description: "Sales, customers, and shop management for SnapPOS.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
