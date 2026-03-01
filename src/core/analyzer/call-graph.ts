/**
 * Call Graph Analyzer
 *
 * Performs static analysis of function calls across source files using tree-sitter.
 * Supports Python and TypeScript/JavaScript — no LLM involved, pure AST analysis.
 *
 * Produces:
 *  - FunctionNode[]  — all identified functions/methods
 *  - CallEdge[]      — resolved function→function call relationships
 *  - Hub functions   — high-fanIn nodes (called by many others)
 *  - Entry points    — functions with no internal callers
 *  - Layer violations — cross-layer calls in the wrong direction
 */

import Parser from 'tree-sitter';

// ============================================================================
// TYPES
// ============================================================================

export interface FunctionNode {
  /** Unique ID: "filepath::ClassName.methodName" or "filepath::functionName" */
  id: string;
  name: string;
  filePath: string;
  className?: string;
  isAsync: boolean;
  language: string;
  /** Byte offset range in source (for call attribution) */
  startIndex: number;
  endIndex: number;
  fanIn: number;
  fanOut: number;
}

export interface CallEdge {
  callerId: string;
  /** Resolved callee ID, or '' if unresolved (external/stdlib) */
  calleeId: string;
  /** Raw name as it appears in source */
  calleeName: string;
  line?: number;
}

export interface LayerViolation {
  callerId: string;
  calleeId: string;
  callerLayer: string;
  calleeLayer: string;
  reason: string;
}

export interface CallGraphResult {
  nodes: Map<string, FunctionNode>;
  edges: CallEdge[];
  /** Functions with fanIn >= HUB_THRESHOLD */
  hubFunctions: FunctionNode[];
  /** Functions with no internal callers (fanIn === 0) */
  entryPoints: FunctionNode[];
  layerViolations: LayerViolation[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    avgFanIn: number;
    avgFanOut: number;
  };
}

/** Serializable version (Maps replaced by arrays) for JSON storage */
export interface SerializedCallGraph {
  nodes: FunctionNode[];
  edges: CallEdge[];
  hubFunctions: FunctionNode[];
  entryPoints: FunctionNode[];
  layerViolations: LayerViolation[];
  stats: CallGraphResult['stats'];
}

// ============================================================================
// CONSTANTS
// ============================================================================

const HUB_THRESHOLD = 5;

/** Python/JS/TS keywords and builtins to ignore as call targets */
const IGNORED_CALLEES = new Set([
  // Python builtins
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'bool', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min', 'max',
  'open', 'input', 'format', 'repr', 'id', 'hash', 'abs', 'round', 'pow',
  'super', 'object', 'property', 'staticmethod', 'classmethod',
  // JS/TS common
  'console', 'log', 'error', 'warn', 'JSON', 'parse', 'stringify',
  'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'import', 'exports',
  // Python control flow (used like functions sometimes)
  'assert', 'raise', 'return', 'yield', 'await', 'pass', 'del',
  // Node.js common
  'readFile', 'writeFile', 'mkdir', 'join', 'resolve', 'basename', 'dirname',
  'existsSync', 'readFileSync', 'writeFileSync',
]);

// ============================================================================
// PARSER SINGLETONS (lazy init)
// ============================================================================

let _tsParser: Parser | undefined;
let _pyParser: Parser | undefined;
let _TsLanguage: object | undefined;
let _PyLanguage: object | undefined;

async function getTSParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_tsParser) {
    const tsModule = await import('tree-sitter-typescript');
    _TsLanguage = (tsModule.default as { typescript: object }).typescript;
    _tsParser = new Parser();
    (_tsParser as Parser).setLanguage(_TsLanguage as unknown as Parser.Language);
  }
  return { parser: _tsParser!, lang: _TsLanguage! };
}

async function getPyParser(): Promise<{ parser: Parser; lang: object }> {
  if (!_pyParser) {
    const pyModule = await import('tree-sitter-python');
    _PyLanguage = pyModule.default;
    _pyParser = new Parser();
    (_pyParser as Parser).setLanguage(_PyLanguage as unknown as Parser.Language);
  }
  return { parser: _pyParser!, lang: _PyLanguage! };
}

// ============================================================================
// ATTRIBUTION HELPER
// ============================================================================

/**
 * Given a list of function nodes (with startIndex/endIndex) and a call position,
 * find the narrowest enclosing function node.
 */
