/**
 * Database Schema Extractor
 *
 * Parses ORM schema definitions from source files using regex-based analysis.
 * Supports Prisma, TypeORM, Drizzle ORM, and SQLAlchemy.
 *
 * Audit fields (createdAt, updatedAt, created_at, updated_at, deletedAt,
 * deleted_at) are excluded from field lists to keep output concise.
 *
 * Inspired by Codesight's schema detector approach.
 */

import { readFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
}

export type OrmType = 'prisma' | 'typeorm' | 'drizzle' | 'sqlalchemy' | 'unknown';

export interface SchemaTable {
  /** Model / table name */
  name: string;
  /** Path relative to project root */
  file: string;
  /** ORM that owns this schema */
  orm: OrmType;
  /** Extracted fields (audit fields excluded) */
  fields: SchemaField[];
  /** 1-based line of the model declaration */
  line: number;
}

// ============================================================================
// AUDIT FIELD FILTER
// ============================================================================

const AUDIT_FIELD_NAMES = new Set([
  'createdAt', 'updatedAt', 'deletedAt',
  'created_at', 'updated_at', 'deleted_at',
  'createdBy', 'updatedBy', 'created_by', 'updated_by',
]);

function isAuditField(name: string): boolean {
  return AUDIT_FIELD_NAMES.has(name);
}

// ============================================================================
// HELPERS
// ============================================================================

function lineOfIndex(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// ============================================================================
// PRISMA PARSER (.prisma files)
// ============================================================================

// model User { ... }
const PRISMA_MODEL_RE = /^model\s+(\w+)\s*\{([^}]+)\}/gm;
// field line: fieldName  FieldType? @...
const PRISMA_FIELD_RE = /^\s{1,4}(\w+)\s+(\w+)(\?)?/m;

function parsePrisma(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const modelRe = new RegExp(PRISMA_MODEL_RE.source, PRISMA_MODEL_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = modelRe.exec(source)) !== null) {
    const name = m[1];
    const body = m[2];
    const line = lineOfIndex(source, m.index);
    const fields: SchemaField[] = [];

    for (const rawLine of body.split('\n')) {
      const fm = PRISMA_FIELD_RE.exec(rawLine);
      if (!fm) continue;
      const fieldName = fm[1];
      if (fieldName.startsWith('@') || fieldName === '@@') continue;
      if (isAuditField(fieldName)) continue;
      fields.push({
        name: fieldName,
        type: fm[2],
        nullable: fm[3] === '?',
      });
    }

    tables.push({ name, file: rel, orm: 'prisma', fields, line });
  }

  return tables;
}

// ============================================================================
// TYPEORM PARSER (.ts files with @Entity)
// ============================================================================

// @Entity() ... class ClassName { ... }
// We capture class name after @Entity decorator region.
const TYPEORM_ENTITY_RE = /@Entity\s*\([^)]*\)[^]*?class\s+(\w+)/g;
// @Column() / @PrimaryGeneratedColumn() etc before fieldName: FieldType
const TYPEORM_COLUMN_RE = /@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|ManyToOne|OneToMany|ManyToMany|OneToOne|JoinColumn|JoinTable)\s*\([^)]*\)\s*\n\s*(\w+)\s*[?!]?\s*:\s*([^;\n]+)/g;
const TYPEORM_CLASS_BODY_RE = /class\s+\w+[^{]*\{([^]*?)^}/m;

function parseTypeOrm(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const entityRe = new RegExp(TYPEORM_ENTITY_RE.source, TYPEORM_ENTITY_RE.flags);
  let em: RegExpExecArray | null;

  while ((em = entityRe.exec(source)) !== null) {
    const name = em[1];
    const line = lineOfIndex(source, em.index);
    const fields: SchemaField[] = [];

    // Extract class body starting from the match
    const afterMatch = source.slice(em.index);
    const bodyMatch = TYPEORM_CLASS_BODY_RE.exec(afterMatch);
    if (bodyMatch) {
      const body = bodyMatch[1];
      const colRe = new RegExp(TYPEORM_COLUMN_RE.source, TYPEORM_COLUMN_RE.flags);
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(body)) !== null) {
        const fieldName = cm[1];
        if (isAuditField(fieldName)) continue;
        fields.push({
          name: fieldName,
          type: cm[2].trim().replace(/;.*$/, ''),
          nullable: cm[2].includes('null') || false,
        });
      }
    }

    tables.push({ name, file: rel, orm: 'typeorm', fields, line });
  }

  return tables;
}

// ============================================================================
// DRIZZLE ORM PARSER (.ts files)
// ============================================================================

