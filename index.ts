import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { ModelFusionParams } from "./schemas.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

interface CandidateRun {
  model: string;
  output: string;
  diff: string;
  summary: string;
  workspaceCwd: string;
}

interface JudgeDecision {
  winnerModel: string;
  reasoning: string;
  scores: Array<{ model: string; score: number; notes: string }>;
  finalDiff: string;
}

interface IsolatedWorkspace {
  label: string;
  root: string;
  cwd: string;
}

type WorkspaceStatus = "pending" | "snapshotting" | "running" | "completed" | "failed";
type RunPhase = "preparing_workspaces" | "running_candidates" | "judging" | "applying" | "completed" | "failed";

interface CandidateMonitorEntry {
  model: string;
  workspaceLabel: string;
  workspaceCwd?: string;
  status: WorkspaceStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  diff?: string;
  output?: string;
  error?: string;
}

interface JudgeMonitorEntry {
  model: string;
  workspaceLabel: string;
  workspaceCwd?: string;
  status: WorkspaceStatus;
  startedAt?: string;
  finishedAt?: string;
  reasoning?: string;
  finalDiff?: string;
  scores?: Array<{ model: string; score: number; notes: string }>;
  error?: string;
}

interface FusionMonitorRun {
  id: string;
  task: string;
  cwd: string;
  criteria: string[];
  mergeMode: "best_only" | "merge_with_top";
  phase: RunPhase;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  winnerModel?: string;
  apply?: { ok: boolean; message: string };
  workspaceParentDir: string;
  workspacesKept: boolean;
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
  winnerModel: Type.String(),
  mergeMode: Type.String(),
  applied: Type.Boolean(),
  judgeModel: Type.String(),
  scores: Type.Array(Type.Object({
    model: Type.String(),
    score: Type.Number(),
    notes: Type.String(),
  })),
});

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_APP_PATH = path.join(MODULE_DIR, "monitor", "index.html");
const EXTENSION_STORAGE_DIR = path.join(getAgentDir(), "extensions", "model-fusion");
const WORKSPACE_STORAGE_DIR = path.join(EXTENSION_STORAGE_DIR, "workspaces");
const MONITOR_STATE_PATH = path.join(EXTENSION_STORAGE_DIR, "monitor-state.json");
const KEEP_WORKSPACES = ["1", "true", "yes"].includes((process.env.PI_MODEL_FUSION_KEEP_WORKSPACES ?? "").trim().toLowerCase());
const EXEC_MAX_BUFFER = 50 * 1024 * 1024;
const MAX_MONITOR_RUNS = 20;
const GLOBAL_MONITOR_RUNTIME_KEY = "__pi_model_fusion_monitor_runtime__";

function extractTaggedBlock(content: string, tag: string): string {
  const rx = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = content.match(rx);
  return m ? m[1].trim() : "";
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === "string") {
    const normalized = value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function normalizeMergeMode(value: unknown): "best_only" | "merge_with_top" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  if (["best_only", "best-only", "best", "winner_only", "winner-only"].includes(normalized)) {
    return "best_only";
  }

  if (["merge_with_top", "merge-with-top", "merge", "merge_top", "merge-top", "combined"].includes(normalized)) {
    return "merge_with_top";
  }

  return undefined;
}

function normalizeModelFusionArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;

  const input = args as {
    task?: unknown;
    candidateModels?: unknown;
    candidateModel?: unknown;
    models?: unknown;
    judgeModel?: unknown;
    judge?: unknown;
    evaluatorModel?: unknown;
    criteria?: unknown;
    criterion?: unknown;
    mergeMode?: unknown;
    cwd?: unknown;
  };

  const candidateModels = toStringArray(input.candidateModels)
    ?? toStringArray(input.models)
    ?? toStringArray(input.candidateModel);
  const criteria = toStringArray(input.criteria) ?? toStringArray(input.criterion);
  const judgeModel = [input.judgeModel, input.judge, input.evaluatorModel].find((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  )?.trim();
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

async function runPiPrompt(prompt: string, model: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const baseArgs = ["--no-session", "--model", model, prompt];
  const command = getPiSpawnCommand(baseArgs);
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

function buildCandidatePrompt(task: string): string {
  return [
    "You are producing a code-change candidate for an automated model-fusion pipeline.",
    "You are running inside an isolated per-model workspace snapshot. You may inspect and edit files there freely, but your final answer must only contain the requested XML tags.",
    "Return your full answer in two XML tags:",
    "<summary>short explanation of your approach</summary>",
    "<diff>unified git diff only, with no markdown fences</diff>",
    "The diff must be directly applicable with `git apply` from current working directory.",
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
    .map((c, i) => `Candidate ${i + 1} (${c.model})\nWORKSPACE:\n${c.workspaceCwd}\nSUMMARY:\n${c.summary}\nFULL OUTPUT:\n${c.output}\nDIFF:\n${c.diff}`)
    .join("\n\n---\n\n");

  return [
    "You are the model-fusion judge. Evaluate candidate code patches for a coding task.",
    "You are also running in an isolated workspace snapshot; do not assume any candidate changed the shared project tree.",
    `Merge mode: ${input.mergeMode}. If merge_with_top, synthesize the best combined patch anchored on the top-ranked solution.`,
    "Return ONLY this XML payload:",
    "<fusion>{\"winnerModel\":\"...\",\"reasoning\":\"...\",\"scores\":[{\"model\":\"...\",\"score\":0-100,\"notes\":\"...\"}],\"finalDiff\":\"unified diff\"}</fusion>",
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
  if (!parsed.winnerModel || !parsed.finalDiff) {
    throw new Error("Judge output missing winnerModel or finalDiff");
  }
  return parsed;
}

function applyDiff(diff: string, cwd: string): { ok: boolean; message: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-fusion-"));
  const patchPath = path.join(tmpDir, "selected.patch");
  fs.writeFileSync(patchPath, diff, "utf-8");
  try {
    execFileSync("git", ["apply", "--3way", "--whitespace=nowarn", patchPath], { cwd, stdio: "pipe" });
    return { ok: true, message: `Applied patch from ${patchPath}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

function sanitizeWorkspaceSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "workspace";
}

function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writePatchFile(diff: string, prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const patchPath = path.join(tmpDir, "patch.diff");
  fs.writeFileSync(patchPath, diff, "utf-8");
  return patchPath;
}

function getGitRepoRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: EXEC_MAX_BUFFER,
    }).trim();
  } catch {
    return undefined;
  }
}

function createWorkspaceParentDir(): string {
  ensureDirectory(WORKSPACE_STORAGE_DIR);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const parentDir = path.join(WORKSPACE_STORAGE_DIR, runId);
  ensureDirectory(parentDir);
  return parentDir;
}

function createWorkspaceFromGitSnapshot(sourceCwd: string, workspaceRoot: string): IsolatedWorkspace {
  const repoRoot = getGitRepoRoot(sourceCwd);
  if (!repoRoot) throw new Error(`Not a git repository: ${sourceCwd}`);

  const relativeCwd = path.relative(repoRoot, sourceCwd);
  execFileSync("git", ["worktree", "add", "--detach", "--force", workspaceRoot, "HEAD"], {
    cwd: repoRoot,
    stdio: "pipe",
    maxBuffer: EXEC_MAX_BUFFER,
  });

  const trackedPatch = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
  });

  if (trackedPatch.trim()) {
    const patchPath = writePatchFile(trackedPatch, "pi-model-fusion-snapshot-");
    execFileSync("git", ["apply", "--whitespace=nowarn", patchPath], {
      cwd: workspaceRoot,
      stdio: "pipe",
      maxBuffer: EXEC_MAX_BUFFER,
    });
  }

  const untrackedBuffer = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: EXEC_MAX_BUFFER,
  });
  const untrackedFiles = String(untrackedBuffer)
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const relativeFile of untrackedFiles) {
    const sourcePath = path.join(repoRoot, relativeFile);
    const targetPath = path.join(workspaceRoot, relativeFile);
    ensureDirectory(path.dirname(targetPath));
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: false });
  }

  return {
    label: path.basename(workspaceRoot),
    root: workspaceRoot,
    cwd: path.join(workspaceRoot, relativeCwd),
  };
}

function createWorkspaceByCopy(sourceCwd: string, workspaceRoot: string): IsolatedWorkspace {
  const repoRoot = getGitRepoRoot(sourceCwd);
  const copyRoot = repoRoot ?? sourceCwd;
  const relativeCwd = repoRoot ? path.relative(repoRoot, sourceCwd) : "";

  fs.cpSync(copyRoot, workspaceRoot, { recursive: true, force: true, dereference: false });
  return {
    label: path.basename(workspaceRoot),
    root: workspaceRoot,
    cwd: path.join(workspaceRoot, relativeCwd),
  };
}

function createIsolatedWorkspace(sourceCwd: string, workspaceParentDir: string, label: string): IsolatedWorkspace {
  const workspaceRoot = path.join(workspaceParentDir, sanitizeWorkspaceSegment(label));
  try {
    return createWorkspaceFromGitSnapshot(sourceCwd, workspaceRoot);
  } catch {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    return createWorkspaceByCopy(sourceCwd, workspaceRoot);
  }
}

function cleanupWorkspaceParentDir(workspaceParentDir: string): void {
  if (KEEP_WORKSPACES) return;
  fs.rmSync(workspaceParentDir, { recursive: true, force: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMonitorRuntime(): MonitorRuntime {
  const globalWithMonitor = globalThis as typeof globalThis & {
    [GLOBAL_MONITOR_RUNTIME_KEY]?: MonitorRuntime;
  };

  if (!globalWithMonitor[GLOBAL_MONITOR_RUNTIME_KEY]) {
    globalWithMonitor[GLOBAL_MONITOR_RUNTIME_KEY] = {
      state: loadMonitorState(),
    };
  }

  return globalWithMonitor[GLOBAL_MONITOR_RUNTIME_KEY]!;
}

function loadMonitorState(): MonitorState {
  try {
    const content = fs.readFileSync(MONITOR_STATE_PATH, "utf-8");
    const parsed = JSON.parse(content) as MonitorState;
    return {
      activeRunId: parsed.activeRunId,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      server: parsed.server,
    };
  } catch {
    return { runs: [] };
  }
}

function persistMonitorState(state: MonitorState): void {
  ensureDirectory(EXTENSION_STORAGE_DIR);
  fs.writeFileSync(MONITOR_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function getMonitorStateSnapshot(): MonitorState {
  const runtime = getMonitorRuntime();
  return JSON.parse(JSON.stringify(runtime.state)) as MonitorState;
}

function mutateMonitorState(mutator: (state: MonitorState) => void): void {
  const runtime = getMonitorRuntime();
  mutator(runtime.state);
  runtime.state.runs = runtime.state.runs.slice(-MAX_MONITOR_RUNS);
  persistMonitorState(runtime.state);
}

function mutateRun(runId: string, mutator: (run: FusionMonitorRun) => void): void {
  mutateMonitorState((state) => {
    const run = state.runs.find((entry) => entry.id === runId);
    if (!run) return;
    mutator(run);
    run.updatedAt = nowIso();
  });
}

function getRunSnapshot(runId: string): FusionMonitorRun | undefined {
  const state = getMonitorStateSnapshot();
  return state.runs.find((run) => run.id === runId);
}

function registerRun(run: FusionMonitorRun): void {
  mutateMonitorState((state) => {
    state.activeRunId = run.id;
    state.runs.push(run);
  });
}

function setMonitorServerInfo(info: MonitorServerInfo): void {
  mutateMonitorState((state) => {
    state.server = info;
  });
}

function buildProgressText(run: FusionMonitorRun): string {
  const completedCandidates = run.candidates.filter((candidate) => candidate.status === "completed").length;
  const failedCandidates = run.candidates.filter((candidate) => candidate.status === "failed").length;

  return [
    `Run: ${run.id}`,
    `Phase: ${run.phase}`,
    `Task: ${run.task}`,
    `Merge mode: ${run.mergeMode}`,
    `Criteria: ${run.criteria.join(", ")}`,
    `Candidates completed: ${completedCandidates}/${run.candidates.length}`,
    ...(failedCandidates > 0 ? [`Candidates failed: ${failedCandidates}`] : []),
    "",
    "Candidate workspaces:",
    ...run.candidates.map((candidate) => {
      const workspace = candidate.workspaceCwd ? ` @ ${candidate.workspaceCwd}` : "";
      const detail = candidate.error ? ` — ${candidate.error}` : candidate.summary ? ` — ${candidate.summary}` : "";
      return `- ${candidate.model}: ${candidate.status}${workspace}${detail}`;
    }),
    "",
    `Judge (${run.judge.model}): ${run.judge.status}${run.judge.workspaceCwd ? ` @ ${run.judge.workspaceCwd}` : ""}${run.judge.error ? ` — ${run.judge.error}` : ""}`,
    ...(run.winnerModel ? [`Winner: ${run.winnerModel}`] : []),
    ...(run.apply ? [`Patch apply: ${run.apply.ok ? "ok" : "failed"} — ${run.apply.message}`] : []),
    ...(run.error ? [`Error: ${run.error}`] : []),
  ].join("\n");
}

function buildFooterStatus(run: FusionMonitorRun): string {
  const completedCandidates = run.candidates.filter((candidate) => candidate.status === "completed").length;
  const runningCandidates = run.candidates.filter((candidate) => candidate.status === "running").length;
  return `model_fusion ${run.phase} | candidates ${completedCandidates}/${run.candidates.length} done | running ${runningCandidates} | judge ${run.judge.status}`;
}

function publishProgress(
  runId: string,
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void,
  ctx?: { hasUI?: boolean; ui?: { setStatus: (key: string, text: string) => void } },
): void {
  const run = getRunSnapshot(runId);
  if (!run) return;

  onUpdate?.({
    content: [{
      type: "text",
      text: buildProgressText(run),
    }],
  });

  if (ctx?.hasUI && ctx.ui) {
    ctx.ui.setStatus("model-fusion", buildFooterStatus(run));
  }
}

async function ensureMonitorServer(): Promise<string> {
  const runtime = getMonitorRuntime();
  if (runtime.server) {
    const existingAddress = runtime.server.address();
    if (existingAddress && typeof existingAddress !== "string") {
      const url = `http://127.0.0.1:${existingAddress.port}`;
      const state = getMonitorStateSnapshot();
      if (state.server?.url !== url) {
        setMonitorServerInfo({
          port: existingAddress.port,
          url,
          startedAt: state.server?.startedAt ?? nowIso(),
        });
      }
      return url;
    }
  }

  const html = fs.readFileSync(MONITOR_APP_PATH, "utf-8");

  const server = http.createServer((request, response) => {
    const requestUrl = request.url ?? "/";

    if (requestUrl === "/api/state") {
      const state = getMonitorStateSnapshot();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(state));
      return;
    }

    if (requestUrl === "/" || requestUrl.startsWith("/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  runtime.server = server;

  return new Promise<string>((resolve, reject) => {
    server.once("error", (error) => {
      runtime.server = undefined;
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        runtime.server = undefined;
        reject(new Error("Could not determine monitor server address"));
        return;
      }

      const info: MonitorServerInfo = {
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        startedAt: nowIso(),
      };
      setMonitorServerInfo(info);
      resolve(info.url);
    });
  });
}

function openUrlInBrowser(url: string): void {
  const platform = process.platform;

  if (platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  if (platform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

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
      const workspaceParentDir = createWorkspaceParentDir();
      const runId = generateRunId();
      const initialRun: FusionMonitorRun = {
        id: runId,
        task: params.task,
        cwd,
        criteria: [...params.criteria],
        mergeMode,
        phase: "preparing_workspaces",
        startedAt: nowIso(),
        updatedAt: nowIso(),
        workspaceParentDir,
        workspacesKept: KEEP_WORKSPACES,
        candidates: params.candidateModels.map((model, index) => ({
          model,
          workspaceLabel: sanitizeWorkspaceSegment(`candidate-${index + 1}-${model}`),
          status: "pending",
        })),
        judge: {
          model: params.judgeModel,
          workspaceLabel: sanitizeWorkspaceSegment(`judge-${params.judgeModel}`),
          status: "pending",
        },
      };

      registerRun(initialRun);
      publishProgress(runId, onUpdate, ctx);

      try {
        const candidateWorkspaces: Array<{ model: string; workspace: IsolatedWorkspace }> = [];
        for (const [index, model] of params.candidateModels.entries()) {
          mutateRun(runId, (run) => {
            const candidate = run.candidates[index];
            if (!candidate) return;
            candidate.status = "snapshotting";
          });
          publishProgress(runId, onUpdate, ctx);

          const workspace = createIsolatedWorkspace(cwd, workspaceParentDir, `candidate-${index + 1}-${model}`);
          candidateWorkspaces.push({ model, workspace });

          mutateRun(runId, (run) => {
            const candidate = run.candidates[index];
            if (!candidate) return;
            candidate.workspaceCwd = workspace.cwd;
            candidate.status = "pending";
          });
          publishProgress(runId, onUpdate, ctx);
        }

        mutateRun(runId, (run) => {
          run.phase = "running_candidates";
        });
        publishProgress(runId, onUpdate, ctx);

        const candidates = await Promise.all(candidateWorkspaces.map(async ({ model, workspace }, index) => {
          mutateRun(runId, (run) => {
            const candidate = run.candidates[index];
            if (!candidate) return;
            candidate.status = "running";
            candidate.startedAt = nowIso();
            candidate.workspaceCwd = workspace.cwd;
          });
          publishProgress(runId, onUpdate, ctx);

          try {
            const output = await runPiPrompt(buildCandidatePrompt(params.task), model, workspace.cwd, signal);
            const diff = extractTaggedBlock(output, "diff");
            const summary = extractTaggedBlock(output, "summary");
            if (!diff) throw new Error(`Model ${model} did not return a <diff> block.`);

            mutateRun(runId, (run) => {
              const candidate = run.candidates[index];
              if (!candidate) return;
              candidate.status = "completed";
              candidate.finishedAt = nowIso();
              candidate.summary = summary;
              candidate.diff = diff;
              candidate.output = output;
            });
            publishProgress(runId, onUpdate, ctx);

            return { model, output, diff, summary, workspaceCwd: workspace.cwd } satisfies CandidateRun;
          } catch (error) {
            mutateRun(runId, (run) => {
              const candidate = run.candidates[index];
              if (!candidate) return;
              candidate.status = "failed";
              candidate.finishedAt = nowIso();
              candidate.error = toErrorMessage(error);
            });
            publishProgress(runId, onUpdate, ctx);
            throw error;
          }
        }));

        mutateRun(runId, (run) => {
          run.phase = "judging";
          run.judge.status = "snapshotting";
        });
        publishProgress(runId, onUpdate, ctx);

        const judgeWorkspace = createIsolatedWorkspace(cwd, workspaceParentDir, `judge-${params.judgeModel}`);
        mutateRun(runId, (run) => {
          run.judge.workspaceCwd = judgeWorkspace.cwd;
          run.judge.status = "running";
          run.judge.startedAt = nowIso();
        });
        publishProgress(runId, onUpdate, ctx);

        const judgeOutput = await runPiPrompt(buildJudgePrompt({
          task: params.task,
          criteria: params.criteria,
          mergeMode,
          candidates,
        }), params.judgeModel, judgeWorkspace.cwd, signal);

        const decision = parseJudgeDecision(judgeOutput);
        mutateRun(runId, (run) => {
          run.judge.status = "completed";
          run.judge.finishedAt = nowIso();
          run.judge.reasoning = decision.reasoning;
          run.judge.finalDiff = decision.finalDiff;
          run.judge.scores = decision.scores;
          run.winnerModel = decision.winnerModel;
          run.phase = "applying";
        });
        publishProgress(runId, onUpdate, ctx);

        const apply = applyDiff(decision.finalDiff, cwd);
        mutateRun(runId, (run) => {
          run.apply = apply;
          run.phase = "completed";
          run.finishedAt = nowIso();
        });
        publishProgress(runId, onUpdate, ctx);

        const workspaceInfo = KEEP_WORKSPACES
          ? `Workspace snapshots kept at ${workspaceParentDir}`
          : `Workspace snapshots were created under ${workspaceParentDir} and cleaned up automatically`;
        const monitorUrl = await ensureMonitorServer();

        if (ctx.hasUI) {
          ctx.ui.setStatus("model-fusion", `model_fusion completed | winner ${decision.winnerModel}`);
        }

        return {
          content: [{
            type: "text",
            text: [
              `Winner: ${decision.winnerModel}`,
              `Judge model: ${params.judgeModel}`,
              `Merge mode: ${mergeMode}`,
              `Applied: ${apply.ok ? "yes" : "no"}`,
              `Monitor: ${monitorUrl}`,
              "",
              "Reasoning:",
              decision.reasoning,
              "",
              "Scores:",
              ...decision.scores.map((s) => `- ${s.model}: ${s.score} (${s.notes})`),
              "",
              `Apply result: ${apply.message}`,
              workspaceInfo,
            ].join("\n"),
          }],
          details: {
            winnerModel: decision.winnerModel,
            mergeMode,
            applied: apply.ok,
            judgeModel: params.judgeModel,
            scores: decision.scores,
          },
        };
      } catch (error) {
        mutateRun(runId, (run) => {
          run.phase = "failed";
          run.finishedAt = nowIso();
          run.error = toErrorMessage(error);
          if (run.judge.status === "running" || run.judge.status === "snapshotting") {
            run.judge.status = "failed";
            run.judge.finishedAt = nowIso();
            run.judge.error = toErrorMessage(error);
          }
        });
        publishProgress(runId, onUpdate, ctx);
        if (ctx.hasUI) {
          ctx.ui.setStatus("model-fusion", `model_fusion failed | ${toErrorMessage(error)}`);
        }
        throw error;
      } finally {
        cleanupWorkspaceParentDir(workspaceParentDir);
      }
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("model_fusion "))}${args.candidateModels.length} models`,
        0,
        0,
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
