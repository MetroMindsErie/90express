import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { Mark, Nav, UserMenu, ViewAsSwitcher } from "@/components/shell";
import { getActingBusinessId, getSessionUser } from "@/lib/auth/session";
import { getBusiness, getBusinesses } from "@/lib/db/queries";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "90 Express — Consumer Road Share",
  description:
    "Collective purchasing and freight consolidation for independent operators on the I-77 corridor.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The layout renders for public pages too, so it must tolerate no session.
  const user = await getSessionUser();

  const acting = user ? await getActingBusinessId(user) : null;
  const actingBusiness = acting ? await getBusiness(acting) : null;
  const businesses = user?.role === "operator" ? await getBusinesses() : [];

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="min-h-screen">
          {user?.role === "operator" && actingBusiness ? (
            <div className="border-b border-signal/40 bg-signal-dim/50 px-5 py-1.5 text-center text-xs text-signal">
              Operator view — you are looking at{" "}
              <strong>{actingBusiness.dba ?? actingBusiness.legal_name}</strong>
              &apos;s console. Actions you take here are recorded against them.
            </div>
          ) : null}

          <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
            <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
              <Mark href={user ? "/" : "/join"} />

              {user ? (
                <>
                  <div className="order-3 w-full lg:order-2 lg:w-auto lg:flex-1">
                    <Nav role={user.role} />
                  </div>
                  <div className="order-2 ml-auto flex items-center gap-4 lg:order-3 lg:ml-0">
                    {user.role === "operator" ? (
                      <ViewAsSwitcher
                        currentId={acting}
                        businesses={businesses.map((b) => ({
                          id: b.id,
                          name: b.dba ?? b.legal_name,
                          zone: b.zone_name,
                        }))}
                      />
                    ) : null}
                    <UserMenu
                      displayName={user.displayName}
                      email={user.email}
                      role={user.role}
                    />
                  </div>
                </>
              ) : (
                <div className="ml-auto flex items-center gap-3">
                  <Link
                    href="/join"
                    className="text-[13px] font-medium text-mid hover:text-hi"
                  >
                    Apply to join
                  </Link>
                  <Link
                    href="/signin"
                    className="rounded border border-ink-600 px-3 py-1.5 text-xs font-semibold text-hi transition-colors hover:border-signal hover:text-signal"
                  >
                    Sign in
                  </Link>
                </div>
              )}
            </div>
          </header>

          <main className="mx-auto max-w-[1400px] px-5 py-8">{children}</main>

          <footer className="mx-auto max-w-[1400px] px-5 pb-10 pt-4 text-xs leading-relaxed text-low">
            <p>
              90 Express LLC — I-77 corridor pilot. 90 Express coordinates
              collective orders and consolidated freight; it does not take title
              to goods. Members contract and pay suppliers directly.
            </p>
            <p className="mt-1">
              Seeded businesses, suppliers and carriers are fictional. Savings
              figures compare against benchmark LTL rates unless a cycle has
              been rated by a carrier, which the settlement states.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
