/**
 * spec-gen setup command
 *
 * Installs workflow skills and agent integration files into the current project.
 * Unlike `analyze --ai-configs` (which generates project-specific context files),
 * `setup` copies static workflow assets that are the same for every project:
 *
 *   - Mistral Vibe skills  -> .vibe/skills/spec-gen-{name}/SKILL.md  (7 skills)
 *   - Cline workflows      -> .clinerules/workflows/spec-gen-{name}.md
 *   - GSD commands         -> .claude/commands/gsd/spec-gen-{name}.md
 *
 * Files are never overwritten — existing files are skipped silently.
 * Assets are read from the `examples/` directory shipped with the spec-gen package.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';

// ============================================================================
// TYPES
// ============================================================================

type ToolName = 'vibe' | 'cline' | 'gsd';

interface SkillEntry {
  /** Absolute source path inside the package's examples/ directory */
  src: string;
  /** Relative destination path from the project root */
  dest: string;
}

interface SetupResult {
  tool: ToolName;
  rel: string;
  created: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the spec-gen package (dist/cli/commands -> ../../.. -> package root) */
const PACKAGE_ROOT = join(__dirname, '../../..');

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function copyIfAbsent(src: string, dest: string): Promise<boolean> {
  if (await fileExists(dest)) return false;
  const content = await readFile(src, 'utf-8');
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, 'utf-8');
  return true;
}

// ============================================================================
// SKILL MANIFESTS
// ============================================================================

function buildManifest(projectRoot: string): Record<ToolName, SkillEntry[]> {
  const ex = join(PACKAGE_ROOT, 'examples');

  const VIBE_SKILLS = [
    'spec-gen-analyze-codebase',
    'spec-gen-brainstorm',
    'spec-gen-debug',
    'spec-gen-execute-refactor',
    'spec-gen-generate',
    'spec-gen-implement-story',
    'spec-gen-plan-refactor',
  ];

  const CLINE_WORKFLOWS = [
    'spec-gen-analyze-codebase.md',
    'spec-gen-check-spec-drift.md',
    'spec-gen-execute-refactor.md',
    'spec-gen-implement-feature.md',
    'spec-gen-plan-refactor.md',
    'spec-gen-refactor-codebase.md',
  ];

  const GSD_COMMANDS = [
    'spec-gen-orient.md',
    'spec-gen-drift.md',
  ];

  return {
    vibe: VIBE_SKILLS.map(name => ({
      src: join(ex, 'mistral-vibe', 'skills', name, 'SKILL.md'),
      dest: join(projectRoot, '.vibe', 'skills', name, 'SKILL.md'),
    })),
    cline: CLINE_WORKFLOWS.map(file => ({
      src: join(ex, 'cline-workflows', file),
      dest: join(projectRoot, '.clinerules', 'workflows', file),
    })),
    gsd: GSD_COMMANDS.map(file => ({
      src: join(ex, 'gsd', 'commands', 'gsd', file),
      dest: join(projectRoot, '.claude', 'commands', 'gsd', file),
    })),
  };
}

// ============================================================================
// CORE
// ============================================================================

async function runSetup(
  projectRoot: string,
  tools: ToolName[],
): Promise<SetupResult[]> {
  const manifest = buildManifest(projectRoot);
  const results: SetupResult[] = [];

  for (const tool of tools) {
    for (const entry of manifest[tool]) {
      if (!await fileExists(entry.src)) {
        logger.warning(`setup: source not found — ${entry.src} (re-install spec-gen to fix)`);
        continue;
      }
      const created = await copyIfAbsent(entry.src, entry.dest);
      const rel = entry.dest.startsWith(projectRoot)
        ? entry.dest.slice(projectRoot.length).replace(/^\//, '')
        : entry.dest;
      results.push({ tool, rel, created });
    }
  }

  return results;
}

// ============================================================================
// COMMAND
// ============================================================================

export const setupCommand = new Command('setup')
  .description(
    'Install workflow skills and agent integration files into this project.\n' +
    'Copies static assets from the spec-gen package — safe to re-run (skips existing files).'
  )
  .option(
    '--tools <list>',
    'Comma-separated list of tools to install: vibe, cline, gsd (default: all)',
  )
  .option(
    '--dir <path>',
    'Project root directory',
    process.cwd(),
  )
  .action(async (options: { tools?: string; dir: string }) => {
    const projectRoot = options.dir;
    const allTools: ToolName[] = ['vibe', 'cline', 'gsd'];
    const tools: ToolName[] = options.tools
      ? (options.tools.split(',').map(t => t.trim()) as ToolName[]).filter(t => allTools.includes(t))
      : allTools;

    if (tools.length === 0) {
      logger.error('setup: no valid tools specified. Valid values: vibe, cline, gsd');
      process.exit(1);
    }

    logger.success(`Installing workflow skills into ${projectRoot}`);

    let results: SetupResult[];
    try {
      results = await runSetup(projectRoot, tools);
    } catch (err) {
      logger.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const byTool: Record<string, SetupResult[]> = {};
    for (const r of results) {
      (byTool[r.tool] ??= []).push(r);
    }

    const LABELS: Record<ToolName, string> = {
      vibe:  'Mistral Vibe',
      cline: 'Cline / Roo Code',
      gsd:   'get-shit-done (GSD)',
    };

    for (const tool of tools) {
      const entries = byTool[tool] ?? [];
      const created = entries.filter(e => e.created).length;
      const skipped = entries.filter(e => !e.created).length;
      console.log(`\n${LABELS[tool as ToolName]}`);
      for (const e of entries) {
        console.log(`  ${e.created ? '✓ created' : '– exists '} ${e.rel}`);
      }
      if (entries.length === 0) {
        logger.warning('  (no source files found — check spec-gen installation)');
      } else {
        console.log(`  ${created} created, ${skipped} already existed`);
      }
    }

    const totalCreated = results.filter(r => r.created).length;
    if (totalCreated > 0) {
      logger.success(`${totalCreated} file(s) installed.`);
      console.log('Run `spec-gen analyze --ai-configs` to also generate project-specific context files (CLAUDE.md, .cursorrules, etc.).');
    } else {
      console.log('\nAll files already existed — nothing to do.');
    }
  });
