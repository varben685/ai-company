"use client";
import Link from "next/link";
import { DashboardView } from "@company/contracts";
import { useData, Heading, ErrorBox, Loading } from "../../components/ui";
export default function Dashboard() {
  const { data, error, loading } = useData(
    "/dashboard",
    DashboardView,
    (d) => d.activeTasks > 0,
  );
  return (
    <>
      <Heading eyebrow="WORKSPACE OVERVIEW" title="From plan to reviewed code.">
        Plan with your Product Agent, then start development explicitly on the
        sample source. You approve the final code package.
      </Heading>
      <ErrorBox message={error} />
      {loading ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="metrics">
              {[
                ["Projects", data.projects],
                ["Active tasks", data.activeTasks],
                ["Awaiting approval", data.pendingApprovals],
                ["Agent runs", data.runs],
              ].map(([label, value]) => (
                <div className="metric" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="overview-grid">
              <section className="panel feature">
                <div className="eyebrow">YOUR NEXT STEP</div>
                <h2>Make the work explicit.</h2>
                <p>
                  Create a project, add its context, and describe the next thing
                  you want to build.
                </p>
                <Link className="button primary" href="/projects">
                  Open projects <span>↗</span>
                </Link>
                <div className="flow">
                  <span>
                    01
                    <br />
                    Describe
                  </span>
                  <span>
                    02
                    <br />
                    Plan
                  </span>
                  <span>
                    03
                    <br />
                    Validate & review
                  </span>
                </div>
              </section>
              <section className="panel">
                <h2>AI usage estimate</h2>
                <div className="cost">${data.knownEstimatedCostUsd}</div>
                <p>Known estimated cost · {data.currency}</p>
                <div className="notice">
                  {data.unknownAttempts} attempts with unknown cost
                </div>
                <p className="muted">
                  Includes known costs from failed and interrupted attempts.
                  Estimates are not invoices or a monthly spending cap.
                </p>
              </section>
            </div>
            <div className="boundary">
              <strong>Built for a deliberate handoff.</strong>
              <p>
                An approved plan can start an isolated sample development run.
                DONE means the code package was accepted; nothing is merged or
                deployed.
              </p>
            </div>
          </>
        )
      )}
    </>
  );
}