function findEnclosingFunction(
  nodes: FunctionNode[],
  callPos: number
): FunctionNode | undefined {
  let best: FunctionNode | undefined;
  let bestSize = Infinity;
  for (const n of nodes) {
    if (n.startIndex <= callPos && callPos < n.endIndex) {
      const size = n.endIndex - n.startIndex;
      if (size < bestSize) {
        bestSize = size;
        best = n;
      }
    }
  }
  return best;
}

// ============================================================================
// TYPESCRIPT EXTRACTOR
// ============================================================================

const TS_FN_QUERY = `
  (function_declaration
    name: (identifier) @fn.name) @fn.node

  (export_statement
    declaration: (function_declaration
      name: (identifier) @fn.name)) @fn.node

  (method_definition
    name: (property_identifier) @fn.name) @fn.node

  (lexical_declaration
    (variable_declarator
      name: (identifier) @fn.name
      value: [(arrow_function) (function_expression)] @fn.value)) @fn.node
`;

const TS_CALL_QUERY = `
  (call_expression
    function: [(identifier) @call.name
               (member_expression
                 property: (property_identifier) @call.name)]) @call.node
`;

async function extractTSGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: Array<{ callerId: string; calleeName: string; line: number }> }> {
  const { parser, lang } = await getTSParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, TS_FN_QUERY);
  const callQuery = new Parser.Query(lang as unknown as Parser.Language, TS_CALL_QUERY);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Find enclosing class (walk up)
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_declaration' || cursor.type === 'class_body') {
        const classNameNode = cursor.children.find(c => c.type === 'type_identifier' || c.type === 'identifier');
        if (classNameNode) {
          className = classNameNode.text;
        }
        break;
      }
      cursor = cursor.parent;
    }

    // Detect async
    const isAsync = fnNode.text.startsWith('async ') ||
      fnNode.children.some(c => c.type === 'async');

    const id = className
      ? `${filePath}::${className}.${name}`
      : `${filePath}::${name}`;

    nodes.push({
      id,
      name,
      filePath,
      className,
      isAsync,
      language: 'TypeScript',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0,
      fanOut: 0,
    });
  }

  // --- Extract calls ---
  const rawEdges: Array<{ callerId: string; calleeName: string; line: number }> = [];
  const callMatches = callQuery.matches(tree.rootNode);

  for (const match of callMatches) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (IGNORED_CALLEES.has(calleeName)) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
    });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// PYTHON EXTRACTOR
// ============================================================================

const PY_FN_QUERY = `
  (function_definition
    name: (identifier) @fn.name) @fn.node

  (decorated_definition
    (function_definition
      name: (identifier) @fn.name)) @fn.node
`;

/**
 * Direct function calls: foo(), bar(x)
 * We keep this separate from attribute calls so we can filter attribute calls
 * by object name (only self/cls are resolved to internal functions).
 */
const PY_DIRECT_CALL_QUERY = `
  (call
    function: (identifier) @call.name) @call.node
`;

/**
 * Method calls on an object: obj.method()
 * We capture the object name so we can restrict resolution to self/cls.
 * Calls like redis.get(), dict.get(), os.environ.get() are NOT resolved —
 * only self.method() and cls.method() are tracked as internal edges.
 */
const PY_METHOD_CALL_QUERY = `
  (call
    function: (attribute
      object: (identifier) @call.object
      attribute: (identifier) @call.name)) @call.node
`;

