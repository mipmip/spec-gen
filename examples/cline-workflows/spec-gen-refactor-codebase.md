# spec-gen: Refactor Codebase

Identify the highest-priority refactoring targets using static analysis, assess
the blast radius of each change, and propose concrete code edits — iterating
until the priority score drops.

## Step 1: Confirm the project directory

Ask the user which project to refactor, or confirm the current workspace root.

<ask_followup_question>
  <question>Which project directory should I refactor?</question>
  <options>["Current workspace root", "Enter a different path"]</options>
</ask_followup_question>

## Step 2: Run static analysis

Analyse the project. If analysis already ran recently, skip unless the user
requests a fresh run.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

## Step 3: Get the full refactoring report

Retrieve the prioritised list of functions with structural issues.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Present the top 5 candidates in a table: function, file, issues, priority score.

Before asking the user to pick a target, **check test coverage for the files
containing the top candidates**. Detect the coverage tool from the project
(same heuristics as Step 8) and run it scoped to those files only:

- Node.js → `npm test -- --coverage --collectCoverageFrom="<files>"`
- Python  → `pytest --cov=<module> --cov-report=term-missing`
- Rust    → `cargo tarpaulin --include-files <files>`
- Go      → `go test -cover ./...` (filter relevant packages)

For each candidate file, present a compact coverage badge:

| Function | File | Priority | Coverage |
|---|---|---|---|
| ... | ... | ... | 72% ✅ / 35% ⚠️ / 0% 🚫 |

Apply these thresholds to annotate each row:

| Coverage | Badge | Meaning |
|---|---|---|
| ≥ 70% lines | ✅ | Safe to refactor |
| 40–69% lines | ⚠️ | Write characterisation tests first |
| < 40% lines | 🛑 | Strongly discouraged — recommend tests first |
| 0% (no tests) | 🚫 | Blocked — propose a test harness before proceeding |

If **all top candidates are below 40%**, tell the user:
> "Every high-priority target has insufficient test coverage (< 40%). Refactoring
> without tests risks introducing silent regressions. I recommend writing a
> minimal test harness for at least one target before proceeding. Would you like
> me to suggest test cases based on the function signatures?"

Then ask the user which one to tackle first, or pick the top one by default.
Prefer candidates with higher coverage when scores are otherwise close.

## Step 4: Assess impact before changing anything

For the chosen function, get the full impact analysis.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{"directory": "$DIRECTORY", "symbol": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>

Show:
- Risk score (0–100) and what it means
- Recommended strategy (extract / split / facade / delegate)
- How many callers depend on this function (upstream chain)

## Step 5: Visualise the call neighbourhood

Render the subgraph as a Mermaid diagram to map callers and callees.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME", "direction": "both", "format": "mermaid"}</arguments>
</use_mcp_tool>

## Step 6: Find safe entry points

Identify low-risk functions to extract or rename first (bottom-up approach).

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_low_risk_refactor_candidates</tool_name>
  <arguments>{"directory": "$DIRECTORY", "limit": 5}</arguments>
</use_mcp_tool>

## Step 7: Propose concrete changes

Based on the recommended strategy from Step 4:

- **split**: list the sub-responsibilities to extract into separate functions,
  with suggested names derived from the domain vocabulary
- **extract**: identify helper logic that can become a standalone function
- **facade**: propose a thin wrapper that delegates to smaller functions
- **delegate**: identify which callers should own part of the current logic

Present the plan and ask for confirmation before writing any code.

## Step 8: Establish a green baseline

Before touching any code, confirm the test suite is passing. Detect the test
runner from the project (look for `package.json` scripts, `pytest.ini`,
`Cargo.toml`, `go.mod`, `Makefile`, etc.) and run it once:

- Node.js → `npm test` or the `test` script in `package.json`
- Python  → `pytest` or `python -m pytest`
- Rust    → `cargo test`
- Go      → `go test ./...`
- Ruby    → `bundle exec rspec` or `rake test`
- Java    → `./mvnw test` or `./gradlew test`

**If tests are already failing, stop and tell the user.** Do not proceed with
refactoring on a red baseline — the failures must be fixed first or the user
must explicitly acknowledge them.

If a coverage tool is available (e.g. `npm test -- --coverage`, `pytest --cov`,
`cargo tarpaulin`, `go test -cover`), run it and note the current line/branch
coverage **for the specific files that will be touched**. Present a one-line
summary: `Coverage baseline: 72% lines, 58% branches on src/services/hub.ts`.

Use the following thresholds to decide whether to proceed:

| Coverage on files to touch | Recommendation |
|---|---|
| ≥ 70% lines | Safe to refactor — proceed |
| 40–69% lines | Caution — write characterisation tests for the affected functions before starting |
| < 40% lines | **Stop.** Strongly recommend writing tests first. Refactoring untested code hides regressions. |
| 0% (no tests at all) | **Block.** Do not refactor. Propose writing a minimal test harness first, then restart the workflow. |

If coverage is below 40%, tell the user clearly:
> "Coverage on the target file is X%. Refactoring without test coverage risks
> introducing silent regressions. I recommend writing tests for the affected
> functions before proceeding. Would you like me to suggest test cases based on
> the function signatures, or do you want to proceed at your own risk?"

Only continue past this point with explicit user confirmation.

## Step 9: Apply changes

Make the agreed code edits. Do not change observable behaviour — rename and
restructure only.

After **each individual change** (one extracted function, one rename, one moved
block), re-run the test suite before proceeding to the next change. If any test
fails after a change, revert that change immediately rather than accumulating
broken state.

## Step 10: Verify improvement

Re-analyse to confirm the priority score dropped for the refactored function.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY", "force": true}</arguments>
</use_mcp_tool>

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Confirm that `withIssues` decreased and the function is no longer in the top list.
If not, investigate why and iterate.

Run the full test suite one final time to confirm the refactored state is clean.

## Step 11 (optional — requires spec-gen generate to have been run)

**Important**: this step proposes irreversible changes (deletions, renames).
Do not apply anything without explicit user confirmation at each sub-step.

### 11a. Dead code: orphan functions

Check for functions not covered by any spec requirement.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_mapping</tool_name>
  <arguments>{"directory": "$DIRECTORY", "orphansOnly": true}</arguments>
</use_mcp_tool>

Present the orphan list (kind `function` or `class` only). For each one, check:
- Is it exported and potentially consumed by external code?
- Is it re-exported from an index file?
- Was it simply missed by the LLM in Stage 3?

Only after the user has reviewed and confirmed each entry, propose deletion or
a documentation comment marking it as intentionally uncovered.

**Do not delete anything without the user explicitly approving each function.**

### 11b. Naming alignment: spec vocabulary vs actual names

Find functions whose names diverge from the business vocabulary in the spec.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_mapping</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Build a table of mismatches (requirement name vs function name) and present it
to the user for review before touching any code:

| Current name | Proposed name | File | Confidence |
|---|---|---|---|

Only renames with `confidence: "llm"` should be proposed automatically.
Flag `confidence: "heuristic"` entries for manual verification first.

**Wait for explicit user approval of the full rename table before applying
any change. Apply renames one file at a time and run tests after each.**
