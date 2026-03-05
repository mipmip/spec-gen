import { useState, useCallback, useRef, useEffect, useMemo } from "react";

// ─── Palette ──────────────────────────────────────────────────────────────────
const CLUSTER_PALETTE = [
  "#7c6af7","#3ecfcf","#f77c6a","#6af7a0","#f7c76a",
  "#f76ac8","#6aaff7","#c8f76a","#f7a06a","#a0a0ff",
  "#ff6b9d","#00d4aa","#ffb347",
];
const EXT_COLOR = {
  ".ts":"#4ecdc4",".tsx":"#3ecfcf",".js":"#f5c518",".jsx":"#f5a018",
  ".css":"#a78bfa",".html":"#fb923c",".json":"#34d399",
  ".toml":"#f472b6",".md":"#94a3b8",".yml":"#60a5fa","":"#64748b",
};
const extColor = (ext) => EXT_COLOR[ext] || "#64748b";

// ─── Parse ────────────────────────────────────────────────────────────────────
function parseGraph(raw) {
  const clusterByNode = {};
  (raw.clusters || []).forEach((cl, ci) => {
    cl.files.forEach((fid) => {
      clusterByNode[fid] = {
        name: cl.name, index: ci, id: cl.id,
        color: CLUSTER_PALETTE[ci % CLUSTER_PALETTE.length],
      };
    });
  });

  const nodes = (raw.nodes || []).map((n) => ({
    id: n.id,
    label: n.file.name,
    path: n.file.path,
    ext: n.file.extension,
    dir: n.file.directory,
    size: n.file.size,
    lines: n.file.lines,
    score: n.file.score,
    isEntry: n.file.isEntryPoint,
    isConfig: n.file.isConfig,
    isTest: n.file.isTest,
    tags: n.file.tags || [],
    exports: n.exports || [],
    metrics: n.metrics,
    cluster: clusterByNode[n.id] || { name:"(root)", index:12, id:"root", color:CLUSTER_PALETTE[12] },
  }));

  const edges = (raw.edges || []).map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    importedNames: e.importedNames || [],
    isType: e.isTypeOnly || false,
    weight: e.weight || 1,
  }));

  const clusters = (raw.clusters || []).map((cl, ci) => ({
    ...cl, color: CLUSTER_PALETTE[ci % CLUSTER_PALETTE.length],
  }));

  return { nodes, edges, clusters, statistics: raw.statistics || {}, rankings: raw.rankings || {} };
}

// ─── BFS blast radius ─────────────────────────────────────────────────────────
function computeBlast(edges, nodeId) {
  const affected = new Set();
  const q = [nodeId];
  while (q.length) {
    const cur = q.shift();
    edges.forEach((e) => {
      if (e.source === cur && !affected.has(e.target)) {
        affected.add(e.target); q.push(e.target);
      }
    });
  }
  return [...affected];
}

// ─── Force layout ─────────────────────────────────────────────────────────────
function computeLayout(nodes, edges, W = 900, H = 540) {
  if (!nodes.length) return {};
  const pos = {};

  // seed by cluster ring
  const byCluster = {};
  nodes.forEach((n) => {
    if (!byCluster[n.cluster.id]) byCluster[n.cluster.id] = [];
    byCluster[n.cluster.id].push(n.id);
  });
  const clIds = Object.keys(byCluster);
  clIds.forEach((cid, ci) => {
    const angle = (ci / clIds.length) * Math.PI * 2 - Math.PI / 2;
    const cx = W/2 + Math.cos(angle) * W * 0.33;
    const cy = H/2 + Math.sin(angle) * H * 0.30;
    byCluster[cid].forEach((nid, mi) => {
      const a2 = (mi / Math.max(byCluster[cid].length, 1)) * Math.PI * 2;
      const r = Math.min(60, 13 * Math.sqrt(byCluster[cid].length));
      pos[nid] = { x: cx + Math.cos(a2)*r, y: cy + Math.sin(a2)*r };
    });
  });

  const edgeMap = {};
  edges.forEach(e => {
    if (!edgeMap[e.source]) edgeMap[e.source] = [];
    edgeMap[e.source].push(e.target);
  });

  const k = 55;
  for (let iter = 0; iter < 80; iter++) {
    const disp = {};
    nodes.forEach(n => { disp[n.id] = { x:0, y:0 }; });

    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = pos[a.id].x - pos[b.id].x;
        const dy = pos[a.id].y - pos[b.id].y;
        const d = Math.max(Math.sqrt(dx*dx+dy*dy), 0.01);
        const f = (k*k) / d;
        disp[a.id].x += (dx/d)*f; disp[a.id].y += (dy/d)*f;
        disp[b.id].x -= (dx/d)*f; disp[b.id].y -= (dy/d)*f;
      }
    }

    // attraction along edges
    edges.forEach(e => {
      if (!pos[e.source] || !pos[e.target]) return;
      const dx = pos[e.source].x - pos[e.target].x;
      const dy = pos[e.source].y - pos[e.target].y;
      const d = Math.max(Math.sqrt(dx*dx+dy*dy), 0.01);
      const f = (d*d) / (k * (e.isType ? 2 : 1));
      disp[e.source].x -= (dx/d)*f; disp[e.source].y -= (dy/d)*f;
      disp[e.target].x += (dx/d)*f; disp[e.target].y += (dy/d)*f;
    });

    const temp = k * Math.max(0.05, 1 - iter/80) * 0.5;
    nodes.forEach(n => {
      const d = Math.sqrt(disp[n.id].x**2 + disp[n.id].y**2);
      if (d > 0) {
        pos[n.id].x += (disp[n.id].x/d) * Math.min(d, temp);
        pos[n.id].y += (disp[n.id].y/d) * Math.min(d, temp);
      }
      pos[n.id].x = Math.max(36, Math.min(W-36, pos[n.id].x));
      pos[n.id].y = Math.max(36, Math.min(H-36, pos[n.id].y));
    });
  }
  return pos;
}

