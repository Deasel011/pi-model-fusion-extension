import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import { type ExtensionAPI, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { ModelFusionParams } from "./schemas.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

interface CandidateRun {
  model: string;
  output: string;
  diff: string;
}

interface JudgeDecision {
  winnerModel: string;
  reasoning: string;
  scores: Array<{ model: string; score: number; notes: string }>;
  finalDiff: string;
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

function extractTaggedBlock(content: string, tag: string): string {
  const rx = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = content.match(rx);
  return m ? m[1].trim() : "";
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
    .map((c, i) => `Candidate ${i + 1} (${c.model})\nSUMMARY/OUTPUT:\n${c.output}\nDIFF:\n${c.diff}`)
    .join("\n\n---\n\n");

  return [
    "You are the model-fusion judge. Evaluate candidate code patches for a coding task.",
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

export default function registerModelFusionExtension(pi: ExtensionAPI): void {
  const tool: ToolDefinition<typeof ModelFusionParams, Static<typeof Details>> = {
    name: "model_fusion",
    label: "Model Fusion",
    description: "Run coding task against multiple models, rank by custom criteria, and apply best/merged patch.",
    parameters: ModelFusionParams,
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const cwd = path.resolve(params.cwd ?? process.cwd());
      const mergeMode = (params.mergeMode ?? "best_only") as "best_only" | "merge_with_top";
      const candidates = await Promise.all(params.candidateModels.map(async (model) => {
        const output = await runPiPrompt(buildCandidatePrompt(params.task), model, cwd, signal);
        const diff = extractTaggedBlock(output, "diff");
        if (!diff) throw new Error(`Model ${model} did not return a <diff> block.`);
        return { model, output, diff } satisfies CandidateRun;
      }));

      const judgeOutput = await runPiPrompt(buildJudgePrompt({
        task: params.task,
        criteria: params.criteria,
        mergeMode,
        candidates,
      }), params.judgeModel, cwd, signal);

      const decision = parseJudgeDecision(judgeOutput);
      const apply = applyDiff(decision.finalDiff, cwd);

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
