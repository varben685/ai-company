"use client";
import { useState } from "react";
import { SessionView } from "@company/contracts";
import { api, ErrorBox, Heading } from "../../components/ui";
export default function Login() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <>
      <Heading eyebrow="LOCAL OPERATOR" title="Welcome to your workspace">
        Sign in to turn a task into a plan you can review.
      </Heading>
      <form
        className="panel login"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError("");
          const form = new FormData(e.currentTarget);
          try {
            await api("/auth/login", SessionView, {
              password: form.get("password"),
            });
            window.location.assign("/dashboard");
          } catch (e) {
            setError(e instanceof Error ? e.message : "Sign-in failed");
          } finally {
            setPending(false);
          }
        }}
      >
        <h2>Operator sign-in</h2>
        <label>
          Operator password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
          />
        </label>
        <ErrorBox message={error} />
        <button className="primary" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted">
          Use the local password generated during setup. Your session lasts
          eight hours.
        </p>
      </form>
    </>
  );
}
