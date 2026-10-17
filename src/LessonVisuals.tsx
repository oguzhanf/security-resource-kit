import { useId } from 'react';
import type { LessonVisual, MemberCatalog } from '../shared/content-types';

function lines(value: string, width: number): string[] {
  const result: string[] = [];
  for (const word of value.split(/\s+/u)) {
    const last = result.at(-1);
    if (last && last.length + word.length < width) result[result.length - 1] = `${last} ${word}`;
    else result.push(word);
  }
  return result;
}

function Diagram({ visual }: { visual: Extract<LessonVisual, { kind: 'diagram' }> }) {
  const marker = useId().replace(/:/gu, '');
  const height = (Math.max(...visual.nodes.map((node) => node.row)) + 1) * 150 + 20;
  const position = (node: typeof visual.nodes[number]) => ({ x: node.column * 270 + 15, y: node.row * 150 + 15 });
  return <svg className="teaching-diagram" viewBox={`0 0 810 ${height}`} role="img" aria-label={visual.title}>
    <title>{visual.title}</title>
    <desc>{visual.nodes.map((node) => `${node.label}: ${node.detail}`).join('. ')}. {visual.edges.map((edge) =>
      `${visual.nodes.find((node) => node.id === edge.from)?.label} → ${visual.nodes.find((node) => node.id === edge.to)?.label}: ${edge.label}`).join('. ')}</desc>
    <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#315998" /></marker></defs>
    {visual.edges.map((edge, index) => {
      const from = visual.nodes.find((node) => node.id === edge.from);
      const to = visual.nodes.find((node) => node.id === edge.to);
      if (!from || !to) throw new Error('Diagram edge has no node.');
      const a = position(from);
      const b = position(to);
      const horizontal = from.row === to.row;
      const forward = to.column > from.column;
      const down = to.row > from.row;
      const x1 = horizontal ? a.x + (forward ? 240 : 0) : a.x + 120;
      const x2 = horizontal ? b.x + (forward ? 0 : 240) : b.x + 120;
      const y1 = horizontal ? a.y + 50 : a.y + (down ? 100 : 0);
      const y2 = horizontal ? b.y + 50 : b.y + (down ? 0 : 100);
      return <g key={index}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#315998" strokeWidth="2" markerEnd={`url(#${marker})`} />
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} textAnchor="middle" className="diagram-edge-label">{edge.label}</text></g>;
    })}
    {visual.nodes.map((node) => {
      const { x, y } = position(node);
      return <g key={node.id}><rect x={x} y={y} width="240" height="100" fill="#f0f3f7" stroke="#687b9f" />
        <text x={x + 12} y={y + 24} className="diagram-node-label">{lines(node.label, 28).map((line, index) =>
          <tspan key={index} x={x + 12} dy={index ? 17 : 0}>{line}</tspan>)}</text>
        <text x={x + 12} y={y + 65} className="diagram-node-detail">{lines(node.detail, 32).map((line, index) =>
          <tspan key={index} x={x + 12} dy={index ? 15 : 0}>{line}</tspan>)}</text>
      </g>;
    })}
  </svg>;
}

export function LessonVisuals({ visuals, catalog }: { visuals: readonly LessonVisual[]; catalog: MemberCatalog }) {
  return <>{visuals.map((visual) => {
    const source = catalog.sources.find((item) => item.id === visual.sourceId);
    if (!source) throw new Error('Visual primary reference is missing.');
    return <figure className="lesson-visual" key={visual.id}>
      <p className="visual-title"><strong>{visual.title}</strong></p>
      {visual.kind === 'diagram' ? <Diagram visual={visual} />
        : <a href={visual.src} target="_blank" rel="noopener noreferrer" aria-label={`Enlarge: ${visual.title}`}>
          <img src={visual.src} alt={visual.alt} loading="lazy" decoding="async" />
        </a>}
      <figcaption>{visual.caption} <a href={source.url} target="_blank" rel="noopener noreferrer">Primary reference</a>
        {visual.kind === 'screenshot' && <span className="visual-provenance"> Product screenshot / {visual.provenance === 'tenant-redacted'
          ? 'lab capture, identifiers removed' : 'Microsoft documentation, identifiers removed'} / reviewed {visual.capturedAt}. Portal layout may differ.</span>}
      </figcaption>
    </figure>;
  })}</>;
}
