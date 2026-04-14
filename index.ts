import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { ModelFusionParams } from "./schemas.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

interface CandidateRun {
  model: string;
  output: string;
  diff: string;
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

const WORKSPACE_STORAGE_DIR = path.join(getAgentDir(), "extensions", "model-fusion", "workspaces");
const KEEP_WORKSPACES = ["1", "true", "yes"].includes((process.env.PI_MODEL_FUSION_KEEP_WORKSPACES ?? "").trim().toLowerCase());
const EXEC_MAX_BUFFER = 50 * 1024 * 1024;

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
    .map((c, i) => `Candidate ${i + 1} (${c.model})\nWORKSPACE:\n${c.workspaceCwd}\nSUMMARY/OUTPUT:\n${c.output}\nDIFF:\n${c.diff}`)
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
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const cwd = path.resolve(params.cwd ?? process.cwd());
      const mergeMode = (params.mergeMode ?? "best_only") as "best_only" | "merge_with_top";
      const workspaceParentDir = createWorkspaceParentDir();

      try {
        const candidateWorkspaces = params.candidateModels.map((model, index) => ({
          model,
          workspace: createIsolatedWorkspace(cwd, workspaceParentDir, `candidate-${index + 1}-${model}`),
        }));

        const candidates = await Promise.all(candidateWorkspaces.map(async ({ model, workspace }) => {
          const output = await runPiPrompt(buildCandidatePrompt(params.task), model, workspace.cwd, signal);
          const diff = extractTaggedBlock(output, "diff");
          if (!diff) throw new Error(`Model ${model} did not return a <diff> block.`);
          return { model, output, diff, workspaceCwd: workspace.cwd } satisfies CandidateRun;
        }));

        const judgeWorkspace = createIsolatedWorkspace(cwd, workspaceParentDir, `judge-${params.judgeModel}`);
        const judgeOutput = await runPiPrompt(buildJudgePrompt({
          task: params.task,
          criteria: params.criteria,
          mergeMode,
          candidates,
        }), params.judgeModel, judgeWorkspace.cwd, signal);

        const decision = parseJudgeDecision(judgeOutput);
        const apply = applyDiff(decision.finalDiff, cwd);
        const workspaceInfo = KEEP_WORKSPACES
          ? `Workspace snapshots kept at ${workspaceParentDir}`
          : `Workspace snapshots were created under ${workspaceParentDir} and cleaned up automatically`;

        return {
          content: [{
            type: "text",
            text: [
              `Winner: ${decision.winnerModel}`,
              `Judge model: ${params.judgeModel}`,
              `Merge mode: ${mergeMode}`,
              `Applied: ${apply.ok ? "yes" : "no"}`,
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
}