// export const users = pgTable('users', { ... })
const DRIZZLE_TABLE_RE = /(?:export\s+(?:const|let)\s+(\w+)\s*=\s*)?(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`](\w+)['"`]\s*,\s*\{([^}]+)\}/g;
// fieldName: columnType(...)
const DRIZZLE_FIELD_RE = /^\s{1,6}(\w+)\s*:\s*([\w.]+)\s*\(/m;

function parseDrizzle(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const tableRe = new RegExp(DRIZZLE_TABLE_RE.source, DRIZZLE_TABLE_RE.flags);
  let m: RegExpExecArray | null;

  while ((m = tableRe.exec(source)) !== null) {
    // Prefer the table name literal (m[2]) over the variable name (m[1])
    const name = m[2] || m[1] || 'unknown';
    const body = m[3];
    const line = lineOfIndex(source, m.index);
    const fields: SchemaField[] = [];

    for (const rawLine of body.split('\n')) {
      const fm = DRIZZLE_FIELD_RE.exec(rawLine);
      if (!fm) continue;
      const fieldName = fm[1];
      if (isAuditField(fieldName)) continue;
      fields.push({
        name: fieldName,
        type: fm[2],
        nullable: rawLine.includes('.nullable()') || rawLine.includes('$default'),
      });
    }

    tables.push({ name, file: rel, orm: 'drizzle', fields, line });
  }

  return tables;
}

// ============================================================================
// SQLALCHEMY PARSER (.py files)
// ============================================================================

// class User(Base): or class User(db.Model):
const SQLALCHEMY_MODEL_RE = /^class\s+(\w+)\s*\([^)]*(?:Base|db\.Model|DeclarativeBase)[^)]*\)\s*:/gm;
// column_name = Column(Type, ...)
const SQLALCHEMY_COLUMN_RE = /^\s{4}(\w+)\s*=\s*(?:mapped_column|Column)\s*\(\s*([^,)]+)/m;
// nullable: nullable=True (default) or nullable=False
const SQLALCHEMY_NULLABLE_RE = /nullable\s*=\s*(True|False)/;

function parseSqlAlchemy(source: string, rel: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  const classRe = new RegExp(SQLALCHEMY_MODEL_RE.source, SQLALCHEMY_MODEL_RE.flags);
  let cm: RegExpExecArray | null;

  while ((cm = classRe.exec(source)) !== null) {
    const name = cm[1];
    const line = lineOfIndex(source, cm.index);
    const fields: SchemaField[] = [];

    // Capture up to next class or end of file
    const rest = source.slice(cm.index + cm[0].length);
    const nextClassIdx = rest.search(/^class\s+\w+/m);
    const classBody = nextClassIdx >= 0 ? rest.slice(0, nextClassIdx) : rest;

    for (const rawLine of classBody.split('\n')) {
      const fm = SQLALCHEMY_COLUMN_RE.exec(rawLine);
      if (!fm) continue;
      const fieldName = fm[1];
      if (fieldName.startsWith('_') || isAuditField(fieldName)) continue;
      const nullableMatch = SQLALCHEMY_NULLABLE_RE.exec(rawLine);
      // SQLAlchemy columns are nullable by default
      const nullable = nullableMatch ? nullableMatch[1] === 'True' : true;
      fields.push({
        name: fieldName,
        type: fm[2].trim().replace(/[,)].*/s, ''),
        nullable,
      });
    }

    tables.push({ name, file: rel, orm: 'sqlalchemy', fields, line });
  }

  return tables;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Extract database schema tables from a list of absolute file paths.
 *
 * @param filePaths - Absolute paths to source files
 * @param rootDir   - Project root used to compute relative paths in output
 */
export async function extractSchemas(
  filePaths: string[],
  rootDir: string
): Promise<SchemaTable[]> {
  const results: SchemaTable[] = [];

  await Promise.all(
    filePaths.map(async filePath => {
      const ext = extname(filePath).toLowerCase();
      const rel = relative(rootDir, filePath);
      let source: string;

      try {
        source = await readFile(filePath, 'utf-8');
      } catch {
        return;
      }

      if (ext === '.prisma') {
        results.push(...parsePrisma(source, rel));
      } else if (ext === '.py' && (source.includes('Column(') || source.includes('mapped_column('))) {
        results.push(...parseSqlAlchemy(source, rel));
      } else if (ext === '.ts' || ext === '.tsx') {
        if (source.includes('@Entity(') || source.includes('@Entity()')) {
          results.push(...parseTypeOrm(source, rel));
        } else if (/pgTable|mysqlTable|sqliteTable/.test(source)) {
          results.push(...parseDrizzle(source, rel));
        }
      }
    })
  );

  return results;
}

/**
 * Summarise schema tables by ORM for display / artifact embedding.
 */
export function summarizeSchemas(
  tables: SchemaTable[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t.orm] = (counts[t.orm] ?? 0) + 1;
  }
  return counts;
}
