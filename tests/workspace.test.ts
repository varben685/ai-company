import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  DockerWorkspaceBackend,
  builtinSource,
  collectSnapshot,
  dockerImageId,
  snapshotHash,
  tarSnapshot,
  validateCandidate,
} from "@company/workspace";
import { demoTodoImplementation } from "@company/workspace/src/demo";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
describe("real Docker workspace boundary", () => {
  it("runs unprivileged, offline, with readonly root and immutable validated candidate", async () => {
    const image = await dockerImageId();
    expect(image).toMatch(/^sha256:/);
    const { snapshot } = await builtinSource();
    const backend = new DockerWorkspaceBackend();
    const h = await backend.prepareAttempt({
      attemptId: randomUUID(),
      token: randomUUID(),
      snapshot,
      owned: async () => true,
    });
    try {
      const inspect = JSON.parse(
        execFileSync("docker", ["inspect", h.container], { encoding: "utf8" }),
      )[0];
      expect(inspect.HostConfig.NetworkMode).toBe("none");
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspect.Config.User).toBe("10001:10001");
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(inspect.Mounts).toHaveLength(1);
      expect(inspect.HostConfig.Tmpfs["/tmp"]).toContain("size=64m");
      expect(inspect.Mounts[0].Source).toBe(h.workdir);
      expect(inspect.Mounts[0].Destination).toBe("/workspace");
      expect(inspect.Config.Env.join(" ")).not.toContain("OPENAI_API_KEY");
      const boundary = JSON.parse(
        execFileSync(
          "docker",
          [
            "exec",
            h.container,
            "node",
            "-e",
            `
        const fs=require('node:fs');let rootWritable=true;
        try{fs.writeFileSync('/etc/m2-isolation-test','x')}catch{rootWritable=false}
        process.stdout.write(JSON.stringify({uid:process.getuid(),rootWritable,socket:fs.existsSync('/var/run/docker.sock'),key:!!process.env.OPENAI_API_KEY}));
      `,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(boundary).toEqual({
        uid: 10001,
        rootWritable: false,
        socket: false,
        key: false,
      });
      const network = execFileSync(
        "docker",
        [
          "exec",
          h.container,
          "node",
          "-e",
          `
        const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443,timeout:1500});
        s.on('connect',()=>{process.stdout.write('CONNECTED');s.destroy()});
        s.on('error',e=>process.stdout.write(e.code));s.on('timeout',()=>{process.stdout.write('TIMEOUT');s.destroy()});
      `,
        ],
        { encoding: "utf8" },
      );
      expect(network).not.toContain("CONNECTED");
      expect((await backend.runCommand(h, "unit-tests")).exitCode).toBe(0);
      await expect(
        backend.runCommand(h, "unit-tests;id" as "unit-tests"),
      ).rejects.toThrow("UNKNOWN_COMMAND_ID");
      await expect(
        backend.tool(h, {
          op: "read",
          path: "../../.env.worker",
          startLine: 1,
          endLine: 2,
        }),
      ).rejects.toThrow();
      await expect(
        backend.tool(h, {
          op: "write",
          path: ".env",
          content: "x",
          expectedHash: null,
        }),
      ).rejects.toThrow();
      const original = snapshot.files.find((f) => f.path === "src/todo.js")!;
      await backend.tool(h, {
        op: "write",
        path: "src/todo.js",
        content: demoTodoImplementation,
        expectedHash: hash(
          Buffer.from(original.content, "base64").toString("utf8"),
        ),
      });
      const draft = await backend.freezeCandidate(h, snapshot);
      expect(draft.changedFiles).toContain("src/todo.js");
      expect(draft.diff).toContain("setCompleted");
      expect(draft.snapshot.hash).not.toBe(snapshot.hash);
      await expect(backend.tool(h, { op: "list" })).rejects.toThrow(
        "STALE_ATTEMPT",
      );
      const store = new ArtifactStore();
      const a = await store.publish(draft.snapshot);
      expect((await store.read(a.storageKey, a.hash)).hash).toBe(
        draft.snapshot.hash,
      );
      expect(
        execFileSync("tar", ["-tf", "-"], {
          input: tarSnapshot(draft.snapshot),
          encoding: "utf8",
        }),
      ).toContain("src/todo.js");
      expect((await validateCandidate(draft.snapshot, image)).status).toBe(
        "PASS",
      );
      expect((await validateCandidate(snapshot, image)).status).toBe("FAIL");
      const tampered = {
        ...draft.snapshot,
        files: draft.snapshot.files.map((f) =>
          f.path === "test/regression.test.mjs"
            ? { ...f, content: Buffer.from("// no tests\n").toString("base64") }
            : f,
        ),
      };
      await expect(
        validateCandidate(
          { ...tampered, hash: snapshotHash(tampered.files) },
          image,
        ),
      ).resolves.toMatchObject({ status: "FAIL", checks: [] });
    } finally {
      await backend.cleanup(h);
    }
  }, 120000);

  it("rejects links, oversized files and stale ownership before publication", async () => {
    const { snapshot } = await builtinSource();
    const backend = new DockerWorkspaceBackend();
    let owned = true;
    const h = await backend.prepareAttempt({
      attemptId: randomUUID(),
      token: randomUUID(),
      snapshot,
      owned: async () => owned,
    });
    try {
      await fs.symlink("/etc/passwd", path.join(h.workdir, "src", "escape.js"));
      await expect(collectSnapshot(h.workdir)).rejects.toThrow(
        "UNSAFE_FILE_TYPE",
      );
      await fs.rm(path.join(h.workdir, "src", "escape.js"));
      await fs.link(
        path.join(h.workdir, "src", "todo.js"),
        path.join(h.workdir, "src", "duplicate.js"),
      );
      await expect(collectSnapshot(h.workdir)).rejects.toThrow(
        "HARDLINK_DENIED",
      );
      await fs.rm(path.join(h.workdir, "src", "duplicate.js"));
      await fs.writeFile(
        path.join(h.workdir, "src", "huge.js"),
        "x".repeat(256 * 1024 + 1),
      );
      await expect(collectSnapshot(h.workdir)).rejects.toThrow(
        "FILE_TOO_LARGE",
      );
      await fs.rm(path.join(h.workdir, "src", "huge.js"));
      owned = false;
      await expect(backend.freezeCandidate(h, snapshot)).rejects.toThrow(
        "STALE_ATTEMPT",
      );
    } finally {
      await backend.cleanup(h);
    }
  }, 120000);
  it("rejects empty candidates, tracks added and deleted files, and preserves referenced artifacts during cleanup", async () => {
    const { snapshot } = await builtinSource();
    const backend = new DockerWorkspaceBackend();
    const empty = await backend.prepareAttempt({
      attemptId: randomUUID(),
      token: randomUUID(),
      snapshot,
      owned: async () => true,
    });
    try {
      await expect(backend.freezeCandidate(empty, snapshot)).rejects.toThrow(
        "EMPTY_DIFF",
      );
    } finally {
      await backend.cleanup(empty);
    }
    const h = await backend.prepareAttempt({
      attemptId: randomUUID(),
      token: randomUUID(),
      snapshot,
      owned: async () => true,
    });
    const root = path.join(".local", "m2-gc-test-" + randomUUID());
    try {
      await fs.writeFile(
        path.join(h.workdir, "src", "helper.js"),
        "export const help = true;\n",
      );
      await fs.rm(path.join(h.workdir, "README.md"));
      const draft = await backend.freezeCandidate(h, snapshot);
      expect(draft.changedFiles).toEqual(["README.md", "src/helper.js"]);
      expect(draft.diff).toContain("/dev/null");
      const store = new ArtifactStore(root);
      const candidate = await store.publish(draft.snapshot);
      const orphan = await store.publishText("orphan");
      expect(
        await store.garbageCollect(new Set([candidate.storageKey]), 0),
      ).toBe(1);
      expect(
        (await store.read(candidate.storageKey, candidate.hash)).hash,
      ).toBe(draft.snapshot.hash);
      await expect(
        store.readText(orphan.storageKey, orphan.hash),
      ).rejects.toThrow();
    } finally {
      await backend.cleanup(h);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
