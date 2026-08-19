import type { Metadata } from "next";
import { Figtree } from "next/font/google";

import { ToastProvider } from "@/components/Toast";
import { FeePayerProvider } from "@/hooks/useFeePayer";
import { SettingsProvider } from "@/hooks/useSettings";
import { WalletProvider } from "@/hooks/useWallet";

import "./globals.css";

/**
 * The design uses Google Sans Flex, which is not distributed publicly.
 * Figtree is the closest freely available match in weight and proportion.
 */
const figtree = Figtree({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Fee Granter — Secret Network",
  description:
    "Create, edit and revoke fee grants on Secret Network and the pulsar-3 testnet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable}>
      <body>
        <SettingsProvider>
          <WalletProvider>
            <FeePayerProvider>
              <ToastProvider>{children}</ToastProvider>
            </FeePayerProvider>
          </WalletProvider>
        </SettingsProvider>
      </body>
    </html>
  );
}
