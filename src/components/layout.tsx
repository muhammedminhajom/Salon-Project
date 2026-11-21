import Link from "next/link";
import { CalendarDays, Flower2, MapPin, Menu, UserRound } from "lucide-react";
import { getViewer, roleHome } from "@/lib/auth";
import { requestTime } from "@/lib/request-time";
import { Button } from "@/components/ui/button";
import { SignOut } from "@/components/sign-out";

export function Wordmark() {
  return (
    <Link className="wordmark" href="/" aria-label="Bloom and Blush home">
      <span className="brand-icon">
        <Flower2 size={21} strokeWidth={1.6} />
      </span>
      <span>
        bloom<span className="brand-amp"> &amp; </span>blush<span className="brand-period">.</span>
      </span>
    </Link>
  );
}

export async function Header() {
  const user = await getViewer();
  const portal = user ? roleHome(user.role) : "/account";
  const portalLabel =
    user?.role === "PROVIDER" || user?.role === "STAFF"
      ? "Studio"
      : user?.role === "ADMIN"
        ? "Admin"
        : "Appointments";
  return (
    <header className="site-header">
      <div className="header-inner wrap">
        <Wordmark />
        <nav className="desktop-nav" aria-label="Main navigation">
          <Link href="/explore">Explore</Link>
          <Link href="/explore?offers=1">Offers</Link>
          <Link href={user?.role === "PROVIDER" || user?.role === "STAFF" ? "/studio" : "/partners"}>
            For professionals
          </Link>
        </nav>
        <div className="header-actions">
          <Link href="/explore?city=Kochi" title="Explore Kochi" className="nav-location">
            <MapPin size={17} /> Kochi
          </Link>
          {user ? (
            <>
              <Button asChild size="sm">
                <Link href={portal}>
                  <CalendarDays size={16} />
                  {portalLabel}
                </Link>
              </Button>
              <SignOut compact />
            </>
          ) : (
            <Button asChild size="sm">
              <Link href="/account">
                <UserRound size={16} /> Sign in
              </Link>
            </Button>
          )}
        </div>
        <details className="mobile-menu">
          <summary aria-label="Main navigation">
            <Menu size={24} />
          </summary>
          <nav aria-label="Mobile navigation">
            <Link href="/explore">Explore</Link>
            <Link href="/explore?offers=1">Offers</Link>
            <Link href="/partners">For professionals</Link>
            {user ? (
              <>
                <Link href={portal}>{portalLabel}</Link>
                <SignOut />
              </>
            ) : (
              <Link href="/account">Sign in</Link>
            )}
          </nav>
        </details>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <div>
          <Wordmark />
          <p>Book local beauty and wellness in Kochi.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link href="/explore">Explore</Link>
          <Link href="/explore?offers=1">Offers</Link>
          <Link href="/partners">For professionals</Link>
        </nav>
        <span>© {new Date(requestTime()).getFullYear()} Bloom &amp; Blush</span>
      </div>
    </footer>
  );
}
