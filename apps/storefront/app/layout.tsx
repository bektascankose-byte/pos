import type { Metadata } from "next";
import { Archivo, Public_Sans } from "next/font/google";
import "./globals.css";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { getShopInfo } from "@/lib/shop";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public-sans",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const info = await getShopInfo();
  const name = info?.shop_name ?? "Shop";
  return {
    title: { default: name, template: `%s · ${name}` },
    description: `Order online from ${name} and pick up in store${info?.store.city ? ` in ${info.store.city}` : ""}. 21+ only.`,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const info = await getShopInfo();

  return (
    <html lang="en" className={`${archivo.variable} ${publicSans.variable}`}>
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {info?.test_mode ? (
          <div role="note" className="bg-[var(--ink)] px-4 py-1.5 text-center text-xs text-[var(--bg)]">
            Test shop: nothing here is charged, and emails go to the development mailbox instead of being sent.
          </div>
        ) : null}
        <Header info={info} />
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-6 sm:px-6">
          {children}
        </main>
        <Footer info={info} />
      </body>
    </html>
  );
}
