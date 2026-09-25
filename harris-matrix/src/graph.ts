import { DirectedGraph } from 'graphology'

/** 有向先后关系的最小抽象：from 早于 to */
export interface OrderEdge {
  id: string
  from: string
  to: string
}

/** 由活跃“早于”关系构建有向图（同期关联绝不进入此图） */
export function buildGraph(edges: OrderEdge[]): DirectedGraph {
  const g = new DirectedGraph()
  for (const e of edges) {
    if (!g.hasNode(e.from)) g.addNode(e.from)
    if (!g.hasNode(e.to)) g.addNode(e.to)
    if (!g.hasDirectedEdge(e.from, e.to)) g.addDirectedEdge(e.from, e.to)
  }
  return g
}

/** BFS 求 source → target 的一条有向路径，不存在返回 null */
export function findPath(g: DirectedGraph, source: string, target: string): string[] | null {
  if (!g.hasNode(source) || !g.hasNode(target)) return null
  if (source === target) return [source]
  const prev = new Map<string, string>()
  const seen = new Set<string>([source])
  const queue: string[] = [source]
  while (queue.length > 0) {
    const cur = queue.shift()!
    let hit = false
    g.forEachOutboundNeighbor(cur, (nb) => {
      if (hit || seen.has(nb)) return
      seen.add(nb)
      prev.set(nb, cur)
      if (nb === target) {
        hit = true
      } else {
        queue.push(nb)
      }
    })
    if (hit) {
      const path = [target]
      let p = prev.get(target)!
      while (p !== source) {
        path.unshift(p)
        p = prev.get(p)!
      }
      path.unshift(source)
      return path
    }
  }
  return null
}

/**
 * 成环检测：新增 from→to 会成环，当且仅当图中已存在 to→…→from 的路径。
 * 返回完整环路径（节点序列，如 [from, to, x, from] 的展开形式），用于向记录员定位矛盾。
 */
export function cyclePathIfAdded(edges: OrderEdge[], from: string, to: string): string[] | null {
  if (from === to) return [from, from]
  const g = buildGraph(edges)
  const back = findPath(g, to, from)
  if (!back) return null
  // back = [to, …, from]；新边 from→to 闭合为环
  return [from, ...back]
}

/**
 * 传递约简：若去掉某条边后其终点仍可从起点到达，则该边为传递冗余边。
 * 仅用于“简化视图”的隐藏，绝不删除原始记录。
 * 返回冗余关系的 id 集合。
 */
export function redundantEdges(edges: OrderEdge[]): Set<string> {
  const redundant = new Set<string>()
  const g = buildGraph(edges)
  // 同一 (from,to) 上可能叠有多条记录，按图边逐对检测
  const pairIds = new Map<string, string[]>()
  for (const e of edges) {
    const key = `${e.from}→${e.to}`
    const list = pairIds.get(key) ?? []
    list.push(e.id)
    pairIds.set(key, list)
  }
  for (const [key, ids] of pairIds) {
    const [from, to] = key.split('→')
    if (!g.hasDirectedEdge(from, to)) continue
    g.dropDirectedEdge(from, to)
    const stillReachable = findPath(g, from, to) !== null
    if (stillReachable) ids.forEach((id) => redundant.add(id))
    g.addDirectedEdge(from, to)
  }
  return redundant
}

/** 偏序闭包：全部可达对 "a→b"（排序后），用于导出/导入的一致性校验 */
export function reachablePairs(edges: OrderEdge[]): string[] {
  const g = buildGraph(edges)
  const pairs: string[] = []
  g.forEachNode((source) => {
    const seen = new Set<string>([source])
    const queue: string[] = [source]
    while (queue.length > 0) {
      const cur = queue.shift()!
      g.forEachOutboundNeighbor(cur, (nb) => {
        if (seen.has(nb)) return
        seen.add(nb)
        pairs.push(`${source}→${nb}`)
        queue.push(nb)
      })
    }
  })
  return pairs.sort()
}

/**
 * 分层排布：忽略会成环的边得到 DAG 骨架，按最长路径分层（越早越低），
 * 同层横向展开。返回 unitId → 画布坐标。
 */
export function layeredPositions(
  nodeIds: string[],
  edges: OrderEdge[],
): Map<string, { x: number; y: number }> {
  const skeleton: OrderEdge[] = []
  for (const e of edges) {
    if (!cyclePathIfAdded(skeleton, e.from, e.to)) skeleton.push(e)
  }
  const g = buildGraph(skeleton)
  for (const id of nodeIds) if (!g.hasNode(id)) g.addNode(id)

  // Kahn 拓扑 + 最长路径定层
  const indeg = new Map<string, number>()
  const rank = new Map<string, number>()
  g.forEachNode((n) => {
    indeg.set(n, g.inDegree(n))
    rank.set(n, 0)
  })
  const queue = nodeIds.filter((n) => (indeg.get(n) ?? 0) === 0)
  while (queue.length > 0) {
    const cur = queue.shift()!
    const r = rank.get(cur)!
    g.forEachOutboundNeighbor(cur, (nb) => {
      if (r + 1 > rank.get(nb)!) rank.set(nb, r + 1)
      const d = indeg.get(nb)! - 1
      indeg.set(nb, d)
      if (d === 0) queue.push(nb)
    })
  }

  const byRank = new Map<number, string[]>()
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0
    const list = byRank.get(r) ?? []
    list.push(id)
    byRank.set(r, list)
  }
  const out = new Map<string, { x: number; y: number }>()
  for (const [r, ids] of byRank) {
    ids.forEach((id, i) => {
      out.set(id, {
        x: (i - (ids.length - 1) / 2) * 190,
        // 画布 y 轴向下：越早（rank 小）越靠下
        y: -r * 130,
      })
    })
  }
  return out
}
