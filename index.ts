import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { ModelFusionParams } from "./schemas.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

/* ------------------------------------------------------------------ */
/*  Interfaces                                                         */
/* ------------------------------------------------------------------ */

interface CandidateRun {
  model: string;
  branchName: string;
  summary: string;
  diff: string;
  output: string;
  baseCommit: string;
  finalCommit: string;
}

interface CriterionScore {
  criterion: string;
  score: number;
  notes: string;
}

interface JudgeScore {
  model: string;
  score: number;
  notes: string;
  criterionScores?: CriterionScore[];
}

interface JudgeDecision {
  winnerModel: string;
  reasoning: string;
  scores: JudgeScore[];
  finalDiff?: string;
}

type EntryStatus = "pending" | "running" | "completed" | "failed";
type RunPhase = "preparing" | "running_candidates" | "judging" | "applying" | "completed" | "failed";

interface CandidateMonitorEntry {
  model: string;
  branchName: string;
  worktreePath?: string;
  status: EntryStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  diff?: string;
  output?: string;
  baseCommit?: string;
  finalCommit?: string;
  error?: string;
}

interface JudgeMonitorEntry {
  model: string;
  branchName: string;
  worktreePath?: string;
  status: EntryStatus;
  startedAt?: string;
  finishedAt?: string;
  reasoning?: string;
  finalDiff?: string;
  scores?: JudgeScore[];
  error?: string;
}

interface FusionMonitorRun {
  id: string;
  task: string;
  cwd: string;
  repoRoot: string;
  criteria: string[];
  mergeMode: "best_only" | "merge_with_top";
  phase: RunPhase;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  winnerModel?: string;
  finalBranch?: string;
  finalCommit?: string;
  apply?: { ok: boolean; message: string };
  worktreeParentDir: string;
  candidates: CandidateMonitorEntry[];
  judge: JudgeMonitorEntry;
  error?: string;
}

interface MonitorServerInfo {
  port: number;
  url: string;
  startedAt: string;
}

interface MonitorState {
  activeRunId?: string;
  runs: FusionMonitorRun[];
  server?: MonitorServerInfo;
}

interface MonitorRuntime {
  state: MonitorState;
  server?: http.Server;
}

const Details = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  winnerModel: Type.Optional(Type.String()),
  mergeMode: Type.String(),
  applied: Type.Optional(Type.Boolean()),
  judgeModel: Type.String(),
  finalBranch: Type.Optional(Type.String()),
  scores: Type.Optional(Type.Array(Type.Object({
    model: Type.String(),
    score: Type.Number(),
    notes: Type.String(),
    criterionScores: Type.Optional(Type.Array(Type.Object({
      criterion: Type.String(),
      score: Type.Number(),
      notes: Type.String(),
    }))),
  }))),
  error: Type.Optional(Type.String()),
});

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_APP_PATH = path.join(MODULE_DIR, "monitor", "index.html");
const EXTENSION_STORAGE_DIR = path.join(getAgentDir(), "extensions", "model-fusion");
const WORKSPACE_STORAGE_DIR = (process.env.PI_MODEL_FUSION_WORKSPACE_DIR ?? "").trim() || path.join(os.tmpdir(), "pi-mf");
const MONITOR_STATE_PATH = path.join(EXTENSION_STORAGE_DIR, "monitor-state.json");
const KEEP_WORKSPACES = ["1", "true", "yes"].includes((process.env.PI_MODEL_FUSION_KEEP_WORKSPACES ?? "").trim().toLowerCase());
const EXEC_MAX_BUFFER = 50 * 1024 * 1024;
const MAX_MONITOR_RUNS = 20;
const GLOBAL_MONITOR_RUNTIME_KEY = "__pi_model_fusion_monitor_runtime__";

/* ------------------------------------------------------------------ */
/*  Utility helpers                                                    */
/* ------------------------------------------------------------------ */

function extractTaggedBlock(content: string, tag: string): string {
  const rx = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = content.match(rx);
  return m ? m[1].trim() : "";
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "string") {
    const normalized = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function normalizeMergeMode(value: unknown): "best_only" | "merge_with_top" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["best_only", "best-only", "best", "winner_only", "winner-only"].includes(normalized)) return "best_only";
  if (["merge_with_top", "merge-with-top", "merge", "merge_top", "merge-top", "combined"].includes(normalized)) return "merge_with_top";
  return undefined;
}

function normalizeModelFusionArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const input = args as Record<string, unknown>;
  const candidateModels = toStringArray(input.candidateModels) ?? toStringArray(input.models) ?? toStringArray(input.candidateModel);
  const criteria = toStringArray(input.criteria) ?? toStringArray(input.criterion);
  const judgeModel = [input.judgeModel, input.judge, input.evaluatorModel].find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  const mergeMode = normalizeMergeMode(input.mergeMode);
  return {
    ...(typeof input.task === "string" ? { task: input.task } : {}),
    ...(candidateModels ? { candidateModels } : {}),
    ...(judgeModel ? { judgeModel } : {}),
    ...(criteria ? { criteria } : {}),
    ...(mergeMode ? { mergeMode } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
  };
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function sanitize(value: string): string {
  const compact = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/[-._]+$/g, "");
  return `${compact || "ws"}-${shortHash(value)}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const extra = ["stderr", "stdout"]
      .map((key) => {
        const value = (error as Error & Record<string, unknown>)[key];
        if (typeof value === "string") return value.trim();
        if (Buffer.isBuffer(value)) return value.toString("utf-8").trim();
        return "";
      })
      .filter(Boolean);
    return [error.message, ...extra].filter(Boolean).join("\n").trim();
  }
  return String(error);
}

/* ------------------------------------------------------------------ */
/*  Git helpers                                                        */
/* ------------------------------------------------------------------ */

function git(args: string[], cwd: string, encoding?: "utf-8"): string {
  return execFileSync("git", args, {
    cwd,
    encoding: encoding ?? "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
  }) as string;
}

function gitSilent(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe", maxBuffer: EXEC_MAX_BUFFER });
}

function getRepoRoot(cwd: string): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd).trim();
  } catch {
    throw new Error(`model_fusion requires a git repository. '${cwd}' is not inside one.`);
  }
}

function getHead(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}

function writePatchFile(diff: string, prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const patchPath = path.join(tmpDir, "patch.diff");
  fs.writeFileSync(patchPath, diff, "utf-8");
  return patchPath;
}

/** Capture current uncommitted state (tracked diff + untracked file list) */
function getUncommittedState(repoRoot: string): { trackedDiff: string; untrackedFiles: string[] } {
  const trackedDiff = git(["diff", "--binary", "HEAD"], repoRoot);
  const untrackedFiles = git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot)
    .split("\0").map((f) => f.trim()).filter(Boolean);
  return { trackedDiff, untrackedFiles };
}

/**
 * Create a git worktree on a named branch from HEAD, apply the user's
 * uncommitted state, and commit it as "base". Returns the base commit SHA.
 */
function createBranchWorktree(
  repoRoot: string,
  branchName: string,
  worktreePath: string,
  uncommitted: { trackedDiff: string; untrackedFiles: string[] },
): string {
  gitSilent(["worktree", "add", "--force", "-b", branchName, worktreePath, "HEAD"], repoRoot);

  // Apply tracked diff (uncommitted changes)
  if (uncommitted.trackedDiff.trim()) {
    const patchPath = writePatchFile(uncommitted.trackedDiff, "pi-mf-base-");
    gitSilent(["apply", "--whitespace=nowarn", patchPath], worktreePath);
  }

  // Copy untracked files
  for (const file of uncommitted.untrackedFiles) {
    const src = path.join(repoRoot, file);
    const dst = path.join(worktreePath, file);
    ensureDir(path.dirname(dst));
    fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
  }

  // Commit base state
  gitSilent(["add", "-A"], worktreePath);
  const status = git(["status", "--porcelain"], worktreePath).trim();
  if (status) {
    gitSilent(["-c", "user.name=pi-model-fusion", "-c", "user.email=pi-model-fusion@local",
      "commit", "-m", "base: uncommitted state"], worktreePath);
  }

  return getHead(worktreePath);
}

/**
 * Stage all changes in the worktree, commit them, and return the diff
 * between the base commit and the new commit.
 */
function commitAndCaptureDiff(
  worktreePath: string,
  baseCommit: string,
  message: string,
): { diff: string; commitSha: string } {
  gitSilent(["add", "-A"], worktreePath);
  const status = git(["status", "--porcelain"], worktreePath).trim();
  if (status) {
    gitSilent(["-c", "user.name=pi-model-fusion", "-c", "user.email=pi-model-fusion@local",
      "commit", "-m", message], worktreePath);
  }
  const commitSha = getHead(worktreePath);
  const diff = git(["diff", baseCommit, commitSha], worktreePath);
  return { diff, commitSha };
}

/** Remove a worktree directory; best-effort. */
function removeWorktree(repoRoot: string, worktreePath: string): void {
  try {
    gitSilent(["worktree", "remove", "--force", worktreePath], repoRoot);
  } catch {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try { gitSilent(["worktree", "prune"], repoRoot); } catch { /* ignore */ }
  }
}

function applyDiff(diff: string, cwd: string): { ok: boolean; message: string } {
  if (!diff.trim()) return { ok: true, message: "No changes to apply (empty diff)" };
  try {
    const patchPath = writePatchFile(diff, "pi-mf-apply-");
    gitSilent(["apply", "--3way", "--whitespace=nowarn", patchPath], cwd);
    return { ok: true, message: `Applied patch from ${patchPath}` };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

function buildBranchName(runId: string, label: string): string {
  return `pi-model-fusion/${sanitize(runId)}/${sanitize(label)}`;
}

/* ------------------------------------------------------------------ */
/*  Pi sub-process runner                                              */
/* ------------------------------------------------------------------ */

async function runPiPrompt(prompt: string, model: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const command = getPiSpawnCommand(["--no-session", "--model", model, prompt]);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
      reject(new Error("Model fusion run aborted"));
    }, { once: true });

    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`pi exited with ${code}: ${stderr || stdout}`));
    });
    child.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */

function buildCandidatePrompt(task: string): string {
  return [
    "You are producing a code-change candidate for an automated model-fusion pipeline.",
    "You are running inside an isolated git branch. Edit files directly to implement the task.",
    "Your file changes will be captured automatically via git — do NOT output a diff.",
    "When finished, respond with:",
    "<summary>short explanation of your approach</summary>",
    `Task:\n${task}`,
  ].join("\n\n");
}

function buildJudgePrompt(input: {
  task: string;
  criteria: string[];
  mergeMode: "best_only" | "merge_with_top";
  candidates: CandidateRun[];
}): string {
  const candidateText = input.candidates
    .map((c, i) => [
      `Candidate ${i + 1} (${c.model})`,
      `Branch: ${c.branchName}`,
      `Summary:\n${c.summary}`,
      `Diff (captured from git):\n${c.diff}`,
    ].join("\n"))
    .join("\n\n---\n\n");

  const mergeInstruction = input.mergeMode === "merge_with_top"
    ? 'Include a "finalDiff" field with a synthesized unified diff that merges the best parts, anchored on the top-ranked solution.'
    : 'Do NOT include a "finalDiff" field — the winner\'s branch diff will be used directly.';

  return [
    "You are the model-fusion judge. Evaluate candidate code patches for a coding task.",
    mergeInstruction,
    "Return ONLY this XML payload:",
    `<fusion>{"winnerModel":"...","reasoning":"...","scores":[{"model":"...","score":0-100,"notes":"overall summary","criterionScores":[{"criterion":"...","score":0-100,"notes":"..."}]}]${input.mergeMode === "merge_with_top" ? ',"finalDiff":"unified diff"' : ""}}</fusion>`,
    "For every model in scores, include criterionScores with one entry for every scoring criterion, using the exact criterion names.",
    "Scoring criteria:",
    ...input.criteria.map((c, i) => `${i + 1}. ${c}`),
    `Task:\n${input.task}`,
    "Candidates:",
    candidateText,
  ].join("\n\n");
}

function parseJudgeDecision(output: string): JudgeDecision {
  const payload = extractTaggedBlock(output, "fusion");
  if (!payload) throw new Error("Judge output missing <fusion> payload");
  const parsed = JSON.parse(payload) as JudgeDecision;
  if (!parsed.winnerModel) throw new Error("Judge output missing winnerModel");
  return parsed;
}

/* ------------------------------------------------------------------ */
/*  Monitor state management                                           */
/* ------------------------------------------------------------------ */

function getMonitorRuntime(): MonitorRuntime {
  const g = globalThis as typeof globalThis & { [GLOBAL_MONITOR_RUNTIME_KEY]?: MonitorRuntime };
  if (!g[GLOBAL_MONITOR_RUNTIME_KEY]) {
    g[GLOBAL_MONITOR_RUNTIME_KEY] = { state: loadMonitorState() };
  }
  return g[GLOBAL_MONITOR_RUNTIME_KEY]!;
}

function loadMonitorState(): MonitorState {
  try {
    const parsed = JSON.parse(fs.readFileSync(MONITOR_STATE_PATH, "utf-8")) as MonitorState;
    return { activeRunId: parsed.activeRunId, runs: Array.isArray(parsed.runs) ? parsed.runs : [], server: parsed.server };
  } catch {
    return { runs: [] };
  }
}

function persistMonitorState(state: MonitorState): void {
  ensureDir(EXTENSION_STORAGE_DIR);
  fs.writeFileSync(MONITOR_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function getMonitorStateSnapshot(): MonitorState {
  return JSON.parse(JSON.stringify(getMonitorRuntime().state)) as MonitorState;
}

function mutateMonitorState(mutator: (state: MonitorState) => void): void {
  const runtime = getMonitorRuntime();
  mutator(runtime.state);
  runtime.state.runs = runtime.state.runs.slice(-MAX_MONITOR_RUNS);
  persistMonitorState(runtime.state);
}

function mutateRun(runId: string, mutator: (run: FusionMonitorRun) => void): void {
  mutateMonitorState((state) => {
    const run = state.runs.find((r) => r.id === runId);
    if (!run) return;
    mutator(run);
    run.updatedAt = nowIso();
  });
}

function getRunSnapshot(runId: string): FusionMonitorRun | undefined {
  return getMonitorStateSnapshot().runs.find((r) => r.id === runId);
}

function registerRun(run: FusionMonitorRun): void {
  mutateMonitorState((state) => {
    state.activeRunId = run.id;
    state.runs.push(run);
  });
}

function setMonitorServerInfo(info: MonitorServerInfo): void {
  mutateMonitorState((state) => { state.server = info; });
}

/* ------------------------------------------------------------------ */
/*  Progress & status helpers                                          */
/* ------------------------------------------------------------------ */

function buildProgressText(run: FusionMonitorRun): string {
  const done = run.candidates.filter((c) => c.status === "completed").length;
  const failed = run.candidates.filter((c) => c.status === "failed").length;
  return [
    `Run: ${run.id}  Phase: ${run.phase}`,
    `Task: ${run.task}`,
    `Mode: ${run.mergeMode}  Criteria: ${run.criteria.join(", ")}`,
    `Candidates: ${done}/${run.candidates.length} done${failed ? `, ${failed} failed` : ""}`,
    "",
    ...run.candidates.map((c) => {
      const detail = c.error ? ` — ${c.error}` : c.summary ? ` — ${c.summary}` : "";
      return `  ${c.model} [${c.status}] branch:${c.branchName}${detail}`;
    }),
    "",
    `Judge (${run.judge.model}): ${run.judge.status}`,
    ...(run.winnerModel ? [`Winner: ${run.winnerModel}`] : []),
    ...(run.finalBranch ? [`Final branch: ${run.finalBranch}`] : []),
    ...(run.apply ? [`Apply: ${run.apply.ok ? "ok" : "failed"} — ${run.apply.message}`] : []),
    ...(run.error ? [`Error: ${run.error}`] : []),
  ].join("\n");
}

function buildFooterStatus(run: FusionMonitorRun): string {
  const done = run.candidates.filter((c) => c.status === "completed").length;
  const running = run.candidates.filter((c) => c.status === "running").length;
  return `model_fusion ${run.phase} | ${done}/${run.candidates.length} done | ${running} running | judge ${run.judge.status}`;
}

function publishProgress(
  runId: string,
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void,
  ctx?: { hasUI?: boolean; ui?: { setStatus: (key: string, text: string) => void } },
): void {
  const run = getRunSnapshot(runId);
  if (!run) return;
  onUpdate?.({ content: [{ type: "text", text: buildProgressText(run) }] });
  if (ctx?.hasUI && ctx.ui) ctx.ui.setStatus("model-fusion", buildFooterStatus(run));
}

/* ------------------------------------------------------------------ */
/*  Monitor HTTP server                                                */
/* ------------------------------------------------------------------ */

async function ensureMonitorServer(): Promise<string> {
  const runtime = getMonitorRuntime();
  if (runtime.server) {
    const addr = runtime.server.address();
    if (addr && typeof addr !== "string") {
      const url = `http://127.0.0.1:${addr.port}`;
      const state = getMonitorStateSnapshot();
      if (state.server?.url !== url) setMonitorServerInfo({ port: addr.port, url, startedAt: state.server?.startedAt ?? nowIso() });
      return url;
    }
  }

  const html = fs.readFileSync(MONITOR_APP_PATH, "utf-8");
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(getMonitorStateSnapshot()));
      return;
    }
    if (url === "/" || url.startsWith("/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
  runtime.server = server;

  return new Promise<string>((resolve, reject) => {
    server.once("error", (err) => { runtime.server = undefined; reject(err); });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { runtime.server = undefined; reject(new Error("Could not determine server address")); return; }
      const info: MonitorServerInfo = { port: addr.port, url: `http://127.0.0.1:${addr.port}`, startedAt: nowIso() };
      setMonitorServerInfo(info);
      resolve(info.url);
    });
  });
}

