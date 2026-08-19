import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Northwind — ship faster, with less of everything',
  description: 'One platform for the work you were already doing in six tabs.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
