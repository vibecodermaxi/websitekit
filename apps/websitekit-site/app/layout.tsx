import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'websitekit — the issuance and settlement layer for tokenized page inventory',
  description:
    'Publishers register regions of a page as transferable positions. Investors acquire and trade them. Holders delegate write access without surrendering the asset — the primitive a rental market for advertising demand plugs into.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
