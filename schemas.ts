import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

export const ModelFusionParams = Type.Object({
  task: Type.String({ minLength: 5, description: "Coding task to execute across models" }),
  candidateModels: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 2,
    description: "At least two models to run in parallel"
  }),
  judgeModel: Type.String({ minLength: 1, description: "Model used to evaluate and rank candidate outputs" }),
  criteria: Type.Array(Type.String({ minLength: 3 }), {
    minItems: 1,
    description: "Ranking criteria used by the judge"
  }),
  mergeMode: Type.Optional(StringEnum(["best_only", "merge_with_top"] as const, {
    description: "Whether to keep the best candidate as-is or let the judge merge improvements into the top-ranked patch"
  })),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory used for candidate runs and patch apply" })),
}, { additionalProperties: false });
