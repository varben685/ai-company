"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { z } from "zod";
import { CapabilitiesView, SessionView } from "@company/contracts";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
let csrf: string | null = null;
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  key?: string,
): Promise<T> {
  if (body !== undefined && !csrf && path != "/auth/login") {
    const session = await api("/auth/session", SessionView);
    csrf = session.csrfToken;
  }
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf ?? "",
            ...(key ? { "Idempotency-Key": key } : {}),
          },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const data: unknown = await r.json();
  if (!r.ok) {
    const e = data as { message?: string; code?: string };
    if (r.status === 401 && path != "/auth/login")
      window.location.assign("/login");
    throw new HttpError(
      r.status,
      e.message ?? "The request failed.",
      e.code ?? "REQUEST_FAILED",
    );
  }
  return schema.parse(data);
}
export function useData<T>(
  path: string,
  schema: z.ZodType<T>,
  poll: (data: T) => boolean = () => false,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const d = await api(path, schema);
      setData(d);
      setError("");
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setLoading(false);
    }
  }, [path, schema]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!data || !poll(data)) return;
    const timer = setTimeout(() => void reload(), 2000);
    return () => clearTimeout(timer);
  }, [data, poll, reload]);
  return { data, error, loading, reload };
}
export function ProviderBadge() {
  const [label, setLabel] = useState("Provider: sign in to view");
  useEffect(() => {
    fetch("/api/capabilities")
      .then(async (r) => {
        if (r.ok) setLabel(CapabilitiesView.parse(await r.json()).label);
      })
      .catch(() => setLabel("Provider unavailable"));
  }, []);
  return (
    <>
      <div className="provider">{label}</div>
      {!label.startsWith("Provider") && (
        <button
          className="signout"
          onClick={() =>
            void api("/auth/logout", z.unknown(), {})
              .then(() => window.location.assign("/login"))
              .catch(() =>
                setLabel("Provider: sign-out failed; refresh and retry"),
              )
          }
        >
          Sign out
        </button>
      )}
    </>
  );
}
export function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}
export function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div role="alert" className="error">
      {message} <Link href="/login">Session sign-in</Link>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div role="status" className="empty">
      Loading workspace…
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={"status status-" + value.toLowerCase()}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="pager">
      <button disabled={page === 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} · {total} total
      </span>
      <button disabled={page * 25 >= total} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
export const accepted = z.unknown();
