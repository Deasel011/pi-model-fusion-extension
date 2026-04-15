# pi-model-fusion

A TypeScript extension for [pi.dev](https://pi.dev/) that runs one coding task across multiple models, evaluates them against user-defined criteria using a judge model, and applies the selected patch.

## Features

- Run **2+ candidate models** against one coding task in parallel.
- **Branch-first architecture**: each candidate runs in its own git branch worktree — no separate "workspace" + "branch materialization" steps.
- Diffs are **captured directly from git** after candidate execution (not parsed from model output), ensuring accuracy.
- Judge reads real git-captured diffs for reliable evaluation.
- For `best_only` mode, the winner's branch diff is used directly — no round-trip through the judge's diff output.
- For `merge_with_top` mode, the judge synthesizes a merged diff, materialized to its own final branch.
- All branches persist after the run for easy inspection: `git diff main..<branch>`, `git log <branch>`, `git checkout <branch>`.
- Stream live per-model progress updates during execution.
- Show judge scoring with per-criterion breakdowns for each candidate model.
- Expose a `/model-fusion-monitor` command that opens a local browser dashboard.
- Applies resulting diff with `git apply --3way` to the original `cwd`.
- Ships a `model-fusion` skill and `/model-fusion` prompt template for discoverability.

## Install

From npm:
```bash
pi install pi-model-fusion
```

Or directly from git:
```bash
pi install git:https://github.com/Deasel011/pi-model-fusion-extension/
```

## Prompt-driven usage

Once installed, you can request model fusion directly in chat:

- `Use model fusion to add retries to the API client. Compare openai/gpt-5, anthropic/claude-sonnet-4, and google/gemini-2.5-pro. Judge with openai/gpt-5 on correctness, tests, and minimal risk.`
- `/model-fusion add retries to the API client`

To monitor live runs in a browser:

- `/model-fusion-monitor`

## Tool

### `model_fusion`

Parameters:

- `task` (string): coding task prompt.
- `candidateModels` (string[]): at least two models.
- `judgeModel` (string): model that performs ranking/selection.
- `criteria` (string[]): scoring criteria.
- `mergeMode` (`best_only` | `merge_with_top`): selection behavior.
- `cwd` (optional string): source working directory (must be inside a git repo).

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

## Architecture

### Branch-first workflow

```
1. Capture uncommitted state (tracked diff + untracked files)
2. For each candidate (in parallel):
   a. git worktree add -b pi-model-fusion/<runId>/candidate-<model> <path> HEAD
   b. Apply uncommitted state → commit as "base"
   c. Run pi (model makes file edits directly)
   d. git add -A && git commit → capture diff from git
3. Judge runs in its own branch worktree, reads git-captured diffs
4. Final branch:
   - best_only → winner's existing branch
   - merge_with_top → new branch with judge's synthesized diff
5. Apply final diff to original cwd
6. Cleanup worktree directories (branches remain)
```

Each candidate's changes are real git commits on named branches. The monitor and judge both read diffs from git, not from parsed model output.

### Inspecting results

After a run, all branches remain in your repo:

```bash
# List all fusion branches
git branch --list 'pi-model-fusion/*'

# Compare a candidate's changes
git diff main..pi-model-fusion/<runId>/candidate-1-<model>

# Check out the final result
git checkout pi-model-fusion/<runId>/final-<model>

# Clean up old branches
git branch -D $(git branch --list 'pi-model-fusion/*' | tr -d ' ')
```

## Notes

- **Requires git**: `cwd` must be inside a git repository.
- Candidate models are instructed to make file edits directly. Diffs are captured from git after execution (not from `<diff>` tags in output).
- Each candidate branch has two commits: "base" (uncommitted state) + "candidate changes".
- Worktree directories are cleaned up automatically after the run. Set `PI_MODEL_FUSION_KEEP_WORKSPACES=1` to keep them.
- Set `PI_MODEL_FUSION_WORKSPACE_DIR=/short/path` to override the worktree root (useful for Windows path-length issues).
- Live run state is persisted to `~/.pi/agent/extensions/model-fusion/monitor-state.json`.
- The monitor dashboard shows branch names with copy-pasteable git commands for each candidate and the final selection.
- If patch apply fails, output still includes ranking, reasoning, and branch references so you can apply manually.
- Have fun!