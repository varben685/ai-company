import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const SOURCE_ID = "sample-todo-v1" as const;
export const SOURCE_VERSION = "1";
export const BASELINE_SHA256 =
  "9139cb122939a36bcf5b7d8e530382dfde3264d1bfd0bcea98c965797c36b8bd";
export const POLICY_VERSION = "sample-policy-v1";
export const VALIDATOR_VERSION = "sample-validator-v1";
export const IMAGE_REF =
  "node@sha256:775ba24d35a13e74dedce1d2af4ad510337b68d8e22be89e0ce2ccc299329083";
export const MAX_FILE = 256 * 1024;
export const MAX_TOTAL = 5 * 1024 * 1024;
export const MAX_FILES = 200;
export const MAX_TOOL_OUTPUT = 32 * 1024;
const maxCommandOutput = 128 * 1024;
const fixture = path.resolve(
  process.cwd(),
  "packages/workspace/fixtures",
  SOURCE_ID,
);
const acceptance = path.resolve(
  process.cwd(),
  "packages/workspace/acceptance",
  SOURCE_ID,
);
const ACCEPTANCE_SHA256 =
  "96c4212a4343a2461fdff4122b25055eec4bc1f6e8e0f41908d03c157174fe51";
const REGRESSION_SHA256 =
  "ff78685698699ce5ff0aeed6b9ae7b11f7b59df33a47fd8f02d54832e9b05ae6";
export const localRoot = path.resolve(process.cwd(), ".local");
export const INSTANCE_ID = createHash("sha256")
  .update(localRoot)
  .digest("hex")
  .slice(0, 12);
export const workspaceContainerName = (attemptId: string) =>
  `ai-company-m2-${INSTANCE_ID}-${attemptId}`;

export type SnapshotFile = { path: string; mode: number; content: string };
export type Snapshot = {
  sourceId: typeof SOURCE_ID;
  sourceVersion: string;
  files: SnapshotFile[];
  hash: string;
};
export type SourceInfo = {
  sourceId: typeof SOURCE_ID;
  sourceVersion: string;
  baselineHash: string;
  policyVersion: string;
  validatorVersion: string;
};
export type CommandId = "unit-tests" | "syntax-check";
export type CommandResult = {
  commandId: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
};
export type WorkspaceHandle = {
  attemptId: string;
  token: string;
  workdir: string;
  container: string;
  imageId: string;
  stopped: boolean;
  owned: () => Promise<boolean>;
};
export type CandidateDraft = {
  snapshot: Snapshot;
  diff: string;
  changedFiles: string[];
};

export class WorkspaceError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const RelativeFile = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (p) =>
      !path.posix.isAbsolute(p) &&
      !p.includes("\\") &&
      !p
        .split("/")
        .some((s) => !s || s === "." || s === ".." || s.startsWith(".")) &&
      /^(README\.md|package\.json|src\/[A-Za-z0-9_-]+\.js|test\/[A-Za-z0-9_-]+\.test\.mjs)$/.test(
        p,
      ),
    "DISALLOWED_PATH",
  );
function allowed(p: string) {
  return RelativeFile.parse(p);
}
const hashBytes = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
function canonical(files: SnapshotFile[]) {
  return JSON.stringify(files.map((f) => [f.path, f.mode, f.content]));
}
export function snapshotHash(files: SnapshotFile[]) {
  return hashBytes(canonical(files));
}

