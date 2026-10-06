"use client";
import { useState } from "react";
import Link from "next/link";
import { ProjectView, pageOf } from "@company/contracts";
import {
  api,
  useData,
  Heading,
  ErrorBox,
  Loading,
  Empty,
  Pager,
} from "../../components/ui";
const schema = pageOf(ProjectView);
const contextKeys = [
  "product",
  "architecture",
  "codingStandards",
  "testing",
  "security",
  "decisions",
] as const;
export default function Projects() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useData(
    `/projects?page=${page}`,
    schema,
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  return (
    <>
      <Heading eyebrow="PROJECTS" title="A home for every idea.">
        Keep product context and planning decisions together.
      </Heading>
      <ErrorBox message={error || problem} />
      <div className="columns">
        <section>
          <h2>
            Your projects <span className="count">{data?.total ?? 0}</span>
          </h2>
          {loading ? (
            <Loading />
          ) : data?.items.length ? (
            data.items.map((p) => (
              <Link
                className="project-card"
                href={"/projects/" + p.id}
                key={p.id}
              >
                <div className="project-icon">{p.name.charAt(0)}</div>
                <div>
                  <h3>{p.name}</h3>
                  <p>{p.description}</p>
                  <small>
                    Context v{p.contextVersion} · {p.status}
                  </small>
                </div>
                <span>↗</span>
              </Link>
            ))
          ) : (
            <Empty>No projects yet. Add your first project to begin.</Empty>
          )}
          {data && <Pager page={page} total={data.total} onPage={setPage} />}
        </section>
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            setPending(true);
            setProblem("");
            try {
              await api("/projects", ProjectView, {
                name: f.get("name"),
                description: f.get("description"),
                context: Object.fromEntries(
                  contextKeys.map((k) => [k, f.get(k) ?? ""]),
                ),
              });
              form.reset();
              await reload();
            } catch (e) {
              setProblem(e instanceof Error ? e.message : "Failed");
            } finally {
              setPending(false);
            }
          }}
        >
          <h2>Create a project</h2>
          <label>
            Project name
            <input
              name="name"
              required
              maxLength={160}
              placeholder="Sample Notes App"
            />
          </label>
          <label>
            Description
            <textarea
              name="description"
              required
              maxLength={10000}
              placeholder="What does this project do?"
            />
          </label>
          <details>
            <summary>
              Project context{" "}
              <span className="muted">Optional, recommended</span>
            </summary>
            {contextKeys.map((k) => (
              <label key={k}>
                {k === "codingStandards"
                  ? "Coding standards"
                  : k.charAt(0).toUpperCase() + k.slice(1)}
                <textarea name={k} maxLength={10000} />
              </label>
            ))}
          </details>
          <button className="primary" disabled={pending}>
            {pending ? "Creating…" : "Create project"}
          </button>
        </form>
      </div>
    </>
  );
}
