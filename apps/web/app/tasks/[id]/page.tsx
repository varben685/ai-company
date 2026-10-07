"use client";
import { use, useState, useEffect } from "react";
import Link from "next/link";
import { z } from "zod";
import {
  TaskDetail,
  RunView,
  EventView,
  DevelopmentView,
  pageOf,
} from "@company/contracts";
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
  [
    "QUEUED_FOR_PLANNING",
    "PLANNING",
    "QUEUED_FOR_IMPLEMENTATION",
    "IMPLEMENTING",
    "QUEUED_FOR_VALIDATION",
    "VALIDATING",
    "QUEUED_FOR_REVIEW",
    "REVIEWING",
  ].includes(t.status);
const artifactContent = z.object({ content: z.string() });
function ArtifactText({ id, label }: { id: string; label: string }) {
  const { data, error, loading } = useData(
    `/artifacts/${id}/content`,
    artifactContent,
  );
  return (
    <details className="panel">
      <summary>{label}</summary>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <pre className="preserve" style={{ overflowX: "auto", maxHeight: 420 }}>
          {data?.content}
        </pre>
      )}
    </details>
  );
}
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
  const development = useData(
    `/tasks/${id}/development`,
    DevelopmentView,
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
    await Promise.all([
      task.reload(),
      runs.reload(),
      events.reload(),
      development.reload(),
    ]);
  };
  const reloadRuns = runs.reload;
  const reloadEvents = events.reload;
  const reloadDevelopment = development.reload;
  useEffect(() => {
    if (t?.version) {
      void reloadRuns();
      void reloadEvents();
      void reloadDevelopment();
    }
  }, [t?.version, reloadRuns, reloadEvents, reloadDevelopment]);
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
      } else if (action === "develop") {
        if (!t.approvedPlanId) return;
        await api(
          `/tasks/${id}/develop`,
          accepted,
          {
            approvedPlanId: t.approvedPlanId,
            expectedTaskVersion: t.version,
            sourceId: "sample-todo-v1",
          },
          crypto.randomUUID(),
        );
      } else if (action === "retry-stage") {
        const stage = t.failureStage;
        const targetId =
          stage === "VALIDATION"
            ? development.data?.validations.findLast(
                (v) => v.status === "ERROR",
              )?.id
            : runs.data?.findLast(
                (r) => r.agentType === stage && r.status === "FAILED",
              )?.id;
        if (!stage || !targetId)
          throw Error(
            "Failed stage evidence is unavailable. Refresh the page.",
          );
        await api(
          `/tasks/${id}/retry-stage`,
          accepted,
          { expectedTaskVersion: t.version, failureStage: stage, targetId },
          crypto.randomUUID(),
        );
      } else if (action === "approve-code" || action === "reject-code") {
        const final = t.approvals.find(
          (a) => a.type === "FINAL_CODE" && a.status === "PENDING",
        );
        const target = final?.targetSnapshot as
          | {
              candidateArtifactId?: string;
              candidateHash?: string;
              validationRunId?: string;
              reviewArtifactId?: string;
            }
          | undefined;
        if (
          !final ||
          !target?.candidateArtifactId ||
          !target.candidateHash ||
          !target.validationRunId ||
          !target.reviewArtifactId
        )
          throw Error("Final approval target is missing. Refresh the page.");
        await api(
          `/approvals/${final.id}/${action === "approve-code" ? "approve" : "reject"}`,
          accepted,
          {
            candidateArtifactId: target.candidateArtifactId,
            candidateHash: target.candidateHash,
            validationRunId: target.validationRunId,
            reviewArtifactId: target.reviewArtifactId,
            expectedTaskVersion: t.version,
            ...(comment ? { comment } : {}),
          },
          crypto.randomUUID(),
        );
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
      <Heading eyebrow="TASK DETAIL" title={t?.title ?? "Task"}>
        {t?.description}
      </Heading>
      <ErrorBox
        message={
          error || task.error || runs.error || events.error || development.error
        }
      />
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
              {t.status === "PLAN_APPROVED" && (
                <button
                  className="primary"
                  disabled={!!pending}
                  onClick={() => void command("develop")}
                >
                  Start development
                </button>
              )}
              {t.status === "FAILED" && (
                <button
                  className="primary"
                  disabled={!!pending}
                  onClick={() =>
                    void command(
                      t.failureStage && t.failureStage !== "PRODUCT"
                        ? "retry-stage"
                        : "retry",
                    )
                  }
                >
                  Retry{" "}
                  {t.failureStage && t.failureStage !== "PRODUCT"
                    ? t.failureStage.toLowerCase()
                    : "planning"}
                </button>
              )}
              {!["PLAN_APPROVED", "REJECTED", "CANCELLED", "DONE"].includes(
                t.status,
              ) && (
                <button
                  disabled={!!pending}
                  onClick={() => void command("cancel")}
                >
                  {["HUMAN_REVIEW_REQUIRED", "BLOCKED"].includes(t.status)
                    ? "Close task"
                    : "Cancel task"}
                </button>
              )}
            </div>
          </div>
          {pending && <p role="status">Saving {pending}…</p>}
          {active(t) && (
            <div className="notice" role="status">
              {t.status === "QUEUED_FOR_PLANNING"
                ? "Planning is durably queued."
                : t.status === "PLANNING"
                  ? "The Product Agent is preparing your plan."
                  : `${t.status.replaceAll("_", " ")} · round ${development.data?.session.currentRound ?? 1} of 3.`}{" "}
              This page refreshes every two seconds.
            </div>
          )}
          {t.failureCode && (
            <div className="error">
              {t.failureStage ?? "Planning"} failed: {t.failureCode}. Review the
              run history and retry that stage after resolving the cause.
            </div>
          )}
          {t.status === "PLAN_APPROVED" && (
            <div className="success">
              Plan approved. Start development explicitly for a matching
              sample-todo-v1 project and feature.
            </div>
          )}
          {t.status === "HUMAN_REVIEW_REQUIRED" && (
            <div className="notice">
              Three review rounds finished without a passing candidate. No
              fourth run will start automatically.
            </div>
          )}
          {t.status === "BLOCKED" && (
            <div className="notice">
              Development is blocked. Review the run and audit evidence; no
              automatic retry is scheduled.
            </div>
          )}
          {t.status === "DONE" && (
            <div className="success">
              The exact code package was approved. No merge or deployment
              occurred.
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
          {development.data && (
            <section className="panel">
              <div className="section-head">
                <div>
                  <div className="eyebrow">DEVELOPMENT SESSION</div>
                  <h2>Code, validation & review</h2>
                </div>
                <Status value={development.data.session.status} />
              </div>
              <p>
                Source {development.data.session.sourceId} v
                {development.data.session.sourceVersion} · round{" "}
                {development.data.session.currentRound}/3 · baseline{" "}
                {development.data.session.baselineHash.slice(0, 16)}…
              </p>
              {development.data.artifacts
                .filter((a) => a.kind === "CANDIDATE")
                .map((a) => (
                  <div key={a.id} className="run">
                    <h3>Candidate · round {a.round}</h3>
                    <p className="muted">
                      Immutable artifact {a.hash} · {a.byteSize} bytes
                    </p>
                    <a
                      className="button"
                      href={`/api/artifacts/${a.id}/download`}
                    >
                      Download code package
                    </a>
                    {development.data?.artifacts
                      .filter((d) => d.kind === "DIFF" && d.round === a.round)
                      .map((d) => (
                        <ArtifactText
                          key={d.id}
                          id={d.id}
                          label={`Cumulative diff · round ${d.round}`}
                        />
                      ))}
                  </div>
                ))}
              {development.data.validations.map((v) => (
                <div key={v.id} className="run">
                  <h3>
                    Independent validation · round {v.round}{" "}
                    <Status value={v.status} />
                  </h3>
                  {v.report !== null && (
                    <pre
                      className="preserve"
                      style={{ overflowX: "auto", maxHeight: 320 }}
                    >
                      {JSON.stringify(v.report, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
              {development.data.reviews.map((r) => (
                <div key={r.id} className="run">
                  <h3>
                    {r.provider} Reviewer · round {r.round}{" "}
                    <Status value={r.status} />
                  </h3>
                  {r.outputArtifactId && (
                    <ArtifactText
                      id={r.outputArtifactId}
                      label="Readonly Reviewer report"
                    />
                  )}
                </div>
              ))}
              {t.status === "WAITING_FINAL_APPROVAL" &&
                (() => {
                  const final = t.approvals.find(
                    (a) => a.type === "FINAL_CODE" && a.status === "PENDING",
                  );
                  const target = final?.targetSnapshot as
                    { candidateHash?: string } | undefined;
                  return final ? (
                    <div className="approval">
                      <h3>Human final code decision</h3>
                      <p>
                        Approve only this candidate:{" "}
                        <strong>{target?.candidateHash}</strong>
                      </p>
                      <p>
                        Inspect the cumulative diff, validation checks and
                        separate Reviewer report first.
                      </p>
                      <label>
                        Decision comment
                        <textarea
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          maxLength={4000}
                        />
                      </label>
                      <div className="actions">
                        <button
                          className="primary"
                          disabled={!!pending}
                          onClick={() => void command("approve-code")}
                        >
                          Approve exact code package
                        </button>
                        <button
                          className="danger"
                          disabled={!!pending}
                          onClick={() => void command("reject-code")}
                        >
                          Reject code package
                        </button>
                      </div>
                    </div>
                  ) : null;
                })()}
            </section>
          )}
          <section className="panel">
            <h2>Runs & attempts</h2>
            {!runs.data?.length ? (
              <Empty>No agent runs yet.</Empty>
            ) : (
              runs.data.map((r) => (
                <div className="run" key={r.id}>
                  <div className="section-head">
                    <h3>
                      {r.agentType} {r.round ? `· round ${r.round}` : ""} ·{" "}
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
                                {a.modelCalls.length
                                  ? `${a.modelCalls.length} model call(s) · ${a.unknownModelCalls} unknown`
                                  : (a.pricingVersion ??
                                    "No price information")}
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {r.attempts.some(
                    (a) => a.modelCalls.length || a.toolExecutions.length,
                  ) && (
                    <div className="stack">
                      {r.attempts.map((a) => (
                        <details key={a.id}>
                          <summary>
                            Attempt #{a.attemptNumber} · {a.modelCalls.length}{" "}
                            model calls · {a.toolExecutions.length} tools
                          </summary>
                          {a.modelCalls.map((c) => (
                            <p className="muted" key={c.id}>
                              Model call {c.sequence}: {c.status} ·{" "}
                              {c.model ?? "model unknown"} ·{" "}
                              {c.inputTokens ?? "?"} input /{" "}
                              {c.outputTokens ?? "?"} output · $
                              {c.estimatedCostUsd ?? "unknown"} ·{" "}
                              {c.pricingVersion ?? "price unknown"}
                            </p>
                          ))}
                          {a.toolExecutions.map((x) => (
                            <p className="muted" key={x.id}>
                              Tool {x.name}: {x.outcome} · {x.durationMs}ms ·{" "}
                              {x.inputSummary}
                            </p>
                          ))}
                        </details>
                      ))}
                    </div>
                  )}
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
