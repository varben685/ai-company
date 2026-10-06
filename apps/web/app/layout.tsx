import type { Metadata } from "next";
import Link from "next/link";
import "./style.css";
import { ProviderBadge } from "../components/ui";
export const metadata: Metadata = {
  title: "AI Company · Planning workspace",
  description:
    "A local workspace for deliberate, human-approved product planning.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside>
            <Link href="/dashboard" className="brand">
              <span className="brand-icon">
                a<span>i</span>
              </span>
              <span>
                Company<small>OPERATOR WORKSPACE</small>
              </span>
            </Link>
            <div className="nav-label">WORKSPACE</div>
            <nav>
              <Link href="/dashboard">
                ◫ <span>Overview</span>
              </Link>
              <Link href="/projects">
                ▱ <span>Projects</span>
              </Link>
            </nav>
            <div className="sidebar-bottom">
              <span className="online-dot" /> Local operator
              <small>Milestone 1 · Product planning</small>
              <ProviderBadge />
            </div>
          </aside>
          <div className="main">
            <header>
              <span>
                Workspace / <strong>Product planning</strong>
              </span>
              <span className="local">LOCAL ENVIRONMENT</span>
            </header>
            <main>{children}</main>
            <footer>
              Human decisions. Durable history.{" "}
              <span>Planning ends at your approval.</span>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
