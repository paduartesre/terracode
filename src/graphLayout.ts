import type { TfGraphNode } from './api'

export const NODE_H = 28
const GAP_X = 40
const GAP_Y = 64
const MIN_W = 90
const MAX_W = 260
export const LABEL_MAX_CHARS = 34

function nodeWidth(label: string): number {
  const chars = Math.min(label.length, LABEL_MAX_CHARS)
  return Math.max(MIN_W, Math.min(MAX_W, 18 + chars * 7))
}

export type GraphLayout = {
  positions: Map<string, { x: number; y: number; w: number }>
  width: number
  height: number
}

// Layered layout (longest path from any source node). Cycles are handled by
// bounding the relaxation passes at nodes.length — every node still gets a
// layer, so rendering never loops. Within a layer, nodes keep their input
// order (terraform emits the configuration root first).
export function layoutGraph(nodes: TfGraphNode[], edges: [string, string][]): GraphLayout {
  const ids = new Set<string>()
  const labelOf = new Map<string, string>()
  for (const n of nodes) {
    if (!ids.has(n.id)) {
      ids.add(n.id)
      labelOf.set(n.id, n.label && n.label.trim() !== '' ? n.label : n.id)
    }
  }

  const inDeg = new Map<string, number>()
  for (const id of ids) inDeg.set(id, 0)
  for (const [a, b] of edges) {
    if (!ids.has(a) || !ids.has(b)) continue
    inDeg.set(b, (inDeg.get(b) ?? 0) + 1)
  }

  const layer = new Map<string, number>()
  for (const id of ids) if ((inDeg.get(id) ?? 0) === 0) layer.set(id, 0)
  let changed = true
  for (let pass = 0; pass < nodes.length && changed; pass++) {
    changed = false
    for (const [a, b] of edges) {
      if (!ids.has(a) || !ids.has(b)) continue
      const la = layer.get(a)
      if (la === undefined) continue
      const want = la + 1
      if ((layer.get(b) ?? -1) < want) {
        layer.set(b, want)
        changed = true
      }
    }
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0)

  const layers: string[][] = []
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0
    ;(layers[l] ??= []).push(n.id)
  }

  const positions = new Map<string, { x: number; y: number; w: number }>()
  let width = 0
  layers.forEach((idsInLayer, li) => {
    let x = 0
    for (const id of idsInLayer) {
      const label = labelOf.get(id) ?? id
      const w = nodeWidth(label)
      positions.set(id, { x, y: li * (NODE_H + GAP_Y), w })
      x += w + GAP_X
    }
    width = Math.max(width, x - GAP_X)
  })
  const height = layers.length > 0 ? (layers.length - 1) * (NODE_H + GAP_Y) + NODE_H : 0
  return { positions, width: Math.max(width, MIN_W), height }
}