async function extractPyGraph(
  filePath: string,
  content: string
): Promise<{ nodes: FunctionNode[]; rawEdges: Array<{ callerId: string; calleeName: string; line: number }> }> {
  const { parser, lang } = await getPyParser();
  const tree = (parser as Parser).parse(content);

  const fnQuery = new Parser.Query(lang as unknown as Parser.Language, PY_FN_QUERY);

  // --- Extract function nodes ---
  const nodes: FunctionNode[] = [];
  const seen = new Set<number>(); // avoid duplicates from decorated_definition + function_definition
  const fnMatches = fnQuery.matches(tree.rootNode);

  for (const match of fnMatches) {
    const nameCapture = match.captures.find(c => c.name === 'fn.name');
    const nodeCapture = match.captures.find(c => c.name === 'fn.node');
    if (!nameCapture || !nodeCapture) continue;

    const name = nameCapture.node.text;
    const fnNode = nodeCapture.node;

    // Deduplicate by name node position (decorated_definition wraps the function_definition)
    if (seen.has(nameCapture.node.startIndex)) continue;
    seen.add(nameCapture.node.startIndex);

    // Find enclosing class
    let className: string | undefined;
    let cursor = fnNode.parent;
    while (cursor) {
      if (cursor.type === 'class_definition') {
        const classNameNode = cursor.children.find(c => c.type === 'identifier');
        if (classNameNode) className = classNameNode.text;
        break;
      }
      cursor = cursor.parent;
    }

    // Skip private methods (underscore prefix) unless they're __init__ or there are very few nodes
    if (name.startsWith('_') && name !== '__init__') continue;

    const isAsync = fnNode.text.startsWith('async ') ||
      (fnNode.type === 'function_definition' && fnNode.children[0]?.text === 'async');

    const id = className
      ? `${filePath}::${className}.${name}`
      : `${filePath}::${name}`;

    nodes.push({
      id,
      name,
      filePath,
      className,
      isAsync,
      language: 'Python',
      startIndex: fnNode.startIndex,
      endIndex: fnNode.endIndex,
      fanIn: 0,
      fanOut: 0,
    });
  }

  // --- Extract calls ---
  const rawEdges: Array<{ callerId: string; calleeName: string; line: number }> = [];

  const directCallQuery = new Parser.Query(lang as unknown as Parser.Language, PY_DIRECT_CALL_QUERY);
  const methodCallQuery = new Parser.Query(lang as unknown as Parser.Language, PY_METHOD_CALL_QUERY);

  // Direct calls: foo(), bar(x) — resolve across all files
  for (const match of directCallQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!nameCapture || !nodeCapture) continue;

    const calleeName = nameCapture.node.text;
    if (IGNORED_CALLEES.has(calleeName)) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
    });
  }

  // Method calls: obj.method() — only resolve self.* and cls.* (internal object methods)
  for (const match of methodCallQuery.matches(tree.rootNode)) {
    const objectCapture = match.captures.find(c => c.name === 'call.object');
    const nameCapture = match.captures.find(c => c.name === 'call.name');
    const nodeCapture = match.captures.find(c => c.name === 'call.node');
    if (!objectCapture || !nameCapture || !nodeCapture) continue;

    const objectName = objectCapture.node.text;
    // Only track self.method() and cls.method() — external objects like
    // redis.get(), dict.get(), os.path.join() would create massive false positives
    if (objectName !== 'self' && objectName !== 'cls') continue;

    const calleeName = nameCapture.node.text;
    if (IGNORED_CALLEES.has(calleeName)) continue;

    const callPos = nodeCapture.node.startIndex;
    const caller = findEnclosingFunction(nodes, callPos);
    if (!caller) continue;

    rawEdges.push({
      callerId: caller.id,
      calleeName,
      line: nodeCapture.node.startPosition.row + 1,
    });
  }

  return { nodes, rawEdges };
}

// ============================================================================
// CALL GRAPH BUILDER
// ============================================================================

