import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Kabadiwala Connect',
  description: 'A fresh start for a simpler scrap collection experience.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
