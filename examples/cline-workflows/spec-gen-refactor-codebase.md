# spec-gen: Refactor Codebase (redirected)

This workflow has been split into two focused workflows for better reliability
with limited models:

- **`/spec-gen-plan-refactor`** — static analysis, impact assessment, and
  written plan saved to `.spec-gen/refactor-plan.md` (no code changes)
- **`/spec-gen-execute-refactor`** — reads the plan and applies changes
  incrementally, with tests after each step

Tell the user:
> "The `/spec-gen-refactor-codebase` workflow has been split. Please use:
> 1. `/spec-gen-plan-refactor` to analyse the codebase and write a plan
> 2. `/spec-gen-execute-refactor` to apply the plan
>
> This two-step approach is more reliable, especially with smaller models."
