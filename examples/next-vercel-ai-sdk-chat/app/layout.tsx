import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spectrum Vercel AI SDK Chat Demo",
  description: "A useChat demo backed by a long-running Spectrum worker.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
