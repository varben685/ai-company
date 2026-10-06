"use client";
import { use, useState, useEffect } from "react";
import Link from "next/link";
import { z } from "zod";
import { TaskDetail, RunView, EventView, pageOf } from "@company/contracts";
import {
  api,
  useData,
  Heading,
  ErrorBox,
  Loading,
  Empty,
  Status,
  accepted,
  Pager,
} from "../../../components/ui";
const runsSchema = z.array(RunView);
const eventsSchema = pageOf(EventView);
const active = (t: z.infer<typeof TaskDetail>) =>
  ["QUEUED_FOR_PLANNING", "PLANNING"].includes(t.status);
export default function Task({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const task = useData("/tasks/" + id, TaskDetail, active);
  const runs = useData(
    `/tasks/${id}/runs`,
    runsSchema,
    () => !!task.data && active(task.data),
  );
  const [eventPage, setEventPage] = useState(1);
  const events = useData(
    `/tasks/${id}/events?page=${eventPage}`,
    eventsSchema,
    () => !!task.data && active(task.data),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const t = task.data;
  const plan = t?.plans.find((p) => p.id === (selected ?? t.currentPlanId));
  const approval = t?.approvals.find((a) => a.targetPlanId === plan?.id);
  const reload = async () => {
    await Promise.all([task.reload(), runs.reload(), events.reload()]);
  };
  const reloadRuns = runs.reload;
  const reloadEvents = events.reload;
  useEffect(() => {
    if (t?.version) {
      void reloadRuns();
      void reloadEvents();
    }
  }, [t?.version, reloadRuns, reloadEvents]);
  async function command(action: string) {
    if (!t) return;
    setPending(action);
    setError("");
    try {
      if (["approve", "request-changes", "reject"].includes(action)) {
        if (!approval || !plan) return;
        await api(
          `/approvals/${approval.id}/${action}`,
          accepted,
          {
            planId: plan.id,
            expectedTaskVersion: t.version,
            ...(comment ? { comment } : {}),
          },
          crypto.randomUUID(),
        );
        setSelected(null);
        setComment("");
      } else
        await api(`/tasks/${id}/${action}`, accepted, {}, crypto.randomUUID());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      await reload();
    } finally {
      setPending("");
    }
  }
  if (task.loading) return <Loading />;
  return (
    <>
      <Link
        className="back"
        href={t ? "/projects/" + t.projectId : "/projects"}
      >
        ← Back to project
      </Link>
      <Heading eyebrow="TASK PLANNING" title={t?.title ?? "Task"}>
        {t?.description}
      </Heading>
      <ErrorBox message={error || task.error || runs.error || events.error} />
      {t && (
        <>
          <div className="task-toolbar">
            <Status value={t.status} />
            <span className="muted">
              {t.priority} priority · Task version {t.version}
            </span>
            <div className="actions">
              {t.status === "DRAFT" && (
                <button
                  className="primary"
                  disabled={!!pending}
                  onClick={() => void command("plan")}
                >
                  Start planning
                </button>
              )}
              {t.status === "FAILED" && (
                <button
                  className="primary"
                  disabled={!!pending}
                  onClick={() => void command("retry")}
                >
                  Retry planning
                </button>
              )}
              {!["PLAN_APPROVED", "REJECTED", "CANCELLED"].includes(
                t.status,
              ) && (
                <button
                  disabled={!!pending}
                  onClick={() => void command("cancel")}
                >
                  Cancel task
                </button>
              )}
            </div>
          </div>
          {pending && <p role="status">Saving {pending}…</p>}
          {active(t) && (
            <div className="notice" role="status">
              {t.status === "QUEUED_FOR_PLANNING"
                ? "Planning is durably queued. The worker will pick it up."
                : "The Product Agent is preparing your plan."}{" "}
              This page refreshes every two seconds.
            </div>
          )}
          {t.failureCode && (
            <div className="error">
              Planning failed: {t.failureCode}. Review the run history, correct
              the provider configuration if needed, then retry.
            </div>
          )}
          {t.status === "PLAN_APPROVED" && (
            <div className="success">
              Plan approved. Development becomes available in Milestone 2.
            </div>
          )}
          {["CANCELLED", "REJECTED"].includes(t.status) && (
            <div className="notice">
              This task is closed. Its plans and run history are preserved.
            </div>
          )}
          <section className="panel plan">
            <div className="section-head">
              <div>
                <div className="eyebrow">PRODUCT AGENT OUTPUT</div>
                <h2>Structured plan</h2>
              </div>
              {t.plans.length > 0 && (
                <select
                  aria-label="Plan version"
                  value={selected ?? t.currentPlanId ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {t.plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      Version {p.versionNumber}
                      {p.id === t.currentPlanId ? " · Current" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {plan ? (
              <>
                <div className="plan-summary">
                  <p>{plan.content.summary}</p>
                  <Status value={plan.content.complexity} />
                </div>
                <div className="plan-grid">
                  {(
                    [
                      "requirements",
                      "acceptanceCriteria",
                      "assumptions",
                      "openQuestions",
                      "risks",
                    ] as const
                  ).map((k) => (
                    <section key={k}>
                      <h3>
                        {
                          {
                            requirements: "Requirements",
                            acceptanceCriteria: "Acceptance criteria",
                            assumptions: "Assumptions",
                            openQuestions: "Open questions",
                            risks: "Risks",
                          }[k]
                        }
                      </h3>
                      {plan.content[k].length ? (
                        <ul>
                          {plan.content[k].map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">None reported.</p>
                      )}
                    </section>
                  ))}
                  <section>
                    <h3>Implementation steps</h3>
                    <ol>
                      {plan.content.implementationSteps.map((s) => (
                        <li key={s.order}>{s.description}</li>
                      ))}
                    </ol>
                  </section>
                </div>
                {approval && (
                  <div className="approval">
                    <h3>
                      Human decision · <Status value={approval.status} />
                    </h3>
                    {approval.comment && (
                      <p className="preserve">{approval.comment}</p>
                    )}
                    {approval.decidedAt && (
                      <small>
                        {approval.decidedBy} ·{" "}
                        {new Date(approval.decidedAt).toLocaleString()}
                      </small>
                    )}
                    {approval.status === "PENDING" &&
                      t.status === "WAITING_PLAN_APPROVAL" &&
                      plan.id === t.currentPlanId && (
                        <>
                          <p>
                            Review assumptions, open questions, and risks before
                            approving this version.
                          </p>
                          <label>
                            Decision comment
                            <textarea
                              value={comment}
                              onChange={(e) => setComment(e.target.value)}
                              maxLength={4000}
                              placeholder="Required when requesting changes"
                            />
                          </label>
                          <div className="actions">
                            <button
                              className="primary"
                              disabled={!!pending}
                              onClick={() => void command("approve")}
                            >
                              Approve plan
                            </button>
                            <button
                              disabled={!!pending || !comment.trim()}
                              onClick={() => void command("request-changes")}
                            >
                              Request changes
                            </button>
                            <button
                              className="danger"
                              disabled={!!pending}
                              onClick={() => void command("reject")}
                            >
                              Reject plan
                            </button>
                          </div>
                        </>
                      )}
                  </div>
                )}
              </>
            ) : (
              <Empty>
                Your structured plan will appear here after planning completes.
              </Empty>
            )}
          </section>
          <section className="panel">
            <h2>Runs & attempts</h2>
            {!runs.data?.length ? (
              <Empty>No agent runs yet.</Empty>
            ) : (
              runs.data.map((r) => (
                <div className="run" key={r.id}>
                  <div className="section-head">
                    <h3>
                      {r.provider} · {r.model ?? "Model not reported"}
                    </h3>
                    <Status value={r.status} />
                  </div>
                  <small>
                    {r.id} · {r.promptVersion} · {r.attemptCount}/3 attempts
                  </small>
                  {r.failureCode && <p className="error">{r.failureCode}</p>}
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Attempt</th>
                          <th>Status</th>
                          <th>Duration</th>
                          <th>Input / cached / output</th>
                          <th>Estimated USD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.attempts.map((a) => (
                          <tr key={a.id}>
                            <td>
                              #{a.attemptNumber}
                              <small>{a.model ?? "Model not reported"}</small>
                              {a.providerRequestId && (
                                <small title={a.providerRequestId}>
                                  Request {a.providerRequestId}
                                </small>
                              )}
                            </td>
                            <td>
                              {a.status}
                              {a.errorCode && <small>{a.errorCode}</small>}
                            </td>
                            <td>
                              {a.finishedAt
                                ? (
                                    (Date.parse(a.finishedAt) -
                                      Date.parse(a.startedAt)) /
                                    1000
                                  ).toFixed(1) + "s"
                                : "Running"}
                            </td>
                            <td>
                              {[
                                a.inputTokens,
                                a.cachedInputTokens,
                                a.outputTokens,
                              ]
                                .map((n) => n ?? "Not reported")
                                .join(" / ")}
                            </td>
                            <td>
                              {a.estimatedCostUsd ?? "Unknown"}
                              <small>
                                {a.pricingVersion ?? "No price information"}
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </section>
          <section className="panel">
            <h2>Audit timeline</h2>
            {events.data?.items.map((e) => (
              <div className="event" key={e.id}>
                <span className="event-dot" />
                <div>
                  <strong>{e.type.replaceAll("_", " ")}</strong>
                  <small>
                    {e.actorId ?? e.actorType} ·{" "}
                    {new Date(e.createdAt).toLocaleString()}
                  </small>
                  <details>
                    <summary>Event details</summary>
                    <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                    <small>Correlation: {e.correlationId}</small>
                  </details>
                </div>
              </div>
            ))}
            {events.data && (
              <Pager
                page={eventPage}
                total={events.data.total}
                onPage={setEventPage}
              />
            )}
          </section>
        </>
      )}
    </>
  );
}
