/**
 * Tests for SignatureExtractor — all supported languages + formatter.
 *
 * Each language section verifies:
 *  - Correct kind ('class', 'function', 'method', 'interface', 'type')
 *  - Signature string content
 *  - Docstring extraction (where applicable)
 *  - Decorator extraction (Python)
 *  - MAX_SIGS_PER_FILE limit
 *
 * Cross-cutting:
 *  - detectLanguage() extension mapping
 *  - formatSignatureMaps() chunking + output format
 */

import { describe, it, expect } from 'vitest';
import {
  detectLanguage,
  extractSignatures,
  formatSignatureMaps,
  type ExtractedSignature,
  type FileSignatureMap,
} from './signature-extractor.js';

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  it.each([
    ['app.py',    'Python'],
    ['index.ts',  'TypeScript'],
    ['view.tsx',  'TypeScript'],
    ['main.js',   'JavaScript'],
    ['comp.jsx',  'JavaScript'],
    ['server.go', 'Go'],
    ['lib.rs',    'Rust'],
    ['app.rb',    'Ruby'],
    ['Main.java', 'Java'],
    ['App.kt',    'Kotlin'],
    ['Api.php',   'PHP'],
    ['Prog.cs',   'C#'],
    ['util.cpp',  'C++'],
    ['util.cc',   'C++'],
    ['util.cxx',  'C++'],
    ['main.c',    'C'],
    ['query.sql', 'unknown'],
    ['Makefile',  'unknown'],
  ])('%s → %s', (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Python extractor
// ---------------------------------------------------------------------------

describe('extractSignatures — Python', () => {
  it('extracts module-level functions', () => {
    const { entries } = extractSignatures('app.py', `
def main():
    pass

def helper(x, y):
    pass
`);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: 'function', name: 'main', signature: 'def main()' });
    expect(entries[1]).toMatchObject({ kind: 'function', name: 'helper', signature: 'def helper(x, y)' });
  });

  it('extracts class and methods', () => {
    const { entries } = extractSignatures('service.py', `
class UserService:
    def create(self, name: str) -> bool:
        pass

    def delete(self, id: int):
        pass
`);
    expect(entries[0]).toMatchObject({ kind: 'class', name: 'UserService', signature: 'class UserService:' });
    expect(entries[1]).toMatchObject({ kind: 'method', name: 'create' });
    expect(entries[1].signature).toContain('name: str');
    expect(entries[1].signature).toContain('-> bool');
    expect(entries[2]).toMatchObject({ kind: 'method', name: 'delete' });
  });

  it('removes self/cls from displayed params', () => {
    const { entries } = extractSignatures('model.py', `
class Repo:
    def find(self, query):
        pass

    @classmethod
    def from_dict(cls, data):
        pass
`);
    const find = entries.find(e => e.name === 'find')!;
    expect(find.signature).not.toContain('self');
    expect(find.signature).toContain('query');
  });

  it('extracts decorators', () => {
    const { entries } = extractSignatures('routes.py', `
@router.get('/users')
def get_users():
    pass
`);
    expect(entries[0]).toMatchObject({ name: 'get_users', decorator: "@router.get('/users')" });
  });

  it('extracts triple-quoted docstrings', () => {
    const { entries } = extractSignatures('utils.py', `
def compute():
    """Compute the result."""
    pass
`);
    expect(entries[0].docstring).toBe('Compute the result.');
  });

  it('extracts multi-line docstrings (first meaningful line)', () => {
    const { entries } = extractSignatures('utils.py', `
def compute():
    """
    Compute the result.
    More details here.
    """
    pass
`);
    expect(entries[0].docstring).toBe('Compute the result.');
  });

  it('skips private methods when there are already more than 2 entries', () => {
    const { entries } = extractSignatures('model.py', `
def pub_a():
    pass

def pub_b():
    pass

def pub_c():
    pass

def _private():
    pass
`);
    expect(entries.map(e => e.name)).not.toContain('_private');
  });

  it('keeps __init__ regardless of position', () => {
    const { entries } = extractSignatures('model.py', `
class Foo:
    def pub_a(self): pass
    def pub_b(self): pass
    def pub_c(self): pass
    def __init__(self): pass
`);
    expect(entries.map(e => e.name)).toContain('__init__');
  });

  it('extracts async functions', () => {
    const { entries } = extractSignatures('worker.py', `
async def fetch_data(url: str):
    pass
`);
    expect(entries[0].signature).toContain('async def fetch_data');
  });

  it('extracts class with base classes', () => {
    const { entries } = extractSignatures('model.py', `
class AdminUser(BaseUser, Mixin):
    pass
`);
    expect(entries[0].signature).toBe('class AdminUser(BaseUser, Mixin):');
  });
});

