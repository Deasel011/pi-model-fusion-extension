# pi-model-fusion

A TypeScript extension for [pi.dev](https://pi.dev/) that runs one coding task across multiple models, evaluates them against user-defined criteria using a judge model, and applies the selected patch.

## Features

- Run **2+ candidate models** against one coding task in parallel.
- Create a dedicated isolated workspace snapshot for each candidate model so parallel runs never touch the same files.
- Materialize each candidate model's diff into its own git worktree branch when `cwd` is inside a git repo.
- Run the judge in its own isolated workspace snapshot as well.
- Materialize the final selected diff into its own git worktree branch so it can serve as a PR-ready follow-up branch.
- Stream live per-model/per-workspace progress updates during execution.
- Show judge scoring with per-criterion breakdowns for each candidate model.
- Expose a `/model-fusion-monitor` command that opens a local browser dashboard for manual monitoring.
- Score outputs against user-provided criteria.
- Use a **predefined judge model** to select best output.
- Optional merge mode (`merge_with_top`) where the judge can synthesize a merged patch anchored on top-ranked output.
- Applies resulting unified diff with `git apply --3way` to the original `cwd`, while also preserving a separate final branch/worktree copy for review.
- Exposes `model_fusion` in pi's tool prompt so the agent can invoke it from natural-language requests.
- Ships a `model-fusion` skill and `/model-fusion` prompt template for discoverability.

## Install

```bash
pi install git:https://github.com/Deasel011/pi-model-fusion-extension/
```

## Prompt-driven usage

Once installed, you can request model fusion directly in chat, for example:

- `Use model fusion to add retries to the API client. Compare openai/gpt-5, anthropic/claude-sonnet-4, and google/gemini-2.5-pro. Judge with openai/gpt-5 on correctness, tests, and minimal risk.`
- `/model-fusion add retries to the API client`

If the request is missing required inputs, the agent should ask for the missing models, judge, or criteria before calling the tool.

To manually monitor live runs in a browser, use:

- `/model-fusion-monitor`

## Tool

### `model_fusion`

Parameters:

- `task` (string): coding task prompt.
- `candidateModels` (string[]): at least two models.
- `judgeModel` (string): model that performs ranking/selection.
- `criteria` (string[]): scoring criteria.
- `mergeMode` (`best_only` | `merge_with_top`): selection behavior.
- `cwd` (optional string): source working directory to snapshot for model runs, and the directory where the final patch is applied.

Example call:

```json
{
  "task": "Add retries to the API client and unit tests",
  "candidateModels": [
    "openai/gpt-5",
    "anthropic/claude-sonnet-4",
    "google/gemini-2.5-pro"
  ],
  "judgeModel": "openai/gpt-5",
  "criteria": [
    "correctness",
    "test coverage",
    "minimal risk",
    "code clarity"
  ],
  "mergeMode": "merge_with_top"
}
```

## Notes

- Candidate models are instructed to output a `<diff>` block containing an applicable unified diff.
- Each candidate model runs inside its own temporary workspace under the OS temp directory by default (using a short `pi-mf` path to avoid Windows path-length issues).
- When `cwd` is a git repo, execution workspaces are created from a detached `git worktree` snapshot plus current uncommitted tracked and untracked changes.
- Candidate outputs are also materialized into per-model git branches/worktrees under a persistent branch-worktree directory, with one branch per model.
- The judge also runs in an isolated workspace.
- The final selected diff is materialized into its own git branch/worktree as well, so you can use that branch later as a PR candidate.
- Live run state is persisted to `~/.pi/agent/extensions/model-fusion/monitor-state.json` and served by the browser monitor.
- Use `/model-fusion-monitor` to open the local dashboard and inspect candidate workspaces, candidate/final branch worktrees, criteria, per-criterion scores, reasoning, and the chosen winner.
- Set `PI_MODEL_FUSION_KEEP_WORKSPACES=1` to keep the temporary execution workspaces for debugging instead of auto-cleaning them. Materialized branch worktrees are kept so you can inspect them later.
- Set `PI_MODEL_FUSION_WORKSPACE_DIR=/short/path` to override the workspace root if you want a custom location.
- If workspace creation still hits path-length errors, `model_fusion` now returns a recoverable `needs_user_input` result so the agent can ask the user how to proceed instead of leaving the run in a hard-failed state.
- Judge must return a `<fusion>` JSON payload with a final unified diff (`finalDiff`).
- If patch apply fails, output still includes ranking and rationale so the user can manually apply/adapt.

## Based on

This extension follows the architecture and runtime-spawn pattern from [`pi-subagents`](https://github.com/nicobailon/pi-subagents), adapted for model fusion workflows.
