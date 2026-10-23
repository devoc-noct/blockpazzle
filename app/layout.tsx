import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ブロックパズル',
  description: 'ブラウザで遊べるブロックパズル。部屋番号で2人対戦できます。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body style={{ margin: 0, background: '#000' }}>{children}</body>
    </html>
  );
}
