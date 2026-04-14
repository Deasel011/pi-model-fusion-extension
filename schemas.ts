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
  mergeMode: Type.Optional(Type.Union([
    Type.Literal("best_only"),
    Type.Literal("merge_with_top")
  ])),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
