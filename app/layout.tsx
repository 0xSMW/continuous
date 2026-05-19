import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Continuous Admin",
  description: "Operational surface for Continuous Core.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
