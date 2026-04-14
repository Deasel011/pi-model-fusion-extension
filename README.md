# pi-model-fusion

A TypeScript extension for [pi.dev](https://pi.dev/) that runs one coding task across multiple models, evaluates them against user-defined criteria using a judge model, and applies the selected patch.

## Features

- Run **2+ candidate models** against one coding task in parallel.
- Score outputs against user-provided criteria.
- Use a **predefined judge model** to select best output.
- Optional merge mode (`merge_with_top`) where the judge can synthesize a merged patch anchored on top-ranked output.
- Applies resulting unified diff with `git apply --3way`.
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

## Tool

### `model_fusion`

Parameters:

- `task` (string): coding task prompt.
- `candidateModels` (string[]): at least two models.
- `judgeModel` (string): model that performs ranking/selection.
- `criteria` (string[]): scoring criteria.
- `mergeMode` (`best_only` | `merge_with_top`): selection behavior.
- `cwd` (optional string): working directory for model runs and patch apply.

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
- Judge must return a `<fusion>` JSON payload with a final unified diff (`finalDiff`).
- If patch apply fails, output still includes ranking and rationale so the user can manually apply/adapt.

## Based on

This extension follows the architecture and runtime-spawn pattern from [`pi-subagents`](https://github.com/nicobailon/pi-subagents), adapted for model fusion workflows.