function openUrlInBrowser(url: string): void {
  const args = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  const child = spawn(args[0] as string, args[1] as string[], { detached: true, stdio: "ignore" });
  child.unref();
}

/* ------------------------------------------------------------------ */
/*  Main extension registration                                        */
/* ------------------------------------------------------------------ */

export default function registerModelFusionExtension(pi: ExtensionAPI): void {
  const tool: ToolDefinition<typeof ModelFusionParams, Static<typeof Details>> = {
    name: "model_fusion",
    label: "Model Fusion",
    description: "Run coding task against multiple models, rank by custom criteria, and apply best/merged patch.",
    promptSnippet: "Run one coding task across multiple candidate models, judge them against explicit criteria, and apply the best or merged diff.",
    promptGuidelines: [
      "Use model_fusion when the user explicitly asks to compare, rank, vote on, or fuse multiple model-generated code changes.",
      "Gather at least two candidate models, one judge model, and one or more scoring criteria before calling model_fusion.",
      "If the user does not specify merge behavior, prefer best_only unless they explicitly want a synthesized merged patch.",
    ],
    parameters: ModelFusionParams,
    prepareArguments(args) {
      return normalizeModelFusionArguments(args);
    },

    async execute(_id, params, signal, onUpdate, ctx) {
      const cwd = path.resolve(params.cwd ?? process.cwd());
      const mergeMode = (params.mergeMode ?? "best_only") as "best_only" | "merge_with_top";
      const runId = generateRunId();
      const repoRoot = getRepoRoot(cwd);
      const relativeCwd = path.relative(repoRoot, cwd);
      const uncommitted = getUncommittedState(repoRoot);

      // Create worktree parent directory for this run
      ensureDir(WORKSPACE_STORAGE_DIR);
      const worktreeParentDir = fs.mkdtempSync(path.join(WORKSPACE_STORAGE_DIR, "r-"));
      const worktreePaths: string[] = [];

      // Build branch names upfront
      const candidateBranches = params.candidateModels.map((model, i) => ({
        model,
        branchName: buildBranchName(runId, `candidate-${i + 1}-${model}`),
        label: `candidate-${i + 1}-${model}`,
      }));
      const judgeBranchName = buildBranchName(runId, `judge-${params.judgeModel}`);

      const initialRun: FusionMonitorRun = {
        id: runId,
        task: params.task,
        cwd,
        repoRoot,
        criteria: [...params.criteria],
        mergeMode,
        phase: "preparing",
        startedAt: nowIso(),
        updatedAt: nowIso(),
        worktreeParentDir,
        candidates: candidateBranches.map((cb) => ({
          model: cb.model,
          branchName: cb.branchName,
          status: "pending" as EntryStatus,
        })),
        judge: {
          model: params.judgeModel,
          branchName: judgeBranchName,
          status: "pending",
        },
      };

      registerRun(initialRun);
      publishProgress(runId, onUpdate, ctx);

      try {
        // ----------------------------------------------------------
        // Phase 1: Create branch worktrees + run candidates in parallel
        // ----------------------------------------------------------
        mutateRun(runId, (r) => { r.phase = "running_candidates"; });
        publishProgress(runId, onUpdate, ctx);

        const candidates = await Promise.all(candidateBranches.map(async (cb, index) => {
          // Create worktree on named branch
          const worktreePath = path.join(worktreeParentDir, sanitize(cb.label));
          worktreePaths.push(worktreePath);

          const baseCommit = createBranchWorktree(repoRoot, cb.branchName, worktreePath, uncommitted);
          const worktreeCwd = path.join(worktreePath, relativeCwd);

          mutateRun(runId, (r) => {
            const c = r.candidates[index];
            if (!c) return;
            c.worktreePath = worktreeCwd;
            c.baseCommit = baseCommit;
            c.status = "running";
            c.startedAt = nowIso();
          });
          publishProgress(runId, onUpdate, ctx);

          try {
            const output = await runPiPrompt(buildCandidatePrompt(params.task), cb.model, worktreeCwd, signal);
            const summary = extractTaggedBlock(output, "summary") || "(no summary provided)";

            // Commit candidate changes and capture diff from git
            const { diff, commitSha } = commitAndCaptureDiff(
              worktreePath,
              baseCommit,
              `model_fusion: candidate ${cb.model} (${runId})`,
            );

            mutateRun(runId, (r) => {
              const c = r.candidates[index];
              if (!c) return;
              c.status = "completed";
              c.finishedAt = nowIso();
              c.summary = summary;
              c.diff = diff;
              c.output = output;
              c.finalCommit = commitSha;
            });
            publishProgress(runId, onUpdate, ctx);

            return {
              model: cb.model,
              branchName: cb.branchName,
              summary,
              diff,
              output,
              baseCommit,
              finalCommit: commitSha,
            } satisfies CandidateRun;
          } catch (error) {
            mutateRun(runId, (r) => {
              const c = r.candidates[index];
              if (!c) return;
              c.status = "failed";
              c.finishedAt = nowIso();
              c.error = toErrorMessage(error);
            });
            publishProgress(runId, onUpdate, ctx);
            throw error;
          }
        }));

        // ----------------------------------------------------------
        // Phase 2: Judge
        // ----------------------------------------------------------
        mutateRun(runId, (r) => { r.phase = "judging"; });
        publishProgress(runId, onUpdate, ctx);

        // Create judge branch worktree
        const judgeWorktreePath = path.join(worktreeParentDir, sanitize(`judge-${params.judgeModel}`));
        worktreePaths.push(judgeWorktreePath);

        createBranchWorktree(repoRoot, judgeBranchName, judgeWorktreePath, uncommitted);
        const judgeCwd = path.join(judgeWorktreePath, relativeCwd);

        mutateRun(runId, (r) => {
          r.judge.worktreePath = judgeCwd;
          r.judge.status = "running";
          r.judge.startedAt = nowIso();
        });
        publishProgress(runId, onUpdate, ctx);

        const judgeOutput = await runPiPrompt(
          buildJudgePrompt({ task: params.task, criteria: params.criteria, mergeMode, candidates }),
          params.judgeModel,
          judgeCwd,
          signal,
        );

        const decision = parseJudgeDecision(judgeOutput);

        mutateRun(runId, (r) => {
          r.judge.status = "completed";
          r.judge.finishedAt = nowIso();
          r.judge.reasoning = decision.reasoning;
          r.judge.scores = decision.scores;
          r.judge.finalDiff = decision.finalDiff;
          r.winnerModel = decision.winnerModel;
        });
        publishProgress(runId, onUpdate, ctx);

        // ----------------------------------------------------------
        // Phase 3: Determine final diff and apply
        // ----------------------------------------------------------
        mutateRun(runId, (r) => { r.phase = "applying"; });
        publishProgress(runId, onUpdate, ctx);

        let finalDiff: string;
        let finalBranch: string;
        let finalCommit: string | undefined;

        if (mergeMode === "merge_with_top" && decision.finalDiff) {
          // Judge produced a merged diff — create a final branch for it
          finalBranch = buildBranchName(runId, `final-${decision.winnerModel}`);
          const finalWorktreePath = path.join(worktreeParentDir, sanitize(`final-${decision.winnerModel}`));
          worktreePaths.push(finalWorktreePath);

          const finalBaseCommit = createBranchWorktree(repoRoot, finalBranch, finalWorktreePath, uncommitted);
          const finalPatchPath = writePatchFile(decision.finalDiff, "pi-mf-final-");
          const finalWorktreeCwd = path.join(finalWorktreePath, relativeCwd);

          try {
            gitSilent(["apply", "--3way", "--whitespace=nowarn", finalPatchPath], finalWorktreeCwd);
          } catch {
            // If the judge's diff doesn't apply cleanly, fall back to winner's branch diff
            const winner = candidates.find((c) => c.model === decision.winnerModel);
            if (winner?.diff) {
              const fallbackPatch = writePatchFile(winner.diff, "pi-mf-fallback-");
              gitSilent(["apply", "--3way", "--whitespace=nowarn", fallbackPatch], finalWorktreeCwd);
            }
          }

          const result = commitAndCaptureDiff(finalWorktreePath, finalBaseCommit, `model_fusion: final merged (${runId})`);
          finalDiff = result.diff;
          finalCommit = result.commitSha;
        } else {
          // best_only: use winner's branch diff directly
          const winner = candidates.find((c) => c.model === decision.winnerModel);
          if (!winner) throw new Error(`Winner model '${decision.winnerModel}' not found among candidates`);
          finalDiff = winner.diff;
          finalBranch = winner.branchName;
          finalCommit = winner.finalCommit;
        }

        // Apply final diff to original cwd
        const apply = applyDiff(finalDiff, cwd);

        mutateRun(runId, (r) => {
          r.finalBranch = finalBranch;
          r.finalCommit = finalCommit;
          r.apply = apply;
          r.phase = "completed";
          r.finishedAt = nowIso();
        });
        publishProgress(runId, onUpdate, ctx);

        // ----------------------------------------------------------
        // Build result
        // ----------------------------------------------------------
        const monitorUrl = await ensureMonitorServer();
        if (ctx.hasUI) ctx.ui.setStatus("model-fusion", `model_fusion completed | winner ${decision.winnerModel}`);

        return {
          content: [{
            type: "text",
            text: [
              `Winner: ${decision.winnerModel}`,
              `Judge: ${params.judgeModel}`,
              `Mode: ${mergeMode}`,
              `Applied: ${apply.ok ? "yes" : "no"}`,
              `Monitor: ${monitorUrl}`,
              "",
              `Final branch: ${finalBranch}`,
              ...(finalCommit ? [`Final commit: ${finalCommit}`] : []),
              "",
              "Candidate branches:",
              ...candidates.map((c) => `  ${c.model}: ${c.branchName} (${c.finalCommit})`),
              "",
              "Inspect any branch:",
              `  git diff main..${finalBranch}`,
              `  git log ${finalBranch}`,
              `  git checkout ${finalBranch}`,
              "",
              "Reasoning:",
              decision.reasoning,
              "",
              "Scores:",
              ...decision.scores.flatMap((s) => [
                `  ${s.model}: ${s.score} (${s.notes})`,
                ...(s.criterionScores?.map((cs) => `    ${cs.criterion}: ${cs.score} (${cs.notes})`) ?? []),
              ]),
              "",
              `Apply result: ${apply.message}`,
              ...(KEEP_WORKSPACES ? [`Worktrees kept at ${worktreeParentDir}`] : ["Worktrees cleaned up (branches remain)"]),
            ].join("\n"),
          }],
          details: {
            status: "completed",
            winnerModel: decision.winnerModel,
            mergeMode,
            applied: apply.ok,
            judgeModel: params.judgeModel,
            finalBranch,
            scores: decision.scores,
          },
        };
      } catch (error) {
        mutateRun(runId, (r) => {
          r.phase = "failed";
          r.finishedAt = nowIso();
          r.error = toErrorMessage(error);
          if (r.judge.status === "running") {
            r.judge.status = "failed";
            r.judge.finishedAt = nowIso();
            r.judge.error = toErrorMessage(error);
          }
        });
        publishProgress(runId, onUpdate, ctx);
        if (ctx.hasUI) ctx.ui.setStatus("model-fusion", `model_fusion failed | ${toErrorMessage(error)}`);
        throw error;
      } finally {
        // Cleanup: remove worktree directories, keep branches
        if (!KEEP_WORKSPACES) {
          for (const wt of worktreePaths) {
            removeWorktree(repoRoot, wt);
          }
          fs.rmSync(worktreeParentDir, { recursive: true, force: true });
        }
      }
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("model_fusion "))}${args.candidateModels.length} models`,
        0, 0,
      );
    },
  };

  pi.registerTool(tool);

  pi.registerCommand("model-fusion-monitor", {
    description: "Open the live model fusion monitor in your browser",
    handler: async (_args, ctx) => {
      const url = await ensureMonitorServer();
      openUrlInBrowser(url);
      if (ctx.hasUI) ctx.ui.notify(`Opened model fusion monitor: ${url}`, "info");
      else console.log(`Model fusion monitor: ${url}`);
    },
  });
}
