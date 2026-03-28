# spec-gen commands for get-shit-done (GSD)

Two Claude Code slash commands that add structural risk analysis and spec drift
verification to the [get-shit-done](https://github.com/gsd-build/get-shit-done) workflow.

Part of the [spec-gen agentic workflow pattern](../../docs/agentic-workflows/README.md).

## Commands

| Command | When | What it does |
|---|---|---|
| `/gsd:spec-gen-orient` | Before `/gsd:execute-phase` | orient + risk gate → writes `.planning/codebase/RISK-CONTEXT.md` |
| `/gsd:spec-gen-drift` | After `/gsd:verify-work` passes | drift check → appends spec status to `RISK-CONTEXT.md` |

## Installation

Copy the `commands/` directory into your project's `.claude/` folder:

```bash
cp -r examples/gsd/commands/.claude/commands/gsd/ .claude/commands/gsd/
```

Or copy into your global Claude Code commands:

```bash
cp -r examples/gsd/commands/gsd/ ~/.claude/commands/gsd/
```

## Prerequisites

1. spec-gen MCP server configured in `.claude/settings.json`
2. `spec-gen analyze $PROJECT_ROOT` run at least once

## Workflow

```
/gsd:new-project or /gsd:map-codebase   ← existing GSD commands

# spec-gen pre-flight (brownfield)
/gsd:spec-gen-orient [phase]            ← risk gate, writes RISK-CONTEXT.md

/gsd:plan-phase [N]                     ← existing GSD command
/gsd:execute-phase [N]                  ← existing GSD command
/gsd:verify-work [N]                    ← existing GSD command

# spec-gen post-flight (once verify-work passes)
/gsd:spec-gen-drift [N]                 ← drift check, appends to RISK-CONTEXT.md

/gsd:complete-milestone                 ← existing GSD command
```

## Risk gate

| Score | Level | Action |
|---|---|---|
| < 40 | 🟢 low | Proceed to execute-phase |
| 40–69 | 🟡 medium | Proceed — protect callers listed in RISK-CONTEXT.md |
| ≥ 70 | 🔴 high / critical | Stop — use `/gsd:insert-phase` to add a refactor phase first |

## Relation to `/gsd:map-codebase`

`/gsd:map-codebase` uses parallel mapper agents to produce narrative documents
(STACK.md, ARCHITECTURE.md, etc.) — great for onboarding and big-picture understanding.

`/gsd:spec-gen-orient` is complementary: it produces **quantitative risk data** (fan-in,
fan-out, risk scores, call paths) from a pre-built static index. Both can coexist —
run `map-codebase` once for narrative context, `spec-gen-orient` before each phase for
risk-aware execution.
