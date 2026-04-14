---
name: model-fusion
description: Use when the user wants to compare multiple models on the same coding task, rank their outputs, or synthesize a merged patch from the best ideas.
---

# Model Fusion

Use the `model_fusion` tool when the user explicitly asks to:
- compare multiple coding models on the same task
- rank or vote on alternative model-generated patches
- fuse the best parts of multiple model outputs into one applied change

## Required parameters

Before calling `model_fusion`, make sure you have:
1. `task` — the concrete coding task
2. `candidateModels` — at least two model IDs
3. `judgeModel` — the model that will rank/select the result
4. `criteria` — one or more scoring criteria

## Merge mode

- Use `best_only` when the user wants the top candidate selected as-is.
- Use `merge_with_top` when the user explicitly wants the judge to synthesize a merged patch anchored on the top-ranked candidate.

## Missing information

If the user asks for model fusion but leaves out key parameters, ask a brief clarifying question rather than guessing.

## Example

If the user says:

> Use model fusion to add retry handling to the API client.

You should gather or confirm candidate models, a judge model, and criteria, then call `model_fusion`.