// ─── Cluster layout ───────────────────────────────────────────────────────────
function computeClusterLayout(clusters, W=900, H=540) {
  const pos = {};
  clusters.forEach((cl, i) => {
    const angle = (i / clusters.length) * Math.PI * 2 - Math.PI / 2;
    pos[cl.id] = {
      x: W/2 + Math.cos(angle) * W * 0.34,
      y: H/2 + Math.sin(angle) * H * 0.32,
    };
  });
  return pos;
}

// ─── Flat SVG graph ───────────────────────────────────────────────────────────
function FlatGraph({ nodes, edges, selectedId, affectedIds, focusedIds, onSelect }) {
  const posRef = useRef(null);
  const prevKey = useRef(null);
  const [, tick] = useState(0);
  const key = nodes.map(n=>n.id).sort().join("|");

  useEffect(() => {
    if (key !== prevKey.current) {
      posRef.current = computeLayout(nodes, edges);
      prevKey.current = key;
      tick(t => t+1);
    }
  }, [key]);

  const pos = posRef.current || {};

  const getState = (id) => {
    if (id === selectedId) return "selected";
    if (affectedIds.includes(id)) return "affected";
    if (focusedIds.length && focusedIds.includes(id)) return "focused";
    if (focusedIds.length) return "dimmed";
    return "default";
  };

  return (
    <svg viewBox="0 0 900 540" style={{ width:"100%", height:"100%" }}>
      <defs>
        <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#1e2340"/>
        </marker>
        <marker id="arr-sel" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#7c6af7"/>
        </marker>
        <marker id="arr-aff" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#f77c6a"/>
        </marker>
        <marker id="arr-type" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#2a2f5a"/>
        </marker>
        <filter id="glow">
          <feGaussianBlur stdDeviation="4" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-aff">
          <feGaussianBlur stdDeviation="2.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Cluster halos */}
      {Object.entries(
        nodes.reduce((acc, n) => {
          if (!acc[n.cluster.id]) acc[n.cluster.id] = { nodes:[], color:n.cluster.color };
          acc[n.cluster.id].nodes.push(n);
          return acc;
        }, {})
      ).map(([cid, { nodes:cn, color }]) => {
        const pts = cn.map(n => pos[n.id]).filter(Boolean);
        if (!pts.length) return null;
        const cx = pts.reduce((s,p)=>s+p.x,0)/pts.length;
        const cy = pts.reduce((s,p)=>s+p.y,0)/pts.length;
        const r = Math.max(...pts.map(p=>Math.sqrt((p.x-cx)**2+(p.y-cy)**2)), 20) + 28;
        return <ellipse key={cid} cx={cx} cy={cy} rx={r} ry={r*0.85}
          fill={`${color}07`} stroke={`${color}18`} strokeWidth={1} strokeDasharray="5 3"/>;
      })}

      {/* Edges */}
      {edges.map((e) => {
        const s = pos[e.source], t = pos[e.target];
        if (!s || !t) return null;
        const dx = t.x-s.x, dy = t.y-s.y, len = Math.sqrt(dx*dx+dy*dy)||1;
        const nx = dx/len, ny = dy/len, nr = 18;
        const isSel = e.source === selectedId || e.target === selectedId;
        const isAff = affectedIds.includes(e.target) && e.source === selectedId;
        return (
          <line key={e.id}
            x1={s.x+nx*nr} y1={s.y+ny*nr}
            x2={t.x-nx*(nr+5)} y2={t.y-ny*(nr+5)}
            stroke={isSel ? "#7c6af7" : isAff ? "#f77c6a" : e.isType ? "#252a4a" : "#181c36"}
            strokeWidth={isSel ? 1.5 : isAff ? 1.2 : 0.8}
            strokeOpacity={isSel ? 0.9 : isAff ? 0.7 : e.isType ? 0.35 : 0.55}
            strokeDasharray={e.isType ? "4 2" : undefined}
            markerEnd={isSel ? "url(#arr-sel)" : isAff ? "url(#arr-aff)" : e.isType ? "url(#arr-type)" : "url(#arr)"}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((n) => {
        const p = pos[n.id]; if (!p) return null;
        const state = getState(n.id);
        const col = extColor(n.ext);
        const isSel = state === "selected";
        const isAff = state === "affected";
        const isDim = state === "dimmed";
        const r = 15 + Math.min(n.score/14, 6);

        return (
          <g key={n.id} transform={`translate(${p.x},${p.y})`}
            onClick={() => onSelect(n.id)}
            style={{ cursor:"pointer" }}
            opacity={isDim ? 0.08 : 1}
            filter={isSel ? "url(#glow)" : isAff ? "url(#glow-aff)" : undefined}
          >
            <circle r={r+4} fill="none" stroke={n.cluster.color}
              strokeWidth={1} strokeOpacity={isSel ? 0.5 : 0.1}/>
            <circle r={r}
              fill={isSel ? `${col}1a` : isAff ? `${col}0d` : "#0b0d1e"}
              stroke={isSel ? col : isAff ? col : "#1c2038"}
              strokeWidth={isSel ? 2.5 : isAff ? 2 : 0.8}
            />
            {n.isEntry && (
              <circle r={r+8} fill="none" stroke={col}
                strokeWidth={0.7} strokeDasharray="3 2" strokeOpacity={0.28}/>
            )}
            <text textAnchor="middle" dominantBaseline="middle"
              fontSize={7} fontWeight={isSel ? 700 : 400}
              fill={isSel ? "#fff" : isAff ? col : "#5a6090"}
              fontFamily="'JetBrains Mono',monospace"
              style={{ pointerEvents:"none" }}
            >{n.label.length > 13 ? n.label.slice(0,12)+"…" : n.label}</text>
            {n.score > 0 && (
              <text x={r+1} y={-r+2} fontSize={6} fill={col}
                fontFamily="monospace" style={{ pointerEvents:"none" }}>{n.score}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Cluster SVG graph ────────────────────────────────────────────────────────
function ClusterGraph({ clusters, edges, nodes, expandedClusters, onToggle, onSelectNode, selectedId, affectedIds }) {
  const clusterPos = useMemo(() => computeClusterLayout(clusters), [clusters.map(c=>c.id).join()]);

  const nodeLayouts = useMemo(() => {
    const layouts = {};
    clusters.forEach((cl) => {
      if (!expandedClusters.has(cl.id)) return;
      const members = nodes.filter(n => n.cluster.id === cl.id);
      const cp = clusterPos[cl.id]; if (!cp) return;
      const r = 55 + members.length * 9;
      const layout = {};
      members.forEach((n, i) => {
        const a = (i / Math.max(members.length,1)) * Math.PI * 2 - Math.PI/2;
        layout[n.id] = { x: cp.x + Math.cos(a)*r, y: cp.y + Math.sin(a)*r };
      });
      layouts[cl.id] = layout;
    });
    return layouts;
  }, [clusters, expandedClusters, nodes, clusterPos]);

  // inter-cluster edges (deduplicated, weighted by count)
  const clusterEdges = useMemo(() => {
    const counts = {};
    edges.forEach(e => {
      const sn = nodes.find(n => n.id === e.source);
      const tn = nodes.find(n => n.id === e.target);
      if (!sn || !tn || sn.cluster.id === tn.cluster.id) return;
      const key = `${sn.cluster.id}→${tn.cluster.id}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).map(([key, count]) => {
      const [sc, tc] = key.split("→");
      return { id: key, source: sc, target: tc, count };
    });
  }, [edges, nodes]);

  return (
    <svg viewBox="0 0 900 540" style={{ width:"100%", height:"100%" }}>
      <defs>
        <marker id="carr" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#2a3060"/>
        </marker>
        <marker id="carr-sel" markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0,0 L0,5 L6,2.5z" fill="#7c6af7"/>
        </marker>
        <filter id="cglow">
          <feGaussianBlur stdDeviation="6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="nglow">
          <feGaussianBlur stdDeviation="3" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Inter-cluster edges */}
      {clusterEdges.map((e) => {
        const s = clusterPos[e.source], t = clusterPos[e.target];
        if (!s || !t) return null;
        const dx = t.x-s.x, dy = t.y-s.y, len = Math.sqrt(dx*dx+dy*dy)||1;
        const nx = dx/len, ny = dy/len;
        const rs = 38, rt = 38;
        const isSel = selectedId &&
          (nodes.find(n=>n.id===selectedId)?.cluster.id === e.source ||
           nodes.find(n=>n.id===selectedId)?.cluster.id === e.target);
        const w = Math.min(1 + e.count * 0.15, 4);
        return (
          <g key={e.id}>
            <line
              x1={s.x+nx*rs} y1={s.y+ny*rs}
              x2={t.x-nx*(rt+5)} y2={t.y-ny*(rt+5)}
              stroke={isSel ? "#7c6af7" : "#1e2448"}
              strokeWidth={isSel ? w+0.5 : w}
              strokeOpacity={isSel ? 0.85 : 0.5}
              markerEnd={isSel ? "url(#carr-sel)" : "url(#carr)"}
            />
            {/* count badge */}
            <text
              x={(s.x+nx*rs + t.x-nx*(rt+5))/2}
              y={(s.y+ny*rs + t.y-ny*(rt+5))/2 - 4}
              textAnchor="middle" fontSize={7}
              fill={isSel ? "#7c6af7" : "#2a3060"}
              fontFamily="'JetBrains Mono',monospace"
              style={{ pointerEvents:"none" }}
            >{e.count}</text>
          </g>
        );
      })}

      {/* Intra-cluster edges (expanded) */}
      {clusters.filter(cl => expandedClusters.has(cl.id)).map(cl => {
        const layout = nodeLayouts[cl.id] || {};
        return edges
          .filter(e => {
            const sn = nodes.find(n=>n.id===e.source);
            const tn = nodes.find(n=>n.id===e.target);
            return sn?.cluster.id === cl.id && tn?.cluster.id === cl.id;
          })
          .map(e => {
            const s = layout[e.source], t = layout[e.target];
            if (!s || !t) return null;
            const dx=t.x-s.x, dy=t.y-s.y, len=Math.sqrt(dx*dx+dy*dy)||1;
            const nx=dx/len, ny=dy/len, r=13;
            return (
              <line key={e.id}
                x1={s.x+nx*r} y1={s.y+ny*r}
                x2={t.x-nx*(r+4)} y2={t.y-ny*(r+4)}
                stroke={cl.color} strokeWidth={0.8} strokeOpacity={0.45}
                strokeDasharray={e.isType ? "3 2" : undefined}
                markerEnd="url(#carr)"
              />
            );
          });
      })}

      {/* Cluster bubbles */}
      {clusters.map((cl) => {
        const p = clusterPos[cl.id]; if (!p) return null;
        const members = nodes.filter(n => n.cluster.id === cl.id);
        const isExpanded = expandedClusters.has(cl.id);
        const r = 32 + Math.min(members.length * 1.4, 18);
        const inDeg = clusterEdges.filter(e=>e.target===cl.id).reduce((s,e)=>s+e.count,0);
        const outDeg = clusterEdges.filter(e=>e.source===cl.id).reduce((s,e)=>s+e.count,0);

        return (
          <g key={cl.id}>
            {/* Expanded member nodes */}
            {isExpanded && members.map(n => {
              const np = nodeLayouts[cl.id]?.[n.id]; if (!np) return null;
              const isSel = n.id === selectedId;
              const isAff = affectedIds.includes(n.id);
              const col = extColor(n.ext);
              return (
                <g key={n.id} transform={`translate(${np.x},${np.y})`}
                  onClick={e => { e.stopPropagation(); onSelectNode(n.id); }}
                  style={{ cursor:"pointer" }}
                  filter={isSel ? "url(#nglow)" : undefined}
                >
                  <circle r={13}
                    fill={isSel ? `${col}1a` : "#0b0d1e"}
                    stroke={isSel ? col : isAff ? col : cl.color}
                    strokeWidth={isSel ? 2 : 0.8}
                    strokeOpacity={isSel ? 1 : isAff ? 0.9 : 0.45}
                  />
                  <text textAnchor="middle" dominantBaseline="middle"
                    fontSize={6} fill={isSel ? "#fff" : "#5a6090"}
                    fontFamily="'JetBrains Mono',monospace"
                    style={{ pointerEvents:"none" }}
                  >{n.label.length > 10 ? n.label.slice(0,9)+"…" : n.label}</text>
                </g>
              );
            })}

            {/* Cluster bubble */}
            <g transform={`translate(${p.x},${p.y})`}
              onClick={() => onToggle(cl.id)}
              style={{ cursor:"pointer" }}
              filter={isExpanded ? "url(#cglow)" : undefined}
            >
              <circle r={r}
                fill={`${cl.color}10`}
                stroke={cl.color}
                strokeWidth={isExpanded ? 1.8 : 1}
                strokeOpacity={isExpanded ? 0.85 : 0.35}
              />
              {/* cluster name */}
              <text textAnchor="middle" y={-10}
                fontSize={8.5} fontWeight={700} fill={cl.color}
                fontFamily="'JetBrains Mono',monospace"
                style={{ pointerEvents:"none" }}
              >{cl.name.split("/").pop()}</text>
              {/* file count */}
              <text textAnchor="middle" y={3}
                fontSize={7} fill={`${cl.color}90`}
                fontFamily="'JetBrains Mono',monospace"
                style={{ pointerEvents:"none" }}
              >{members.length} files</text>
              {/* in/out */}
              <text textAnchor="middle" y={14}
                fontSize={6.5} fill={`${cl.color}60`}
                fontFamily="'JetBrains Mono',monospace"
                style={{ pointerEvents:"none" }}
              >↙{inDeg} ↗{outDeg}</text>
              {/* expand toggle */}
              <text textAnchor="middle" y={r-8}
                fontSize={9} fill={`${cl.color}80`}
                fontFamily="'JetBrains Mono',monospace"
                style={{ pointerEvents:"none" }}
              >{isExpanded ? "▲" : "▼"}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar({ filters, setFilters, stats, clusterNames }) {
  const hasActive = filters.hideOrphans || filters.minScore > 0 || filters.topN < 999 || filters.cluster !== "";
  return (
    <div style={{ display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",padding:"7px 18px",borderBottom:"1px solid #0f1224",background:"#07091a",flexShrink:0,fontSize:9 }}>
      <span style={{ color:"#2a2f4a",letterSpacing:"0.08em",fontWeight:700 }}>FILTRES</span>

      {/* Orphans toggle */}
      <FToggle
        active={filters.hideOrphans}
        onChange={v => setFilters(f => ({...f, hideOrphans:v}))}
        label="Masquer orphelins"
        badge={stats.orphanCount}
        activeColor="#f77c6a"
      />

      {/* Score */}
      <div style={{ display:"flex",alignItems:"center",gap:5 }}>
        <span style={{ color:"#2a2f4a" }}>Score ≥</span>
        <input type="range" min={0} max={65} step={5}
          value={filters.minScore}
          onChange={e => setFilters(f => ({...f, minScore:+e.target.value}))}
          style={{ width:72, accentColor:"#7c6af7" }}
        />
        <span style={{ color:"#7c6af7", minWidth:16 }}>{filters.minScore}</span>
      </div>

      {/* Top N */}
      <div style={{ display:"flex",alignItems:"center",gap:5 }}>
        <span style={{ color:"#2a2f4a" }}>Top</span>
        <select value={filters.topN}
          onChange={e => setFilters(f => ({...f, topN:+e.target.value}))}
          style={{ background:"#0d0f22",border:"1px solid #1a1f38",color:"#c8cde8",borderRadius:4,padding:"2px 5px",fontSize:9,fontFamily:"inherit" }}
        >
          {[999,50,30,20,10].map(n => (
            <option key={n} value={n}>{n===999?"Tous":String(n)}</option>
          ))}
        </select>
        <span style={{ color:"#2a2f4a" }}>nœuds</span>
      </div>

      {/* Cluster */}
      <div style={{ display:"flex",alignItems:"center",gap:5 }}>
        <span style={{ color:"#2a2f4a" }}>Cluster</span>
        <select value={filters.cluster}
          onChange={e => setFilters(f => ({...f, cluster:e.target.value}))}
          style={{ background:"#0d0f22",border:"1px solid #1a1f38",color:"#c8cde8",borderRadius:4,padding:"2px 5px",fontSize:9,fontFamily:"inherit",maxWidth:130 }}
        >
          <option value="">Tous</option>
          {clusterNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {hasActive && (
        <button onClick={() => setFilters({ hideOrphans:false, minScore:0, topN:999, cluster:"" })}
          style={{ background:"none",border:"1px solid #2a2f4a",borderRadius:4,color:"#3a3f5c",padding:"2px 7px",cursor:"pointer",fontSize:9,fontFamily:"inherit" }}
        >reset</button>
      )}

      <div style={{ marginLeft:"auto",color:"#2a2f4a",display:"flex",gap:8 }}>
        <span><span style={{color:"#7c6af7"}}>{stats.visible}</span>/<span style={{color:"#3a4060"}}>{stats.total}</span> nœuds</span>
        <span><span style={{color:"#3ecfcf"}}>{stats.visibleEdges}</span> liens</span>
        {stats.orphanCount > 0 && !filters.hideOrphans && (
          <span style={{color:"#f77c6a66"}}>{stats.orphanCount} orphelins</span>
        )}
      </div>
    </div>
  );
}

function FToggle({ active, onChange, label, badge, activeColor="#7c6af7" }) {
  return (
    <button onClick={() => onChange(!active)} style={{
      background: active ? `${activeColor}1a` : "transparent",
      border:`1px solid ${active ? activeColor : "#1a1f38"}`,
      borderRadius:4, color: active ? activeColor : "#3a3f5c",
      padding:"2px 8px", cursor:"pointer", fontSize:9, fontFamily:"inherit",
      display:"flex", alignItems:"center", gap:4,
    }}>
      {label}
      {badge !== undefined && (
        <span style={{ background:"#0d0f22",borderRadius:3,padding:"0 4px",color:"#3a3f5c",fontSize:8 }}>{badge}</span>
      )}
    </button>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App({ graphUrl }) {
  const [graph, setGraph] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [affectedIds, setAffectedIds] = useState([]);
  const [focusedIds, setFocusedIds] = useState([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("node");
  const [viewMode, setViewMode] = useState("clusters");
  const [expandedClusters, setExpandedClusters] = useState(new Set());
  const [filters, setFilters] = useState({ hideOrphans:false, minScore:0, topN:999, cluster:"" });
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef();
  const hasAutoLoadedRef = useRef(false);

  useEffect(() => { setTimeout(() => setLoaded(true), 80); }, []);

  const loadGraph = useCallback((jsonStr) => {
    try {
      const g = parseGraph(JSON.parse(jsonStr));
      setGraph(g);
      setSelectedId(null); setAffectedIds([]); setFocusedIds([]); setSearch("");
      setFilters({ hideOrphans:false, minScore:0, topN:999, cluster:"" });
      setExpandedClusters(new Set());
    } catch(e) { alert("JSON invalide : "+e.message); }
  }, []);

  // Auto-load graph from API when a URL is provided (used by `spec-gen view`)
  useEffect(() => {
    if (!graphUrl || hasAutoLoadedRef.current) return;
    hasAutoLoadedRef.current = true;
    (async () => {
      try {
        const res = await fetch(graphUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        loadGraph(text);
      } catch (e) {
        // Fall back to manual upload UI; errors are shown in console.
        // eslint-disable-next-line no-console
        console.error("Failed to load graph from", graphUrl, e);
      }
    })();
  }, [graphUrl, loadGraph]);

  const handleFile = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader(); r.onload = ev => loadGraph(ev.target.result); r.readAsText(f);
  };

  // ── Filtered nodes/edges ──────────────────────────────────────────────────
  const { visibleNodes, visibleEdges, filterStats } = useMemo(() => {
    if (!graph) return { visibleNodes:[], visibleEdges:[], filterStats:{} };

    const connectedIds = new Set();
    graph.edges.forEach(e => { connectedIds.add(e.source); connectedIds.add(e.target); });
    const orphanCount = graph.nodes.filter(n => !connectedIds.has(n.id)).length;

    let nodes = filters.cluster
      ? graph.nodes.filter(n => n.cluster.name === filters.cluster)
      : graph.nodes;

    if (filters.hideOrphans) nodes = nodes.filter(n => connectedIds.has(n.id));
    if (filters.minScore > 0) nodes = nodes.filter(n => n.score >= filters.minScore);

    if (filters.topN < 999) {
      const ranked = (graph.rankings.byImportance || graph.nodes.map(n=>n.id));
      const topSet = new Set(ranked.slice(0, filters.topN));
      nodes = nodes.filter(n => topSet.has(n.id));
    }

    const vset = new Set(nodes.map(n=>n.id));
    const edges = graph.edges.filter(e => vset.has(e.source) && vset.has(e.target));

    return {
      visibleNodes: nodes,
      visibleEdges: edges,
      filterStats: { total:graph.nodes.length, visible:nodes.length, visibleEdges:edges.length, orphanCount },
    };
  }, [graph, filters]);

  const handleSearch = q => {
    setSearch(q);
    if (!q.trim()) { setFocusedIds([]); return; }
    const lo = q.toLowerCase();
    setFocusedIds(visibleNodes.filter(n =>
      n.label.toLowerCase().includes(lo) || n.path.toLowerCase().includes(lo) ||
      n.ext.includes(lo) || n.tags.some(t=>t.toLowerCase().includes(lo)) ||
      n.exports.some(ex=>ex.name.toLowerCase().includes(lo))
    ).map(n=>n.id));
  };

  const handleSelect = useCallback((id) => {
    if (selectedId === id) { setSelectedId(null); setAffectedIds([]); return; }
    setSelectedId(id);
    setAffectedIds(computeBlast(visibleEdges, id));
    setTab("node");
  }, [selectedId, visibleEdges]);

  const toggleCluster = useCallback(cid => {
    setExpandedClusters(prev => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  }, []);

  const selectedNode = graph?.nodes.find(n=>n.id===selectedId);
  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return visibleEdges.filter(e => e.source === selectedId || e.target === selectedId);
  }, [selectedId, visibleEdges]);
  const stats = graph?.statistics || {};
  const clusterNames = graph?.clusters.map(c=>c.name) || [];

  // ── Upload screen ─────────────────────────────────────────────────────────
  if (!graph) return (
    <div style={{ width:"100%",height:"100vh",background:"#07091a",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'JetBrains Mono',monospace",color:"#c8cde8",opacity:loaded?1:0,transition:"opacity 0.3s" }}>
      <div style={{ fontSize:10,letterSpacing:"0.18em",color:"#2a2f4a",marginBottom:28 }}>INTERACTIVE GRAPH VIEWER</div>
      <div
        style={{ border:"1px dashed #252a45",borderRadius:12,padding:"44px 64px",textAlign:"center",cursor:"pointer" }}
        onClick={() => fileRef.current.click()}
        onDragOver={e=>e.preventDefault()}
        onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f){const r=new FileReader();r.onload=ev=>loadGraph(ev.target.result);r.readAsText(f);}}}
      >
        <div style={{ fontSize:32,marginBottom:14,color:"#7c6af7" }}>⬡</div>
        <div style={{ fontSize:12,color:"#8890b0",marginBottom:6 }}>
          Glisse un <code style={{color:"#7c6af7"}}>dependency-graph.json</code>
        </div>
        <div style={{ fontSize:10,color:"#3a3f5c" }}>ou clique pour parcourir</div>
      </div>
      <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={handleFile}/>
    </div>
  );

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <div style={{ width:"100%",height:"100vh",background:"#07091a",fontFamily:"'JetBrains Mono',monospace",color:"#c8cde8",display:"flex",flexDirection:"column",opacity:loaded?1:0,transition:"opacity 0.3s" }}>

      {/* Top bar */}
      <div style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 18px",borderBottom:"1px solid #0f1224",background:"#080a1c",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:7 }}>
          <div style={{ width:6,height:6,borderRadius:"50%",background:"#7c6af7",boxShadow:"0 0 8px #7c6af7" }}/>
          <span style={{ fontSize:10,fontWeight:700,color:"#e0e4f0",letterSpacing:"0.09em" }}>GRAPH VIEWER</span>
        </div>
        {[["nodes",stats.nodeCount],["edges",stats.edgeCount],["clusters",stats.clusterCount]].map(([l,v])=>(
          <div key={l} style={{ fontSize:9,color:"#3a4060",background:"#0e1028",borderRadius:4,padding:"2px 7px",border:"1px solid #141830" }}>
            <span style={{color:"#6a70a0"}}>{v}</span> {l}
          </div>
        ))}
        <div style={{ display:"flex",gap:2,marginLeft:8 }}>
          {[["clusters","⬡ clusters"],["flat","⊙ flat"]].map(([v,lbl])=>(
            <button key={v} onClick={()=>setViewMode(v)} style={{ padding:"3px 10px",fontSize:9,background:viewMode===v?"#181b38":"transparent",border:`1px solid ${viewMode===v?"#7c6af7":"#141830"}`,borderRadius:4,color:viewMode===v?"#c8cde8":"#3a3f5c",cursor:"pointer",fontFamily:"inherit" }}>{lbl}</button>
          ))}
        </div>
        <div style={{ marginLeft:"auto",position:"relative" }}>
          <input value={search} onChange={e=>handleSearch(e.target.value)}
            placeholder="search name, path, export, tag…"
            style={{ background:"#0c0e22",border:"1px solid #141830",color:"#c8cde8",padding:"5px 12px 5px 26px",borderRadius:5,fontSize:9,width:230,outline:"none",fontFamily:"inherit" }}/>
          <span style={{ position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",fontSize:11,color:"#3a3f5c" }}>⌕</span>
          {focusedIds.length>0&&<span style={{ position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",fontSize:9,color:"#7c6af7" }}>{focusedIds.length}</span>}
        </div>
        <button onClick={()=>{setGraph(null);setSelectedId(null);}}
          style={{ background:"none",border:"1px solid #1a1f38",borderRadius:4,color:"#3a3f5c",fontSize:8,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit",letterSpacing:"0.06em" }}>LOAD</button>
      </div>

      {/* Filter bar */}
      <FilterBar filters={filters} setFilters={setFilters} stats={filterStats} clusterNames={clusterNames}/>

      {/* Body */}
      <div style={{ flex:1,display:"flex",overflow:"hidden" }}>

        {/* Canvas */}
        <div style={{ flex:1,position:"relative",overflow:"hidden" }}>
          {viewMode==="clusters" ? (
            <ClusterGraph
              clusters={graph.clusters.filter(cl => !filters.cluster || cl.name===filters.cluster)}
              edges={visibleEdges}
              nodes={visibleNodes}
              expandedClusters={expandedClusters}
              onToggle={toggleCluster}
              onSelectNode={handleSelect}
              selectedId={selectedId}
              affectedIds={affectedIds}
            />
          ) : (
            <FlatGraph
              nodes={visibleNodes}
              edges={visibleEdges}
              selectedId={selectedId}
              affectedIds={affectedIds}
              focusedIds={focusedIds}
              onSelect={handleSelect}
            />
          )}
          {!selectedId && (
            <div style={{ position:"absolute",bottom:12,left:"50%",transform:"translateX(-50%)",fontSize:9,color:"#181c38",letterSpacing:"0.1em",pointerEvents:"none",whiteSpace:"nowrap" }}>
              {viewMode==="clusters" ? "CLIC CLUSTER → EXPAND  ·  CLIC NŒUD → INSPECTER" : "CLIC NŒUD → INSPECTER"}
            </div>
          )}
        </div>

        {/* Side panel */}
        <div style={{ width:282,borderLeft:"1px solid #0f1224",background:"#080b1e",display:"flex",flexDirection:"column",overflow:"hidden",flexShrink:0 }}>
          <div style={{ display:"flex",borderBottom:"1px solid #0f1224",flexShrink:0 }}>
            {["node","links","blast","info"].map(t=>(
              <button key={t} onClick={()=>setTab(t)} style={{ flex:1,padding:"7px 0",background:"none",border:"none",borderBottom:tab===t?"2px solid #7c6af7":"2px solid transparent",color:tab===t?"#c8cde8":"#3a3f5c",fontSize:8,letterSpacing:"0.06em",fontWeight:700,cursor:"pointer",fontFamily:"inherit",textTransform:"uppercase" }}>{t}</button>
            ))}
          </div>

          <div style={{ flex:1,overflow:"auto",padding:13 }}>

            {/* NODE */}
            {tab==="node"&&!selectedNode&&<Hint>Sélectionne un nœud pour l'inspecter.</Hint>}
            {tab==="node"&&selectedNode&&(
              <div>
                <div style={{ fontSize:12,fontWeight:700,color:"#e0e4f0",marginBottom:2 }}>{selectedNode.label}</div>
                <div style={{ fontSize:8,color:"#3a3f5c",marginBottom:9,wordBreak:"break-all",lineHeight:1.7 }}>{selectedNode.path}</div>
                <Row label="ext" value={<Chip color={extColor(selectedNode.ext)}>{selectedNode.ext||"—"}</Chip>}/>
                <Row label="lignes" value={selectedNode.lines}/>
                <Row label="taille" value={`${(selectedNode.size/1024).toFixed(1)} KB`}/>
                <Row label="score" value={<span style={{color:"#7c6af7",fontWeight:700}}>{selectedNode.score}</span>}/>
                <Row label="cluster" value={<Chip color={selectedNode.cluster.color}>{selectedNode.cluster.name}</Chip>}/>
                <div style={{ display:"flex",gap:4,marginTop:8,flexWrap:"wrap" }}>
                  {selectedNode.isEntry&&<Chip color="#f77c6a">entry-point</Chip>}
                  {selectedNode.isConfig&&<Chip color="#f5c518">config</Chip>}
                  {selectedNode.isTest&&<Chip color="#3ecfcf">test</Chip>}
                  {selectedNode.tags.map(t=><Chip key={t} color="#4a5070">{t}</Chip>)}
                </div>
                {selectedNode.exports.length>0&&(
                  <>
                    <SL>Exports ({selectedNode.exports.length})</SL>
                    {selectedNode.exports.map((ex,i)=>(
                      <div key={i} style={{ display:"flex",gap:5,alignItems:"center",padding:"3px 0",borderBottom:"1px solid #0f1228" }}>
                        <KindBadge kind={ex.kind}/>
                        <span style={{fontSize:9,color:"#8890b0"}}>{ex.name}</span>
                        <span style={{marginLeft:"auto",fontSize:8,color:"#2a2f4a"}}>L{ex.line}</span>
                      </div>
                    ))}
                  </>
                )}
                <SL>Métriques</SL>
                {[["inDegree","↙"],["outDegree","↗"],["pageRank","PR"],["betweenness","⋈"]].map(([k,s])=>(
                  <Row key={k} label={`${s} ${k}`} value={typeof selectedNode.metrics[k]==="number"?selectedNode.metrics[k].toFixed(3):"-"}/>
                ))}
              </div>
            )}

            {/* LINKS */}
            {tab==="links"&&!selectedId&&<Hint>Sélectionne un nœud pour voir ses imports/exports directs.</Hint>}
            {tab==="links"&&selectedId&&(
              <div>
                {/* imports (edges where this node is source) */}
                {(() => {
                  const outEdges = selectedEdges.filter(e=>e.source===selectedId);
                  const inEdges  = selectedEdges.filter(e=>e.target===selectedId);
                  return (
                    <>
                      <SL>Importe ({outEdges.length})</SL>
                      {outEdges.length===0&&<div style={{color:"#2a2f4a",fontSize:9}}>Aucun import.</div>}
                      {outEdges.map((e,i)=>{
                        const tn = graph.nodes.find(n=>n.id===e.target);
                        return (
                          <div key={i} onClick={()=>handleSelect(e.target)}
                            style={{ padding:"5px 7px",marginBottom:3,background:"#0c0e20",borderRadius:4,border:`1px solid ${tn?.cluster.color||"#141830"}22`,cursor:"pointer" }}>
                            <div style={{ display:"flex",alignItems:"center",gap:5,marginBottom:e.importedNames.length?3:0 }}>
                              <span style={{fontSize:8,color:extColor(tn?.ext||"")}}>↗</span>
                              <span style={{fontSize:9,color:"#c8cde8"}}>{tn?.label||e.target}</span>
                              {e.isType&&<span style={{fontSize:7,color:"#3a3f6a",marginLeft:"auto"}}>type</span>}
                            </div>
                            {e.importedNames.length>0&&(
                              <div style={{ fontSize:7.5,color:"#3a4060",paddingLeft:12 }}>
                                {e.importedNames.join(", ")}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <SL>Importé par ({inEdges.length})</SL>
                      {inEdges.length===0&&<div style={{color:"#2a2f4a",fontSize:9}}>Pas importé par d'autres fichiers visibles.</div>}
                      {inEdges.map((e,i)=>{
                        const sn = graph.nodes.find(n=>n.id===e.source);
                        return (
                          <div key={i} onClick={()=>handleSelect(e.source)}
                            style={{ padding:"5px 7px",marginBottom:3,background:"#0c0e20",borderRadius:4,border:`1px solid ${sn?.cluster.color||"#141830"}22`,cursor:"pointer" }}>
                            <div style={{ display:"flex",alignItems:"center",gap:5,marginBottom:e.importedNames.length?3:0 }}>
                              <span style={{fontSize:8,color:"#7c6af7"}}>↙</span>
                              <span style={{fontSize:9,color:"#c8cde8"}}>{sn?.label||e.source}</span>
                              {e.isType&&<span style={{fontSize:7,color:"#3a3f6a",marginLeft:"auto"}}>type</span>}
                            </div>
                            {e.importedNames.length>0&&(
                              <div style={{ fontSize:7.5,color:"#3a4060",paddingLeft:12 }}>
                                {e.importedNames.join(", ")}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            )}

            {/* BLAST */}
            {tab==="blast"&&!selectedId&&<Hint>Sélectionne un nœud pour calculer l'impact downstream.</Hint>}
            {tab==="blast"&&selectedId&&(
              <div>
                <div style={{ fontSize:9,color:"#8890b0",marginBottom:10 }}>
                  Modifier <span style={{color:"#7c6af7"}}>{selectedNode?.label}</span> impacte :
                </div>
                {affectedIds.length===0
                  ?<div style={{color:"#2a2f4a",fontSize:9}}>Aucun nœud downstream visible.</div>
                  :affectedIds.map(id=>{
                    const n=graph.nodes.find(x=>x.id===id);
                    return (
                      <div key={id} onClick={()=>handleSelect(id)}
                        style={{ display:"flex",alignItems:"center",gap:6,padding:"4px 7px",marginBottom:3,background:"#0c0e20",borderRadius:4,border:"1px solid #141830",cursor:"pointer" }}>
                        <span style={{fontSize:8,color:extColor(n?.ext||"")}}>{n?.ext||"?"}</span>
                        <span style={{fontSize:9,color:"#c8cde8",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n?.label||id}</span>
                        <span style={{fontSize:7,color:`${n?.cluster.color||"#3a3f5c"}80`}}>{n?.cluster.name.split("/").pop()}</span>
                      </div>
                    );
                  })
                }
                <div style={{ marginTop:10,padding:"8px 10px",background:"#0c0e20",borderRadius:5,border:"1px solid #1a1f38" }}>
                  <div style={{fontSize:8,color:"#3a3f5c",marginBottom:2}}>BLAST RADIUS</div>
                  <div style={{fontSize:22,fontWeight:700,color:affectedIds.length>8?"#f77c6a":affectedIds.length>3?"#f7c76a":"#7c6af7"}}>
                    {affectedIds.length} <span style={{fontSize:10,fontWeight:400,color:"#3a3f5c"}}>nœuds</span>
                  </div>
                </div>
              </div>
            )}

            {/* INFO */}
            {tab==="info"&&(
              <div>
                <SL>Statistiques</SL>
                {[["Nodes",stats.nodeCount],["Edges",stats.edgeCount],["Clusters",stats.clusterCount],["Cycles",stats.cycleCount],["Avg degree",stats.avgDegree?.toFixed(2)],["Density",stats.density?.toFixed(4)]].map(([l,v])=>(
                  <Row key={l} label={l} value={v??"-"}/>
                ))}
                <SL>Filtres actifs</SL>
                <Row label="Nœuds visibles" value={<span style={{color:"#7c6af7"}}>{filterStats.visible}</span>}/>
                <Row label="Liens visibles" value={<span style={{color:"#3ecfcf"}}>{filterStats.visibleEdges}</span>}/>
                <Row label="Orphelins" value={filterStats.orphanCount}/>
                <SL>Top 10 par score</SL>
                {(graph.rankings.byImportance||[]).slice(0,10).map((fid,i)=>{
                  const n=graph.nodes.find(x=>x.id===fid); if(!n) return null;
                  return (
                    <div key={fid} onClick={()=>handleSelect(fid)}
                      style={{ display:"flex",gap:5,alignItems:"center",padding:"3px 0",cursor:"pointer" }}>
                      <span style={{fontSize:8,color:"#2a2f4a",minWidth:12}}>{i+1}</span>
                      <span style={{fontSize:8,color:extColor(n.ext)}}>{n.ext||"—"}</span>
                      <span style={{fontSize:9,color:"#8890b0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.label}</span>
                      <span style={{fontSize:9,color:"#7c6af7"}}>{n.score}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cluster legend — clickable to filter */}
          <div style={{ padding:"9px 13px",borderTop:"1px solid #0f1224",flexShrink:0 }}>
            <div style={{ fontSize:8,color:"#1e2240",letterSpacing:"0.08em",marginBottom:5 }}>CLUSTERS · clic pour filtrer</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
              {graph.clusters.map(cl=>(
                <div key={cl.id}
                  onClick={()=>setFilters(f=>({...f,cluster:f.cluster===cl.name?"":cl.name}))}
                  style={{ display:"flex",alignItems:"center",gap:3,cursor:"pointer",opacity:filters.cluster&&filters.cluster!==cl.name?0.25:1,transition:"opacity 0.15s" }}>
                  <div style={{ width:5,height:5,borderRadius:"50%",background:cl.color,boxShadow:filters.cluster===cl.name?`0 0 5px ${cl.color}`:"none" }}/>
                  <span style={{ fontSize:7.5,color:filters.cluster===cl.name?cl.color:"#3a3f5c" }}>{cl.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Micro-components ─────────────────────────────────────────────────────────
function Hint({children}){return <div style={{fontSize:10,color:"#2a2f4a",lineHeight:1.8,marginTop:4}}>{children}</div>;}
function SL({children}){return <div style={{fontSize:8,color:"#3a3f5c",letterSpacing:"0.08em",marginTop:12,marginBottom:5,textTransform:"uppercase"}}>{children}</div>;}
function Row({label,value}){return(
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0",borderBottom:"1px solid #0e1025"}}>
    <span style={{fontSize:9,color:"#3a4070"}}>{label}</span>
    <span style={{fontSize:9,color:"#8890b0"}}>{value}</span>
  </div>
);}
function Chip({color,children}){return(
  <span style={{fontSize:8,padding:"2px 6px",borderRadius:3,background:`${color}1a`,border:`1px solid ${color}45`,color,letterSpacing:"0.02em"}}>{children}</span>
);}
function KindBadge({kind}){
  const map={class:["#a78bfa","#1a1060"],function:["#4ecdc4","#00301a"],interface:["#60a5fa","#001a30"],type:["#f472b6","#2a0a20"],enum:["#f5c518","#2a1a00"]};
  const [c,bg]=map[kind]||["#64748b","#1a1a2a"];
  return <span style={{fontSize:7,padding:"1px 5px",borderRadius:3,background:bg,color:c,minWidth:44,textAlign:"center"}}>{kind||"—"}</span>;
}
