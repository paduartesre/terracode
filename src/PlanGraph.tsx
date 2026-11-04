import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { layoutGraph, NODE_H, LABEL_MAX_CHARS } from './graphLayout'
import type { TfGraphNode } from './api'

function truncate(s: string): string {
  return s.length > LABEL_MAX_CHARS + 2 ? `${s.slice(0, LABEL_MAX_CHARS - 1)}…` : s
}

type PlanGraphProps = {
  nodes: TfGraphNode[]
  edges: [string, string][]
}

// Interactive dependency graph (like `terraform graph`): layered top-down,
// drag to pan, scroll to zoom, click a node for its details. Dependency-free —
// plain SVG with a hand-rolled layout so the bundle stays small.
const PlanGraph = ({ nodes, edges }: PlanGraphProps): ReactElement => {
  const layout = useMemo(() => layoutGraph(nodes, edges), [nodes, edges])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [view, setView] = useState({ x: 16, y: 12, scale: 1 })
  const [selected, setSelected] = useState<string | null>(null)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null)

  // Wheel zoom must be non-passive to preventDefault (React root listeners are
  // passive), so attach a native listener.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView(v => {
        const scale = Math.min(3, Math.max(0.25, v.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
        if (scale === v.scale) return v
        const k = scale / v.scale
        return { x: mx - (mx - v.x) * k, y: my - (my - v.y) * k, scale }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const degrees = useMemo(() => {
    const inD = new Map<string, number>()
    const outD = new Map<string, number>()
    for (const [a, b] of edges) {
      outD.set(a, (outD.get(a) ?? 0) + 1)
      inD.set(b, (inD.get(b) ?? 0) + 1)
    }
    return { in: inD, out: outD }
  }, [edges])

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    dragRef.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y, moved: false }
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    d.moved = true
    setView(v => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  if (nodes.length === 0) {
    return <p className="tf-status">No graph data — the configuration may be empty or terraform could not build a graph.</p>
  }

  const selectedNode = selected !== null ? nodes.find(n => n.id === selected) : undefined

  return (
    <div className="tf-graph">
      <svg
        ref={svgRef}
        className="tf-graph-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="img"
        aria-label="Terraform resource dependency graph"
      >
        <defs>
          <marker id="tf-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text)" />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map(([a, b], i) => {
            const pa = layout.positions.get(a)
            const pb = layout.positions.get(b)
            if (!pa || !pb) return null
            let d: string
            if (pb.y > pa.y + NODE_H) {
              // Downward edge: bottom-center of a to top-center of b.
              const x1 = pa.x + pa.w / 2
              const y1 = pa.y + NODE_H
              const x2 = pb.x + pb.w / 2
              const y2 = pb.y - 3
              d = `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
            } else {
              // Same-layer or upward edge (cycles): center to center.
              d = `M ${pa.x + pa.w / 2} ${pa.y + NODE_H / 2} L ${pb.x + pb.w / 2} ${pb.y + NODE_H / 2}`
            }
            return <path key={i} d={d} className="tf-graph-edge" markerEnd="url(#tf-graph-arrow)" fill="none" />
          })}
          {nodes.map(n => {
            const p = layout.positions.get(n.id)
            if (!p) return null
            const label = n.label && n.label.trim() !== '' ? n.label : n.id
            const isSel = selected === n.id
            return (
              <g key={n.id} className={`tf-graph-node${isSel ? ' selected' : ''}`} onClick={() => setSelected(isSel ? null : n.id)}>
                <rect x={p.x} y={p.y} width={p.w} height={NODE_H} rx={5} />
                <text x={p.x + p.w / 2} y={p.y + NODE_H / 2 + 4}>
                  {truncate(label)}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="tf-graph-footer">
        <span className="tf-graph-hint">drag to pan · scroll to zoom</span>
        <button onClick={() => setView({ x: 16, y: 12, scale: 1 })}>Reset view</button>
        {selectedNode !== undefined && (
          <span className="tf-graph-detail" title={selectedNode.id}>
            <code>{truncate(selectedNode.label ?? selectedNode.id)}</code> — depends on{' '}
            {(degrees.out.get(selectedNode.id) ?? 0)} node(s), depended upon by {(degrees.in.get(selectedNode.id) ?? 0)}
          </span>
        )}
      </div>
    </div>
  )
}

export default PlanGraph