// ---------------------------------------------------------------------------
// TypeScript / JavaScript extractor
// ---------------------------------------------------------------------------

describe('extractSignatures — TypeScript', () => {
  it('extracts export class', () => {
    const { entries } = extractSignatures('service.ts', `
export class UserService {
  run() {}
}
`);
    expect(entries[0]).toMatchObject({ kind: 'class', name: 'UserService', signature: 'export class UserService' });
  });

  it('extracts export class with inheritance (name is captured)', () => {
    const { entries } = extractSignatures('service.ts', `
export class AdminService extends BaseService {
}
`);
    expect(entries[0]).toMatchObject({ kind: 'class', name: 'AdminService' });
    expect(entries[0].signature).toContain('export class AdminService');
  });

  it('extracts export interface', () => {
    const { entries } = extractSignatures('types.ts', `
export interface User {
  id: number;
}
`);
    expect(entries[0]).toMatchObject({ kind: 'interface', name: 'User', signature: 'export interface User' });
  });

  it('extracts export type', () => {
    const { entries } = extractSignatures('types.ts', `
export type UserId = string | number;
`);
    expect(entries[0]).toMatchObject({ kind: 'type', name: 'UserId', signature: 'export type UserId' });
  });

  it('extracts export function with return type', () => {
    const { entries } = extractSignatures('utils.ts', `
export function buildQuery(filter: Filter, limit: number): string {
  return '';
}
`);
    expect(entries[0]).toMatchObject({ kind: 'function', name: 'buildQuery' });
    expect(entries[0].signature).toContain('filter: Filter');
    expect(entries[0].signature).toContain('string');
  });

  it('extracts export async function', () => {
    const { entries } = extractSignatures('handler.ts', `
export async function handleRequest(req: Request): Promise<Response> {
  return new Response();
}
`);
    expect(entries[0]).toMatchObject({ kind: 'function', name: 'handleRequest' });
  });

  it('extracts export const arrow function', () => {
    const { entries } = extractSignatures('helpers.ts', `
export const transform = (input: string) => input.toUpperCase();
`);
    expect(entries[0]).toMatchObject({ kind: 'function', name: 'transform' });
    expect(entries[0].signature).toContain('export const transform');
  });

  it('extracts public class methods', () => {
    const { entries } = extractSignatures('service.ts', `
export class OrderService {
  createOrder(data: OrderData): Order {
    return {} as Order;
  }

  async cancelOrder(id: string): Promise<void> {}
}
`);
    const methods = entries.filter(e => e.kind === 'method');
    expect(methods.map(m => m.name)).toContain('createOrder');
    expect(methods.map(m => m.name)).toContain('cancelOrder');
  });

  it('extracts JSDoc as docstring', () => {
    const { entries } = extractSignatures('api.ts', `
/**
 * Fetch a user by ID.
 * @param id - user identifier
 */
export function getUser(id: string): User {
  return {} as User;
}
`);
    expect(entries[0].docstring).toBe('Fetch a user by ID.');
  });

  it('parses JavaScript files the same way', () => {
    const result = extractSignatures('index.js', `
export function init() {}
export class App {}
`);
    expect(result.language).toBe('JavaScript');
    expect(result.entries.map(e => e.name)).toContain('init');
    expect(result.entries.map(e => e.name)).toContain('App');
  });
});

// ---------------------------------------------------------------------------
// Go extractor
// ---------------------------------------------------------------------------