export class CallGraphBuilder {
  /**
   * Build a call graph from a list of source files.
   *
   * @param files     Source files with path, content, and language
   * @param layers    Optional layer map { layerName: [path prefix, ...] }
   *                  e.g. { api: ['routes/', 'controllers/'], storage: ['models/'] }
   */
  async build(
    files: Array<{ path: string; content: string; language: string }>,
    layers?: Record<string, string[]>
  ): Promise<CallGraphResult> {
    const allNodes = new Map<string, FunctionNode>();
    const allRawEdges: Array<{ callerId: string; calleeName: string; line: number }> = [];

    // Pass 1: Extract nodes and raw edges from each file
    for (const file of files) {
      try {
        let result: { nodes: FunctionNode[]; rawEdges: Array<{ callerId: string; calleeName: string; line: number }> };

        if (file.language === 'Python') {
          result = await extractPyGraph(file.path, file.content);
        } else if (file.language === 'TypeScript' || file.language === 'JavaScript') {
          result = await extractTSGraph(file.path, file.content);
        } else {
          continue;
        }

        for (const node of result.nodes) {
          allNodes.set(node.id, node);
        }
        allRawEdges.push(...result.rawEdges);
      } catch {
        // Skip files that fail to parse (syntax errors, encoding issues, etc.)
      }
    }

    // Pass 2: Resolve raw edges — find callee FunctionNode by name
    const nodesByName = new Map<string, FunctionNode[]>();
    for (const node of allNodes.values()) {
      const list = nodesByName.get(node.name) ?? [];
      list.push(node);
      nodesByName.set(node.name, list);
    }

    const edges: CallEdge[] = [];
    for (const raw of allRawEdges) {
      const candidates = nodesByName.get(raw.calleeName);
      if (!candidates || candidates.length === 0) continue; // external call

      let calleeNode: FunctionNode;
      if (candidates.length === 1) {
        calleeNode = candidates[0];
      } else {
        // Prefer same file as caller
        const callerNode = allNodes.get(raw.callerId);
        const sameFile = candidates.find(c => c.filePath === callerNode?.filePath);
        calleeNode = sameFile ?? candidates[0];
      }

      edges.push({
        callerId: raw.callerId,
        calleeId: calleeNode.id,
        calleeName: raw.calleeName,
        line: raw.line,
      });
    }

    // Pass 3: Calculate fanIn / fanOut
    for (const edge of edges) {
      const caller = allNodes.get(edge.callerId);
      const callee = allNodes.get(edge.calleeId);
      if (caller) caller.fanOut++;
      if (callee) callee.fanIn++;
    }

    // Pass 4: Derive hub functions, entry points, layer violations
    const nodes = Array.from(allNodes.values());

    const hubFunctions = nodes
      .filter(n => n.fanIn >= HUB_THRESHOLD)
      .sort((a, b) => b.fanIn - a.fanIn);

    const calledIds = new Set(edges.map(e => e.calleeId));
    const entryPoints = nodes
      .filter(n => !calledIds.has(n.id))
      .sort((a, b) => b.fanOut - a.fanOut);

    const layerViolations = layers
      ? this.detectLayerViolations(edges, allNodes, layers)
      : [];

    const totalFanIn = nodes.reduce((s, n) => s + n.fanIn, 0);
    const totalFanOut = nodes.reduce((s, n) => s + n.fanOut, 0);

    return {
      nodes: allNodes,
      edges,
      hubFunctions,
      entryPoints,
      layerViolations,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        avgFanIn: nodes.length > 0 ? totalFanIn / nodes.length : 0,
        avgFanOut: nodes.length > 0 ? totalFanOut / nodes.length : 0,
      },
    };
  }

  private detectLayerViolations(
    edges: CallEdge[],
    nodes: Map<string, FunctionNode>,
    layers: Record<string, string[]>
  ): LayerViolation[] {
    // Build ordered layer list (index 0 = top layer, higher index = lower layer)
    const layerOrder = Object.keys(layers);

    const getLayer = (filePath: string): string | undefined => {
      for (const [layerName, prefixes] of Object.entries(layers)) {
        if (prefixes.some(p => filePath.includes(p))) return layerName;
      }
      return undefined;
    };

    const violations: LayerViolation[] = [];
    for (const edge of edges) {
      const caller = nodes.get(edge.callerId);
      const callee = nodes.get(edge.calleeId);
      if (!caller || !callee) continue;

      const callerLayer = getLayer(caller.filePath);
      const calleeLayer = getLayer(callee.filePath);
      if (!callerLayer || !calleeLayer || callerLayer === calleeLayer) continue;

      const callerIdx = layerOrder.indexOf(callerLayer);
      const calleeIdx = layerOrder.indexOf(calleeLayer);
      if (callerIdx > calleeIdx) {
        // Lower layer calling upper layer — violation
        violations.push({
          callerId: edge.callerId,
          calleeId: edge.calleeId,
          callerLayer,
          calleeLayer,
          reason: `${callerLayer} calls ${calleeLayer} (${caller.name} → ${callee.name})`,
        });
      }
    }

    return violations;
  }
}

// ============================================================================
// SERIALIZATION HELPER
// ============================================================================

export function serializeCallGraph(result: CallGraphResult): SerializedCallGraph {
  return {
    nodes: Array.from(result.nodes.values()),
    edges: result.edges,
    hubFunctions: result.hubFunctions,
    entryPoints: result.entryPoints,
    layerViolations: result.layerViolations,
    stats: result.stats,
  };
}
