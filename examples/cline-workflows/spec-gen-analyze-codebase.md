# spec-gen: Analyze Codebase

Run a full static analysis of a project using spec-gen and summarise the results:
architecture, call graph, and top refactoring issues — no LLM required.

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

## Step 5: Suggest next steps

Based on the analysis, guide the user through the natural next steps in order:
1. Call `get_signatures` on the modules that contain the top issues to understand their public API
2. Call `get_subgraph` on the highest-priority function to map its callers and callees
3. Suggest running `/spec-gen-refactor-codebase` once the user has enough context to act