async function walk(root: string, dir = ""): Promise<SnapshotFile[]> {
  const entries = await fs.readdir(path.join(root, dir), {
    withFileTypes: true,
  });
  const files: SnapshotFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    const full = path.join(root, rel);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new WorkspaceError("UNSAFE_FILE_TYPE");
    if (stat.isDirectory()) {
      if (!["src", "test"].includes(rel))
        throw new WorkspaceError("DISALLOWED_PATH");
      files.push(...(await walk(root, rel)));
    } else {
      allowed(rel);
      if (stat.nlink !== 1) throw new WorkspaceError("HARDLINK_DENIED");
      if (stat.size > MAX_FILE) throw new WorkspaceError("FILE_TOO_LARGE");
      const fd = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const now = await fd.stat();
        if (
          !now.isFile() ||
          now.nlink !== 1 ||
          now.size > MAX_FILE ||
          now.ino !== stat.ino
        )
          throw new WorkspaceError("UNSAFE_FILE_TYPE");
        bytes = await fd.readFile();
      } finally {
        await fd.close();
      }
      const decoded = bytes.toString("utf8");
      if (!Buffer.from(decoded, "utf8").equals(bytes) || bytes.includes(0))
        throw new WorkspaceError("NON_UTF8_FILE");
      files.push({
        path: rel,
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
        content: bytes.toString("base64"),
      });
    }
  }
  return files;
}
export async function collectSnapshot(root: string): Promise<Snapshot> {
  const files = (await walk(root)).sort((a, b) => a.path.localeCompare(b.path));
  if (
    files.length > MAX_FILES ||
    files.reduce((n, f) => n + Buffer.from(f.content, "base64").length, 0) >
      MAX_TOTAL
  )
    throw new WorkspaceError("CANDIDATE_TOO_LARGE");
  return {
    sourceId: SOURCE_ID,
    sourceVersion: SOURCE_VERSION,
    files,
    hash: snapshotHash(files),
  };
}
export async function builtinSource(): Promise<{
  info: SourceInfo;
  snapshot: Snapshot;
}> {
  const snapshot = await collectSnapshot(fixture);
  if (snapshot.hash !== BASELINE_SHA256)
    throw new WorkspaceError("SOURCE_MANIFEST_MISMATCH");
  return {
    info: {
      sourceId: SOURCE_ID,
      sourceVersion: SOURCE_VERSION,
      baselineHash: snapshot.hash,
      policyVersion: POLICY_VERSION,
      validatorVersion: VALIDATOR_VERSION,
    },
    snapshot,
  };
}
export async function materialize(snapshot: Snapshot, destination: string) {
  if (
    snapshot.hash !== snapshotHash(snapshot.files) ||
    snapshot.sourceId !== SOURCE_ID
  )
    throw new WorkspaceError("SNAPSHOT_CORRUPT");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const f of snapshot.files) {
    allowed(f.path);
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.length > MAX_FILE) throw new WorkspaceError("FILE_TOO_LARGE");
    const target = path.join(destination, f.path);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o777 });
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o666 });
    await fs.chmod(target, 0o666);
  }
  await fs.chmod(destination, 0o777);
  for (const d of ["src", "test"])
    await fs.chmod(path.join(destination, d), 0o777).catch(() => undefined);
}

