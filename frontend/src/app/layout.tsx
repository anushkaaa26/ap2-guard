import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AP2-Guard Inspector',
  description: 'Semantic Payment Firewall & Delegated Authorization Proxy',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-[#090a0f] text-zinc-100 antialiased selection:bg-indigo-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
