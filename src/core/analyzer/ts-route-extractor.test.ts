/**
 * TypeScript/JS Route Extraction Tests
 *
 * Tests for extractTsRouteDefinitions() and buildRouteInventory()
 * added to http-route-parser.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractTsRouteDefinitions,
  buildRouteInventory,
} from './http-route-parser.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `ts-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  const parts = name.split('/');
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// TESTS
// ============================================================================

describe('extractTsRouteDefinitions – Express', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects GET and POST routes', async () => {
    const fp = await createFile(tmpDir, 'routes.ts', `
import express from 'express';
const router = express.Router();

router.get('/users', getUsers);
router.post('/users', createUser);
router.delete('/users/:id', deleteUser);
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    const methods = routes.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/users');
    expect(paths.some(p => p.includes('id'))).toBe(true);
  });

  it('sets framework to express when import detected', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
const app = express();
app.get('/health', check);
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].framework).toBe('express');
  });
});

describe('extractTsRouteDefinitions – NestJS', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects NestJS controller routes', async () => {
    const fp = await createFile(tmpDir, 'users.controller.ts', `
import { Controller, Get, Post, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return id; }

  @Post()
  create() { return {}; }
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes[0].framework).toBe('nestjs');
    const paths = routes.map(r => r.path);
    // All paths should start with /users
    expect(paths.every(p => p.startsWith('/users'))).toBe(true);
    const methods = routes.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });
});

describe('extractTsRouteDefinitions – Next.js App Router', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects Next.js App Router handlers', async () => {
    const fp = await createFile(tmpDir, 'app/users/route.ts', `
export async function GET(request: Request) {
  return Response.json([]);
}

export async function POST(request: Request) {
  return Response.json({});
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].framework).toBe('nextjs-app');
    const methods = routes.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    // path should be derived from directory
    expect(routes[0].path).toBe('/users');
  });
});

describe('buildRouteInventory', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('aggregates routes from multiple files', async () => {
    const fp1 = await createFile(tmpDir, 'routes/users.ts', `
import express from 'express';
const router = express.Router();
router.get('/users', list);
router.post('/users', create);
`);
    const fp2 = await createFile(tmpDir, 'routes/products.ts', `
import express from 'express';
const router = express.Router();
router.get('/products', listProducts);
router.delete('/products/:id', deleteProduct);
`);
    const inventory = await buildRouteInventory([fp1, fp2], tmpDir);
    expect(inventory.total).toBeGreaterThanOrEqual(4);
    expect(inventory.byMethod['GET']).toBeGreaterThanOrEqual(2);
    expect(inventory.byMethod['POST']).toBeGreaterThanOrEqual(1);
    expect(inventory.byMethod['DELETE']).toBeGreaterThanOrEqual(1);
    expect(inventory.routes.every(r => !r.file.startsWith('/'))).toBe(true); // relative paths
  });

  it('returns empty inventory for non-route files', async () => {
    const fp = await createFile(tmpDir, 'service.ts', `
export class UserService {
  async findAll() { return []; }
}
`);
    const inventory = await buildRouteInventory([fp], tmpDir);
    expect(inventory.total).toBe(0);
    expect(inventory.routes).toHaveLength(0);
  });
});
