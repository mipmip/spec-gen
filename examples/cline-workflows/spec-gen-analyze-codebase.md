# spec-gen: Analyze Codebase

Run a full static analysis of a project using spec-gen and summarise the results:
architecture, call graph, top refactoring issues, and duplicate code — no LLM required.

## Step 1: Get the project directory

Ask the user which project to analyse, or confirm we should use the current workspace root.

<ask_followup_question>
  <question>Which project directory should I analyse?</question>
  <options>["Current workspace root", "Enter a different path"]</options>
</ask_followup_question>

## Step 2: Run static analysis

Call analyze_codebase on the chosen directory.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

## Step 3: Summarise the results

Present a concise summary:
- Project type and detected frameworks
- File count, function count, internal call count
- Top 5 refactoring issues (function name, file, issue type, priority score)
- Detected domains

## Step 4: Show the call graph

Retrieve hub functions, entry points, and any layer violations.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_call_graph</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Highlight any hub functions (fanIn ≥ 8) or layer violations detected.

## Step 5: Show duplicate code report

Retrieve the duplicate function analysis (Types 1–3, pure static analysis).

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Present a concise summary:
- Overall duplication ratio (e.g. "12% of functions are duplicated")
- Top 3 clone groups sorted by impact (instances × line count):
  - Clone type (exact / structural / near) and similarity score
  - List of instances (file + function name + line range)
- If no duplicates found, note this as a positive signal

## Step 6: Suggest next steps

Based on the analysis, guide the user through the natural next steps in order:
1. Call `get_signatures` on the modules that contain the top issues to understand their public API
2. Call `get_subgraph` on the highest-priority function to map its callers and callees
3. If significant duplication was found, suggest consolidating clone groups before refactoring
4. Suggest running `/spec-gen-plan-refactor` once the user has enough context to act,
   then `/spec-gen-execute-refactor` to apply the plan