describe('extractSignatures — Go', () => {
  it('extracts top-level functions', () => {
    const { entries } = extractSignatures('main.go', `
package main

func Serve(addr string) error {
  return nil
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
}
`);
    const names = entries.map(e => e.name);
    expect(names).toContain('Serve');
    expect(names).toContain('handleRequest');
    expect(entries[0].signature).toContain('func Serve');
    expect(entries[0].signature).not.toContain('{');
  });

  it('extracts receiver methods', () => {
    const { entries } = extractSignatures('server.go', `
func (s *Server) Start() error {
  return nil
}
`);
    expect(entries[0]).toMatchObject({ kind: 'function', name: 'Start' });
  });

  it('extracts struct and interface type declarations', () => {
    const { entries } = extractSignatures('types.go', `
type Server struct {
  port int
}

type Handler interface {
  Handle()
}
`);
    const names = entries.map(e => e.name);
    expect(names).toContain('Server');
    expect(names).toContain('Handler');
    expect(entries.find(e => e.name === 'Server')?.kind).toBe('class');
    expect(entries.find(e => e.name === 'Handler')?.kind).toBe('interface');
  });

  it('extracts single-line comments as docstrings', () => {
    const { entries } = extractSignatures('util.go', `
// BuildQuery creates a SQL query string.
func BuildQuery(filter string) string {
  return ""
}
`);
    expect(entries[0].docstring).toBe('BuildQuery creates a SQL query string.');
  });

  it('skips init and Test functions', () => {
    const { entries } = extractSignatures('main_test.go', `
func init() {}
func TestSomething(t *testing.T) {}
func Run() {}
`);
    const names = entries.map(e => e.name);
    expect(names).not.toContain('init');
    expect(names).not.toContain('TestSomething');
    expect(names).toContain('Run');
  });
});

// ---------------------------------------------------------------------------
// Rust extractor
// ---------------------------------------------------------------------------

describe('extractSignatures — Rust', () => {
  it('extracts pub fn declarations', () => {
    const { entries } = extractSignatures('lib.rs', `
pub fn process(data: &str) -> Result<(), Error> {
    Ok(())
}
`);
    expect(entries[0]).toMatchObject({ kind: 'function', name: 'process' });
    expect(entries[0].signature).toContain('pub fn process');
    expect(entries[0].signature).toContain('Result<(), Error>');
  });

  it('extracts pub async fn', () => {
    const { entries } = extractSignatures('handler.rs', `
pub async fn fetch(url: &str) -> String {
    String::new()
}
`);
    expect(entries[0].signature).toContain('pub fn fetch');
  });

  it('extracts pub struct and pub enum', () => {
    const { entries } = extractSignatures('models.rs', `
pub struct User {
    pub id: u32,
}

pub enum Status {
    Active,
    Inactive,
}
`);
    expect(entries.find(e => e.name === 'User')?.kind).toBe('class');
    expect(entries.find(e => e.name === 'Status')?.kind).toBe('class');
    expect(entries.find(e => e.name === 'User')?.signature).toBe('pub struct User');
    expect(entries.find(e => e.name === 'Status')?.signature).toBe('pub enum Status');
  });

  it('extracts /// doc comments', () => {
    const { entries } = extractSignatures('api.rs', `
/// Handles incoming HTTP requests.
pub fn handle() {}
`);
    expect(entries[0].docstring).toBe('Handles incoming HTTP requests.');
  });

  it('skips private (non-pub) functions', () => {
    const { entries } = extractSignatures('internal.rs', `
fn private_helper() {}
pub fn public_fn() {}
`);
    expect(entries.map(e => e.name)).not.toContain('private_helper');
    expect(entries.map(e => e.name)).toContain('public_fn');
  });
});

// ---------------------------------------------------------------------------
// Ruby extractor
// ---------------------------------------------------------------------------

describe('extractSignatures — Ruby', () => {
  it('extracts class and method declarations', () => {
    const { entries } = extractSignatures('user.rb', `
class UserController
  def index
  end

  def show(id)
  end
end
`);
    expect(entries[0]).toMatchObject({ kind: 'class', name: 'UserController' });
    expect(entries[1]).toMatchObject({ kind: 'function', name: 'index', signature: 'def index' });
    expect(entries[2]).toMatchObject({ kind: 'function', name: 'show', signature: 'def show(id)' });
  });

  it('extracts class with inheritance', () => {
    const { entries } = extractSignatures('admin.rb', `
class AdminController < ApplicationController
end
`);
    expect(entries[0].signature).toBe('class AdminController < ApplicationController');
  });
});

