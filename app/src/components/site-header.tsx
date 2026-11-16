import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3" aria-label="Main">
        <Link href="/" className="font-semibold tracking-tight">
          Fireline
        </Link>
        <div className="flex gap-4 text-sm">
          <Link href="/">Explore</Link>
          <Link href="/method">Method</Link>
        </div>
      </nav>
    </header>
  );
}
