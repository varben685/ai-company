"use client";
import { use, useState } from "react";
import Link from "next/link";
import { ProjectView, TaskView, pageOf } from "@company/contracts";
import {
  api,
  useData,
  Heading,
  ErrorBox,
  Loading,
  Empty,
  Status,
  Pager,
} from "../../../components/ui";
const schema = pageOf(TaskView);
export default function Project({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const project = useData("/projects/" + id, ProjectView);
  const tasks = useData(
    `/projects/${id}/tasks?page=${page}${filter ? "&status=" + filter : ""}`,
    schema,
    (d) =>
      d.items.some((t) =>
        ["QUEUED_FOR_PLANNING", "PLANNING"].includes(t.status),
      ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (project.loading) return <Loading />;
  return (
    <>
      <Heading
        eyebrow="PROJECT WORKSPACE"
        title={project.data?.name ?? "Project"}
      >
        {project.data?.description}
      </Heading>
      <ErrorBox message={project.error || tasks.error || error} />
      {project.data && (
        <details className="panel">
          <summary>
            Project context · version {project.data.contextVersion}
          </summary>
          <div className="context-grid">
            {Object.entries(project.data.context).map(([k, v]) => (
              <div key={k}>
                <h3>{k}</h3>
                <p className="preserve">{v || "Not supplied"}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="columns">
        <section>
          <div className="section-head">
            <h2>
              Tasks <span className="count">{tasks.data?.total ?? 0}</span>
            </h2>
            <select
              aria-label="Filter task status"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {[
                "DRAFT",
                "QUEUED_FOR_PLANNING",
                "PLANNING",
                "WAITING_PLAN_APPROVAL",
                "PLAN_APPROVED",
                "FAILED",
                "REJECTED",
                "CANCELLED",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          {tasks.loading ? (
            <Loading />
          ) : tasks.data?.items.length ? (
            tasks.data.items.map((t) => (
              <Link className="task-card" href={"/tasks/" + t.id} key={t.id}>
                <div>
                  <small>{t.priority} PRIORITY</small>
                  <h3>{t.title}</h3>
                </div>
                <Status value={t.status} />
              </Link>
            ))
          ) : (
            <Empty>No tasks in this view.</Empty>
          )}
          {tasks.data && (
            <Pager page={page} total={tasks.data.total} onPage={setPage} />
          )}
        </section>
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setPending(true);
            setError("");
            try {
              const task = await api(`/projects/${id}/tasks`, TaskView, {
                title: f.get("title"),
                description: f.get("description"),
                priority: f.get("priority"),
              });
              window.location.assign("/tasks/" + task.id);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Failed");
            } finally {
              setPending(false);
            }
          }}
        >
          <h2>Add a task</h2>
          <label>
            Task title
            <input name="title" required maxLength={200} />
          </label>
          <label>
            What should change?
            <textarea name="description" required maxLength={16000} rows={6} />
          </label>
          <label>
            Priority
            <select name="priority" defaultValue="NORMAL">
              {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={pending}>
            {pending ? "Creating…" : "Create task"}
          </button>
          <p className="muted">Planning starts only when you ask for it.</p>
        </form>
      </div>
    </>
  );
}
