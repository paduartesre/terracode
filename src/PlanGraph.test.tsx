import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import PlanGraph from './PlanGraph'
import { layoutGraph } from './graphLayout'
import type { TfGraphNode } from './api'

describe('layoutGraph', () => {
  it('places sources at layer 0 and dependents below them', () => {
    const nodes: TfGraphNode[] = [
      { id: '[root]' },
      { id: 'aws_instance.web' },
      { id: 'provider["registry.terraform.io/hashicorp/aws"]' }
    ]
    const edges: [string, string][] = [
      ['[root]', 'aws_instance.web'],
      ['aws_instance.web', 'provider["registry.terraform.io/hashicorp/aws"]']
    ]
    const layout = layoutGraph(nodes, edges)
    expect(layout.positions.get('[root]')?.y).toBe(0)
    expect(layout.positions.get('aws_instance.web')?.y).toBe(92)
    expect(layout.positions.get('provider["registry.terraform.io/hashicorp/aws"]')?.y).toBe(184)
    expect(layout.height).toBe(212)
  })

  it('keeps independent sources on the same layer, side by side', () => {
    const nodes: TfGraphNode[] = [{ id: 'a' }, { id: 'b' }]
    const layout = layoutGraph(nodes, [])
    const pa = layout.positions.get('a')!
    const pb = layout.positions.get('b')!
    expect(pa.y).toBe(0)
    expect(pb.y).toBe(0)
    expect(pb.x).toBeGreaterThanOrEqual(pa.w + 40)
  })

  it('terminates on cycles and still positions every node', () => {
    const nodes: TfGraphNode[] = [{ id: 'a' }, { id: 'b' }]
    const layout = layoutGraph(nodes, [
      ['a', 'b'],
      ['b', 'a']
    ])
    expect(layout.positions.size).toBe(2)
    expect(layout.height).toBe(28)
  })

  it('returns an empty layout for no nodes', () => {
    const layout = layoutGraph([], [])
    expect(layout.positions.size).toBe(0)
    expect(layout.width).toBe(90)
    expect(layout.height).toBe(0)
  })

  it('ignores edges referencing unknown ids and clamps node widths', () => {
    const longId = 'x'.repeat(80)
    const nodes: TfGraphNode[] = [{ id: 'a' }, { id: longId }]
    const layout = layoutGraph(nodes, [
      ['ghost', 'a'],
      ['a', 'phantom']
    ])
    expect(layout.positions.size).toBe(2)
    // Short label -> minimum width; 34-char cap -> 18 + 34*7 = 256.
    expect(layout.positions.get('a')!.w).toBe(90)
    expect(layout.positions.get(longId)!.w).toBe(256)
  })
})

describe('<PlanGraph />', () => {
  it('renders one node group per node and edges as paths', () => {
    const nodes: TfGraphNode[] = [{ id: 'a' }, { id: 'b' }]
    const { container } = render(
      <PlanGraph
        nodes={nodes}
        edges={[
          ['a', 'b']
        ]}
      />
    )
    expect(container.querySelectorAll('.tf-graph-node').length).toBe(2)
    expect(container.querySelectorAll('.tf-graph-edge').length).toBe(1)
  })

  it('shows an empty-state message when there are no nodes', () => {
    render(<PlanGraph nodes={[]} edges={[]} />)
    expect(screen.getByText(/No graph data/)).toBeTruthy()
  })
})