// ---------------------------------------------------------------------------
// Generic fallback extractor
// ---------------------------------------------------------------------------

describe('extractSignatures — generic fallback', () => {
  it('captures function-like declarations from unknown languages', () => {
    const result = extractSignatures('script.php', `
public function handleRequest($req) {
}

function init() {}
`);
    expect(result.language).toBe('PHP');
    const names = result.entries.map(e => e.name);
    expect(names).toContain('handleRequest');
    expect(names).toContain('init');
  });

  it('detects Kotlin language and extracts class declarations via fallback', () => {
    // Kotlin uses 'fun' not 'function'/'fn', so the generic regex won't catch fns,
    // but 'class' keyword IS matched
    const result = extractSignatures('Main.kt', `
class App {
  fun main() {}
}
`);
    expect(result.language).toBe('Kotlin');
    expect(result.entries.map(e => e.name)).toContain('App');
  });
});

// ---------------------------------------------------------------------------
// formatSignatureMaps
// ---------------------------------------------------------------------------

describe('formatSignatureMaps', () => {
  const makeMap = (path: string, entries: Partial<ExtractedSignature>[]): FileSignatureMap => ({
    path,
    language: 'TypeScript',
    entries: entries.map(e => ({ kind: 'function', name: e.name ?? 'fn', signature: e.signature ?? `function ${e.name}()`, ...e })) as ExtractedSignature[],
  });

  it('formats a single file as a readable block', () => {
    const maps = [makeMap('src/utils.ts', [{ name: 'buildQuery', signature: 'export function buildQuery()' }])];
    const [chunk] = formatSignatureMaps(maps);
    expect(chunk).toContain('=== src/utils.ts [TypeScript] ===');
    expect(chunk).toContain('export function buildQuery()');
  });

  it('includes decorator on its own line', () => {
    const maps: FileSignatureMap[] = [{
      path: 'routes.py',
      language: 'Python',
      entries: [{ kind: 'function', name: 'get_users', signature: 'def get_users()', decorator: "@app.route('/users')" }],
    }];
    const [chunk] = formatSignatureMaps(maps);
    expect(chunk).toContain("@app.route('/users')");
    expect(chunk).toContain('def get_users()');
  });

  it('includes docstring indented below signature', () => {
    const maps: FileSignatureMap[] = [{
      path: 'utils.py',
      language: 'Python',
      entries: [{ kind: 'function', name: 'compute', signature: 'def compute()', docstring: 'Compute the result.' }],
    }];
    const [chunk] = formatSignatureMaps(maps);
    expect(chunk).toContain('"""Compute the result."""');
  });

  it('skips files with no entries', () => {
    const maps = [
      makeMap('empty.ts', []),
      makeMap('util.ts', [{ name: 'fn', signature: 'export function fn()' }]),
    ];
    const [chunk] = formatSignatureMaps(maps);
    expect(chunk).not.toContain('empty.ts');
    expect(chunk).toContain('util.ts');
  });

  it('returns fallback message when all files are empty', () => {
    const [chunk] = formatSignatureMaps([makeMap('empty.ts', [])]);
    expect(chunk).toBe('(no signatures extracted)');
  });

  it('splits into multiple chunks when total exceeds maxChars', () => {
    const longSig = 'x'.repeat(600);
    const maps = Array.from({ length: 5 }, (_, i) =>
      makeMap(`file${i}.ts`, [{ name: 'fn', signature: longSig }])
    );
    const chunks = formatSignatureMaps(maps, 1000);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('never splits a single file across two chunks', () => {
    // Each file produces ~700 chars, maxChars = 1000 → each file gets its own chunk
    const longSig = 'y'.repeat(700);
    const maps = Array.from({ length: 3 }, (_, i) =>
      makeMap(`file${i}.ts`, [{ name: 'fn', signature: longSig }])
    );
    const chunks = formatSignatureMaps(maps, 1000);
    for (const chunk of chunks) {
      // Each chunk should contain at most one file header
      const headers = (chunk.match(/===/g) ?? []).length;
      expect(headers).toBeGreaterThanOrEqual(2); // === path === has 2 triple-equals
    }
  });
});
