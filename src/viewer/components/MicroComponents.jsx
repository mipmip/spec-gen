export function Hint({ children }) {
  return (
    <div style={{ fontSize: 10, color: 'var(--tx-faint)', lineHeight: 1.8, marginTop: 4 }}>{children}</div>
  );
}

export function SL({ children }) {
  return (
    <div
      style={{
        fontSize: 8,
        color: 'var(--tx-ghost)',
        letterSpacing: '0.08em',
        marginTop: 12,
        marginBottom: 5,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

export function Row({ label, value }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '3px 0',
        borderBottom: '1px solid var(--bd-dim)',
      }}
    >
      <span style={{ fontSize: 9, color: 'var(--tx-dim)' }}>{label}</span>
      <span style={{ fontSize: 9, color: 'var(--tx-secondary)' }}>{value}</span>
    </div>
  );
}

export function Chip({ color, children }) {
  return (
    <span
      style={{
        fontSize: 8,
        padding: '2px 6px',
        borderRadius: 3,
        background: `${color}1a`,
        border: `1px solid ${color}45`,
        color,
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </span>
  );
}

export function KindBadge({ kind }) {
  const map = {
    class:     '#a78bfa',
    function:  '#4ecdc4',
    interface: '#60a5fa',
    type:      '#f472b6',
    enum:      '#f5c518',
    const:     '#fb923c',
  };
  const c = map[kind] || '#64748b';
  return (
    <span
      style={{
        fontSize: 7,
        padding: '1px 5px',
        borderRadius: 3,
        background: `${c}18`,
        border: `1px solid ${c}45`,
        color: c,
        minWidth: 44,
        textAlign: 'center',
      }}
    >
      {kind || '--'}
    </span>
  );
}