type ExecResult = {
  code: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
};
async function execDocker(
  args: string[],
  timeoutMs = 30000,
  input?: string,
  outputLimit = MAX_TOOL_OUTPUT,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let output = "",
      truncated = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (b: Buffer) => {
      if (output.length < outputLimit)
        output += b.toString("utf8").slice(0, outputLimit - output.length);
      else truncated = true;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, truncated, timedOut });
    });
    child.stdin.end(input);
  });
}
export async function dockerImageId() {
  const r = await execDocker(
    ["image", "inspect", IMAGE_REF, "--format", "{{.Id}}"],
    5000,
  );
  if (r.code !== 0 || !r.output.trim().startsWith("sha256:"))
    throw new WorkspaceError("WORKSPACE_UNAVAILABLE");
  return r.output.trim();
}
export function diffSnapshots(
  base: Snapshot,
  candidate: Snapshot,
): CandidateDraft {
  if (
    base.hash !== snapshotHash(base.files) ||
    candidate.hash !== snapshotHash(candidate.files)
  )
    throw new WorkspaceError("SNAPSHOT_CORRUPT");
  const before = new Map(base.files.map((f) => [f.path, f]));
  const after = new Map(candidate.files.map((f) => [f.path, f]));
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter(
      (p) =>
        before.get(p)?.content !== after.get(p)?.content ||
        before.get(p)?.mode !== after.get(p)?.mode,
    );
  const chunks = changedFiles.map((p) => {
    const a = before.get(p),
      b = after.get(p);
    const lines = (f?: SnapshotFile) =>
      f ? Buffer.from(f.content, "base64").toString("utf8").split("\n") : [];
    return [
      `--- ${a ? `a/${p}` : "/dev/null"}`,
      `+++ ${b ? `b/${p}` : "/dev/null"}`,
      ...lines(a).map((l) => `-${l}`),
      ...lines(b).map((l) => `+${l}`),
    ].join("\n");
  });
  return { snapshot: candidate, changedFiles, diff: chunks.join("\n") };
}
export function tarSnapshot(snapshot: Snapshot): Buffer {
  if (snapshot.hash !== snapshotHash(snapshot.files))
    throw new WorkspaceError("SNAPSHOT_CORRUPT");
  const pieces: Buffer[] = [];
  for (const file of snapshot.files) {
    allowed(file.path);
    const body = Buffer.from(file.content, "base64");
    if (body.length > MAX_FILE) throw new WorkspaceError("FILE_TOO_LARGE");
    const head = Buffer.alloc(512);
    const put = (value: string, offset: number, length: number) =>
      head.write(value.slice(0, length), offset, length, "ascii");
    const oct = (n: number, offset: number, length: number) =>
      put(n.toString(8).padStart(length - 1, "0") + "\0", offset, length);
    put(file.path, 0, 100);
    oct(file.mode, 100, 8);
    oct(0, 108, 8);
    oct(0, 116, 8);
    oct(body.length, 124, 12);
    oct(0, 136, 12);
    head.fill(32, 148, 156);
    head[156] = 48;
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const byte of head) sum += byte;
    oct(sum, 148, 8);
    pieces.push(head, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  pieces.push(Buffer.alloc(1024));
  return Buffer.concat(pieces);
}

const fileTool = String.raw`
const fs=require('node:fs'); const path=require('node:path');
let data=''; process.stdin.on('data',b=>{data+=b;if(data.length>300000)process.exit(2)});
process.stdin.on('end',()=>{try{
 const q=JSON.parse(data); const base='/workspace';
 const valid=p=>typeof p==='string' && /^(README\.md|package\.json|src\/[A-Za-z0-9_-]+\.js|test\/[A-Za-z0-9_-]+\.test\.mjs)$/.test(p);
 if(q.path && !valid(q.path)) throw Error('DISALLOWED_PATH');
 const target=q.path?path.join(base,q.path):base;
 const parts=q.path?.split('/')??[]; let current=base;
 for(const p of parts){current=path.join(current,p);if(fs.existsSync(current)){const s=fs.lstatSync(current);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink>1))throw Error('UNSAFE_FILE_TYPE')}}
 if(q.op==='list'){const result=[];for(const d of ['README.md','package.json','src','test']){const p=path.join(base,d);if(!fs.existsSync(p))continue;const s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error('UNSAFE_FILE_TYPE');if(s.isFile())result.push(d);else for(const x of fs.readdirSync(p)){const f=d+'/'+x;if(!valid(f)||!fs.lstatSync(path.join(base,f)).isFile())throw Error('UNSAFE_FILE_TYPE');result.push(f)}}process.stdout.write(JSON.stringify(result.sort().slice(0,Math.min(q.limit??100,200))));}
 else if(q.op==='read'){const b=fs.readFileSync(target);if(b.length>262144)throw Error('FILE_TOO_LARGE');const lines=b.toString('utf8').split('\n');process.stdout.write(JSON.stringify({content:lines.slice(q.startLine-1,q.endLine).join('\n'),totalLines:lines.length}));}
 else if(q.op==='write'){if(Buffer.byteLength(q.content,'utf8')>262144)throw Error('FILE_TOO_LARGE');const old=fs.existsSync(target)?fs.readFileSync(target):null;const h=require('node:crypto').createHash('sha256');if((old?h.update(old).digest('hex'):null)!==q.expectedHash)throw Error('STALE_FILE');fs.mkdirSync(path.dirname(target),{recursive:true});const tmp=target+'.tmp-'+process.pid;fs.writeFileSync(tmp,q.content,{flag:'wx',mode:0o666});fs.renameSync(tmp,target);process.stdout.write(JSON.stringify({hash:require('node:crypto').createHash('sha256').update(q.content).digest('hex')}));}
 else throw Error('UNKNOWN_OPERATION');
}catch(e){process.stderr.write(String(e.message).slice(0,120));process.exitCode=2}});
`;

export class DockerWorkspaceBackend {
  constructor(readonly root = path.join(localRoot, "m2-workspaces")) {}
  async prepareAttempt(input: {
    attemptId: string;
    token: string;
    snapshot: Snapshot;
    owned: () => Promise<boolean>;
  }): Promise<WorkspaceHandle> {
    if (!(await input.owned())) throw new WorkspaceError("STALE_ATTEMPT");
    const imageId = await dockerImageId();
    const workdir = path.join(this.root, input.attemptId);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await materialize(input.snapshot, workdir);
    const container = workspaceContainerName(input.attemptId);
    const args = [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--label",
      "ai-company.m2=workspace",
      "--label",
      `ai-company.m2.instance=${INSTANCE_ID}`,
      "--label",
      `ai-company.m2.attempt=${input.attemptId}`,
      "--user",
      "10001:10001",
      "--read-only",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--pids-limit",
      "64",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
      "--mount",
      `type=bind,src=${workdir},dst=/workspace`,
      "--workdir",
      "/workspace",
      imageId,
      "node",
      "-e",
      "setInterval(() => {}, 1000000)",
    ];
    const result = await execDocker(args, 30000);
    if (result.code !== 0) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new WorkspaceError("WORKSPACE_UNAVAILABLE");
    }
    if (!(await input.owned())) {
      await execDocker(["rm", "-f", container], 5000);
      throw new WorkspaceError("STALE_ATTEMPT");
    }
    return { ...input, workdir, container, imageId, stopped: false };
  }
  private async check(h: WorkspaceHandle) {
    if (h.stopped || !(await h.owned())) {
      await this.terminate(h);
      throw new WorkspaceError("STALE_ATTEMPT");
    }
  }
  async tool(
    h: WorkspaceHandle,
    query:
      | { op: "list"; limit?: number }
      | { op: "read"; path: string; startLine: number; endLine: number }
      | {
          op: "write";
          path: string;
          content: string;
          expectedHash: string | null;
        },
  ) {
    await this.check(h);
    if ("path" in query) allowed(query.path);
    if (
      query.op === "read" &&
      (query.startLine < 1 ||
        query.endLine < query.startLine ||
        query.endLine - query.startLine > 400)
    )
      throw new WorkspaceError("INVALID_SLICE");
    const r = await execDocker(
      ["exec", "-i", h.container, "node", "-e", fileTool],
      5000,
      JSON.stringify(query),
    );
    await this.check(h);
    if (r.timedOut) {
      await this.terminate(h);
      throw new WorkspaceError("TOOL_TIMEOUT");
    }
    if (r.code !== 0)
      throw new WorkspaceError(r.output.trim().slice(0, 120) || "TOOL_FAILED");
    return JSON.parse(r.output) as unknown;
  }
  async runCommand(
    h: WorkspaceHandle,
    commandId: CommandId,
  ): Promise<CommandResult> {
    await this.check(h);
    if (commandId !== "unit-tests" && commandId !== "syntax-check")
      throw new WorkspaceError("UNKNOWN_COMMAND_ID");
    const args =
      commandId === "unit-tests"
        ? ["node", "--test", "test/regression.test.mjs"]
        : ["node", "--check", "src/todo.js"];
    const started = Date.now();
    const r = await execDocker(
      ["exec", "-w", "/workspace", h.container, ...args],
      30000,
      undefined,
      maxCommandOutput,
    );
    if (r.timedOut) await this.terminate(h);
    else await this.check(h);
    return {
      commandId,
      exitCode: r.code,
      timedOut: r.timedOut,
      output: r.output,
      truncated: r.truncated,
      durationMs: Date.now() - started,
    };
  }
  async search(
    h: WorkspaceHandle,
    input: { query: string; paths: string[]; limit: number },
  ) {
    if (
      !input.query ||
      input.query.length > 200 ||
      input.paths.length > 30 ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new WorkspaceError("INVALID_SEARCH");
    const all = (await this.tool(h, { op: "list", limit: 200 })) as string[];
    const selected = input.paths.length ? input.paths.map(allowed) : all;
    const matches: { path: string; line: number; text: string }[] = [];
    for (const p of selected) {
      if (!all.includes(p)) continue;
      const slice = (await this.tool(h, {
        op: "read",
        path: p,
        startLine: 1,
        endLine: 400,
      })) as { content: string };
      for (const [i, line] of slice.content.split("\n").entries())
        if (line.includes(input.query)) {
          matches.push({ path: p, line: i + 1, text: line.slice(0, 300) });
          if (matches.length >= input.limit) return matches;
        }
    }
    return matches;
  }
  async applyPatch(h: WorkspaceHandle, patch: string) {
    if (patch.length > 65536) throw new WorkspaceError("PATCH_TOO_LARGE");
    const match =
      /^\*\*\* Begin Patch\n\*\*\* Update File: ([^\n]+)\n([\s\S]+)\*\*\* End Patch\s*$/.exec(
        patch,
      );
    if (!match) throw new WorkspaceError("INVALID_PATCH");
    const p = allowed(match[1]!);
    const read = (await this.tool(h, {
      op: "read",
      path: p,
      startLine: 1,
      endLine: 400,
    })) as { content: string; totalLines: number };
    if (read.totalLines > 400) throw new WorkspaceError("PATCH_FILE_TOO_LONG");
    const lines = read.content.split("\n");
    const hunk = match[2]!.split("\n").filter((x) => x !== "");
    if (hunk.filter((x) => x.startsWith("@@")).length !== 1)
      throw new WorkspaceError("PATCH_ONE_HUNK_ONLY");
    const old: string[] = [],
      next: string[] = [];
    for (const line of hunk) {
      if (line.startsWith("@@")) continue;
      if (!/^[ +\-]/.test(line)) throw new WorkspaceError("INVALID_PATCH");
      if (line[0] !== "+") old.push(line.slice(1));
      if (line[0] !== "-") next.push(line.slice(1));
    }
    if (!old.length) throw new WorkspaceError("INVALID_PATCH");
    let at = -1;
    for (let i = 0; i <= lines.length - old.length; i++)
      if (old.every((x, j) => lines[i + j] === x)) {
        if (at !== -1) throw new WorkspaceError("AMBIGUOUS_PATCH");
        at = i;
      }
    if (at < 0) throw new WorkspaceError("STALE_PATCH");
    const original = read.content;
    lines.splice(at, old.length, ...next);
    return this.tool(h, {
      op: "write",
      path: p,
      content: lines.join("\n"),
      expectedHash: hashBytes(original),
    });
  }
  async previewDiff(h: WorkspaceHandle, baseline: Snapshot) {
    await this.check(h);
    const snapshot = await collectSnapshot(h.workdir);
    await this.check(h);
    const draft = diffSnapshots(baseline, snapshot);
    return {
      changedFiles: draft.changedFiles,
      diff: draft.diff.slice(0, MAX_TOOL_OUTPUT),
      truncated: draft.diff.length > MAX_TOOL_OUTPUT,
    };
  }
  async terminate(h: WorkspaceHandle) {
    if (h.stopped) return;
    h.stopped = true;
    await execDocker(["rm", "-f", h.container], 10000).catch(() => undefined);
  }
  async freezeCandidate(
    h: WorkspaceHandle,
    baseline: Snapshot,
  ): Promise<CandidateDraft> {
    await this.check(h);
    await this.terminate(h);
    if (!(await h.owned())) throw new WorkspaceError("STALE_ATTEMPT");
    const snapshot = await collectSnapshot(h.workdir);
    const draft = diffSnapshots(baseline, snapshot);
    if (!draft.changedFiles.length) throw new WorkspaceError("EMPTY_DIFF");
    return draft;
  }
  async cleanup(h: WorkspaceHandle) {
    await this.terminate(h);
    await fs.rm(h.workdir, { recursive: true, force: true });
  }
  async reconcileOwnedContainers(activeAttemptIds: Set<string>) {
    const r = await execDocker(
      [
        "ps",
        "-a",
        "--filter",
        "label=ai-company.m2=workspace",
        "--filter",
        `label=ai-company.m2.instance=${INSTANCE_ID}`,
        "--format",
        "{{.Names}}",
      ],
      5000,
    );
    if (r.code !== 0) throw new WorkspaceError("WORKSPACE_UNAVAILABLE");
    for (const name of r.output.split("\n").filter(Boolean)) {
      const prefix = `ai-company-m2-${INSTANCE_ID}-`;
      const id = name.startsWith(prefix) ? name.slice(prefix.length) : "";
      if (id && !activeAttemptIds.has(id))
        await execDocker(["rm", "-f", name], 10000);
    }
  }
  async cleanupRegistered(attemptId: string) {
    if (!/^[0-9a-f-]{36}$/.test(attemptId))
      throw new WorkspaceError("INVALID_ATTEMPT_ID");
    await execDocker(
      ["rm", "-f", workspaceContainerName(attemptId)],
      10000,
    ).catch(() => undefined);
    await fs.rm(path.join(this.root, attemptId), {
      recursive: true,
      force: true,
    });
  }
}

export class ArtifactStore {
  constructor(readonly root = path.join(localRoot, "m2-artifacts")) {}
  async garbageCollect(
    referencedKeys: Set<string>,
    minimumAgeMs = 60 * 60 * 1000,
  ) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let removed = 0;
    for (const name of await fs.readdir(this.root)) {
      if (
        referencedKeys.has(name) ||
        !(
          /^[a-f0-9]{64}\.(json|txt)$/.test(name) ||
          /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name)
        )
      )
        continue;
      const target = path.join(this.root, name);
      const stat = await fs.lstat(target);
      if (stat.isFile() && stat.mtimeMs <= Date.now() - minimumAgeMs) {
        await fs.rm(target);
        removed++;
      }
    }
    return removed;
  }
  async publish(
    snapshot: Snapshot,
  ): Promise<{ hash: string; byteSize: number; storageKey: string }> {
    if (snapshot.hash !== snapshotHash(snapshot.files))
      throw new WorkspaceError("SNAPSHOT_CORRUPT");
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const hash = hashBytes(bytes);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const key = `${hash}.json`;
    const target = path.join(this.root, key);
    const temp = path.join(this.root, `${hash}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    try {
      await fs.link(temp, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await fs.rm(temp, { force: true });
    }
    const stored = await fs.readFile(target);
    if (!stored.equals(bytes))
      throw new WorkspaceError("ARTIFACT_HASH_COLLISION");
    return { hash, byteSize: bytes.length, storageKey: key };
  }
  async publishText(
    content: string,
  ): Promise<{ hash: string; byteSize: number; storageKey: string }> {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_TOTAL)
      throw new WorkspaceError("ARTIFACT_TOO_LARGE");
    const hash = hashBytes(bytes);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const key = `${hash}.txt`;
    const target = path.join(this.root, key);
    const temp = path.join(this.root, `${hash}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    try {
      await fs.link(temp, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await fs.rm(temp, { force: true });
    }
    if (!(await fs.readFile(target)).equals(bytes))
      throw new WorkspaceError("ARTIFACT_HASH_COLLISION");
    return { hash, byteSize: bytes.length, storageKey: key };
  }
  async readText(key: string, expectedHash: string): Promise<string> {
    if (!/^[0-9a-f]{64}\.txt$/.test(key) || key !== `${expectedHash}.txt`)
      throw new WorkspaceError("INVALID_STORAGE_KEY");
    const fd = await fs.open(
      path.join(this.root, key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > MAX_TOTAL)
        throw new WorkspaceError("ARTIFACT_CORRUPT");
      const bytes = await fd.readFile();
      if (hashBytes(bytes) !== expectedHash)
        throw new WorkspaceError("ARTIFACT_CORRUPT");
      return bytes.toString("utf8");
    } finally {
      await fd.close();
    }
  }
  async read(key: string, expectedHash: string): Promise<Snapshot> {
    if (!/^[0-9a-f]{64}\.json$/.test(key) || key !== `${expectedHash}.json`)
      throw new WorkspaceError("INVALID_STORAGE_KEY");
    const fd = await fs.open(
      path.join(this.root, key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > MAX_TOTAL * 2)
        throw new WorkspaceError("ARTIFACT_CORRUPT");
      const bytes = await fd.readFile();
      if (hashBytes(bytes) !== expectedHash)
        throw new WorkspaceError("ARTIFACT_CORRUPT");
      const snapshot = JSON.parse(bytes.toString("utf8")) as Snapshot;
      if (snapshot.hash !== snapshotHash(snapshot.files))
        throw new WorkspaceError("ARTIFACT_CORRUPT");
      return snapshot;
    } finally {
      await fd.close();
    }
  }
}

export async function validateCandidate(
  snapshot: Snapshot,
  imageId: string,
): Promise<{ status: "PASS" | "FAIL" | "ERROR"; checks: CommandResult[] }> {
  if (snapshot.hash !== snapshotHash(snapshot.files))
    throw new WorkspaceError("SNAPSHOT_CORRUPT");
  const acceptanceFile = path.join(acceptance, "feature.test.mjs");
  if (hashBytes(await fs.readFile(acceptanceFile)) !== ACCEPTANCE_SHA256)
    throw new WorkspaceError("ACCEPTANCE_MANIFEST_MISMATCH");
  const regression = snapshot.files.find(
    (f) => f.path === "test/regression.test.mjs",
  );
  if (
    !regression ||
    hashBytes(Buffer.from(regression.content, "base64")) !== REGRESSION_SHA256
  )
    return { status: "FAIL", checks: [] };
  const checkRoot = path.join(localRoot, "m2-validation", randomUUID());
  await materialize(snapshot, checkRoot);
  const checks: CommandResult[] = [];
  const templates: { id: string; args: string[]; extra?: string }[] = [
    { id: "regression", args: ["node", "--test", "test/regression.test.mjs"] },
    {
      id: "acceptance",
      args: ["node", "--test", "/checks/feature.test.mjs"],
      extra: acceptance,
    },
    { id: "syntax", args: ["node", "--check", "src/todo.js"] },
  ];
  try {
    for (const command of templates) {
      const args = [
        "run",
        "--rm",
        "--user",
        "10001:10001",
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--pids-limit",
        "64",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
        "--mount",
        `type=bind,src=${checkRoot},dst=/workspace,readonly`,
        ...(command.extra
          ? ["--mount", `type=bind,src=${command.extra},dst=/checks,readonly`]
          : []),
        "--workdir",
        "/workspace",
        imageId,
        ...command.args,
      ];
      const started = Date.now();
      const r = await execDocker(args, 30000, undefined, maxCommandOutput);
      checks.push({
        commandId: command.id,
        exitCode: r.code,
        timedOut: r.timedOut,
        output: r.output,
        truncated: r.truncated,
        durationMs: Date.now() - started,
      });
      if (r.timedOut) return { status: "ERROR", checks };
    }
    const after = await collectSnapshot(checkRoot);
    if (after.hash !== snapshot.hash) return { status: "ERROR", checks };
    if (hashBytes(await fs.readFile(acceptanceFile)) !== ACCEPTANCE_SHA256)
      return { status: "ERROR", checks };
    return {
      status:
        checks.every(
          (c) =>
            (c.exitCode === 0 && /\btests?\s+[1-9]\d*\b/i.test(c.output)) ||
            (c.commandId === "syntax" && c.exitCode === 0),
        ) &&
        checks
          .filter((c) => c.commandId !== "syntax")
          .every((c) => c.exitCode === 0)
          ? "PASS"
          : "FAIL",
      checks,
    };
  } finally {
    await fs.rm(checkRoot, { recursive: true, force: true });
  }
}
export { demoTodoImplementation } from "./demo";
