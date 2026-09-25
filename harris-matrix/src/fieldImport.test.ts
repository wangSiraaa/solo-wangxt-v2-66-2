import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './db'
import { reachablePairs } from './graph'
import {
  confirmFieldImport,
  fieldBatchCanUndo,
  openFieldConflicts,
  openFieldImport,
  orderEdges,
  refresh,
  resolveFieldConflict,
  state,
  undo,
  undoFieldBatch,
} from './store'
import type { FieldBatchFile, StratUnit } from './types'

function fieldFile(
  sourceId: string,
  records: FieldBatchFile['records'],
  sourceName = sourceId,
): { text: string; name: string } {
  const data: FieldBatchFile = {
    app: 'harris-matrix-field-batch',
    version: 1,
    sourceId,
    sourceName,
    records,
  }
  return { text: JSON.stringify(data), name: `${sourceId}.json` }
}

function record(
  key: string,
  collectedAt: string,
  from: string,
  to: string,
  kind: 'earlier' | 'contemporary' = 'earlier',
  note = '',
): FieldBatchFile['records'][number] {
  return { key, collectedAt, relation: { from, to, kind, source: 'observation', note, evidenceRefs: [] } }
}

async function makeUnits(labels: string[]) {
  const now = Date.now()
  const units: StratUnit[] = labels.map((label, i) => ({
    id: label,
    label,
    type: 'deposit' as const,
    note: '',
    createdAt: now + i,
  }))
  await db.units.bulkPut(units)
  await refresh()
}

function asFile(file: { text: string; name: string }): File {
  return new File([file.text], file.name, { type: 'application/json' })
}

async function preview(file: ReturnType<typeof fieldFile>) {
  await openFieldImport(asFile(file))
  const p = state.fieldImport?.preview
  if (!p) throw new Error('preview missing')
  return p
}

async function confirm(file: ReturnType<typeof fieldFile>) {
  await openFieldImport(asFile(file))
  if (!state.fieldImport) throw new Error(`preview missing: ${state.toast}`)
  await confirmFieldImport({ records: {}, conflicts: {} })
  await refresh()
}

async function statusCounts() {
  const counts = new Map<string, number>()
  for (const r of state.relations) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return counts
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await refresh()
})

describe('多来源现场记录增量导入', () => {
  it('同一批次文件连续导入不重复，且写入在一个原子批次中', async () => {
    await makeUnits(['A', 'B', 'C'])
    const file = fieldFile('s1', [
      record('r1', '2026-01-01T08:00:00.000Z', 'A', 'B'),
      record('r2', '2026-01-01T09:00:00.000Z', 'B', 'C'),
    ])

    await confirm(file)
    expect(orderEdges.value).toHaveLength(2)
    expect(state.fieldBatches).toHaveLength(1)
    expect(state.fieldRecords.filter((r) => r.status !== 'undone')).toHaveLength(2)

    const relationsBefore = await db.relations.count()
    const recordsBefore = await db.fieldRecords.count()
    await confirm(file)

    expect(await db.relations.count()).toBe(relationsBefore)
    expect(await db.fieldRecords.count()).toBe(recordsBefore)
    expect(state.fieldBatches).toHaveLength(1)
    expect(orderEdges.value).toHaveLength(2)
  })

  it('乱序导入旧版与新版时识别最新修订，旧版本保留且默认维持现状', async () => {
    await makeUnits(['A', 'B'])

    const v1 = fieldFile('s1', [record('k', '2026-01-01T00:00:00.000Z', 'A', 'B', 'earlier', '初版备注')])
    const v2 = fieldFile('s1', [record('k', '2026-01-02T00:00:00.000Z', 'A', 'B', 'earlier', '修订备注')])

    // 先导入旧版，再乱序导入新版。
    await confirm(v1)
    const revisedPreview = await preview(v2)
    expect(revisedPreview.counts.revision).toBe(1)
    expect(revisedPreview.entries[0].decision).toBe('keep')
    await confirmFieldImport({ records: { [revisedPreview.entries[0].recordId]: 'accept' }, conflicts: {} })
    await refresh()

    const versions = state.fieldRecords
      .filter((r) => r.sourceId === 's1' && r.sourceKey === 'k')
      .sort((a, b) => a.collectedAt - b.collectedAt)
    expect(versions).toHaveLength(2)
    expect(versions[0].status).toBe('rejected') // 旧记录保留，但关系 superseded 表示不再入图
    expect(versions[0].replacedBy).toBe(versions[1].id)
    expect(versions[1].previousRecordId).toBe(versions[0].id)
    expect(state.relations.find((r) => r.id === versions[0].relationId)?.status).toBe('superseded')
    expect(state.relations.find((r) => r.id === versions[1].relationId)?.status).toBe('active')
    expect(orderEdges.value).toHaveLength(1)

    // 再次导入已接受的新内容必须幂等跳过。
    await confirm(v2)
    expect(state.fieldRecords).toHaveLength(2)
    expect(orderEdges.value).toHaveLength(1)

    // 先导新版，用户接受。
    await db.fieldBatches.clear()
    await db.fieldRecords.clear()
    await db.relations.clear()
    await db.batches.clear()
    await refresh()
    const newer = fieldFile('s1', [record('k', '2026-01-02T00:00:00.000Z', 'A', 'B', 'earlier', '新版结论')])
    await confirm(newer)
    expect(orderEdges.value).toHaveLength(1)

    // 再导旧版：归档但不覆盖当前关系。
    const older = fieldFile('s1', [record('k', '2026-01-01T00:00:00.000Z', 'A', 'B', 'contemporary', '旧版同期结论')])
    const oldPreview = await preview(older)
    expect(oldPreview.entries[0].category).toBe('revision')
    expect(oldPreview.entries[0].baseCategory).toBe('old-version')
    await confirmFieldImport({ records: {}, conflicts: {} })
    await refresh()
    expect(orderEdges.value).toHaveLength(1)
    expect(state.fieldRecords.map((r) => r.payload.kind).sort()).toEqual(['contemporary', 'earlier'])
    expect(state.fieldRecords.find((r) => r.payload.kind === 'contemporary')?.status).toBe('rejected')

    // 最后导入内容变化的新修订：默认“维持现状”，接受后旧版变为 superseded。
    const revised = fieldFile('s1', [record('k', '2026-01-03T00:00:00.000Z', 'B', 'A', 'earlier', '反向复核')])
    const p = await preview(revised)
    expect(p.entries[0].category).toBe('conflict') // 与当前 A→B 是同来源反向，也进入待归并
    await confirmFieldImport({ records: {}, conflicts: {} })
    await refresh()
    expect(openFieldConflicts.value).toHaveLength(1)
    expect(reachablePairs(orderEdges.value)).toEqual(['A→B'])
  })

  it('跨来源相反关系形成可追溯冲突，待归并双方均不污染有向图', async () => {
    await makeUnits(['A', 'B'])
    const s1 = fieldFile('s1', [record('k1', '2026-01-01T00:00:00.000Z', 'A', 'B')], '探方甲')
    const s2 = fieldFile('s2', [record('k2', '2026-01-01T01:00:00.000Z', 'B', 'A')], '探方乙')

    await confirm(s1)
    expect(reachablePairs(orderEdges.value)).toEqual(['A→B'])

    const p = await preview(s2)
    expect(p.counts.conflict).toBe(1)
    expect(p.conflicts[0].participants).toHaveLength(2)
    await confirmFieldImport({ records: {}, conflicts: {} })
    await refresh()

    const conflict = openFieldConflicts.value[0]
    expect(conflict.participants.map((x) => x.sourceId).sort()).toEqual(['s1', 's2'])
    // 待归并的新边不入图；旧活跃边直到归并决定时仍保留，不出现 A/B 双向污染。
    expect(reachablePairs(orderEdges.value)).toEqual(['A→B'])
    expect((await statusCounts()).get('conflicted')).toBe(1)

    await resolveFieldConflict(conflict.id, 'reject-both', '剖面复核后均不可靠')
    expect(openFieldConflicts.value).toHaveLength(0)
    expect(orderEdges.value).toHaveLength(0)
    const stored = state.fieldConflicts.find((c) => c.id === conflict.id)!
    expect(stored.history[0].reason).toContain('均不可靠')
  })

  it('混有非法层位引用时在事务前失败，完整回滚且无半批数据', async () => {
    await makeUnits(['A', 'B'])
    const file = fieldFile('bad-source', [
      record('good', '2026-01-01T00:00:00.000Z', 'A', 'B'),
      record('bad', '2026-01-01T01:00:00.000Z', 'B', 'MISSING'),
    ])

    await openFieldImport(asFile(file))
    expect(state.fieldImport).toBeNull()
    expect(await db.relations.count()).toBe(0)
    expect(await db.fieldRecords.count()).toBe(0)
    expect(await db.fieldBatches.count()).toBe(0)
    expect(await db.batches.count()).toBe(0)
    expect(await db.evidences.count()).toBe(0)
  })

  it('刷新后可恢复批次、版本、归并决定；撤销后重导仍遵守版本规则', async () => {
    await makeUnits(['A', 'B', 'C'])
    const s1 = fieldFile('s1', [
      record('k1', '2026-01-01T00:00:00.000Z', 'A', 'B'),
      record('k2', '2026-01-01T00:00:00.000Z', 'B', 'C'),
    ])
    const s2 = fieldFile('s2', [record('x', '2026-01-01T00:00:00.000Z', 'C', 'B')])
    await confirm(s1)
    await confirm(s2)
    expect(reachablePairs(orderEdges.value).sort()).toEqual(['A→B', 'A→C', 'B→C'])
    expect(openFieldConflicts.value).toHaveLength(1)

    const conflict = openFieldConflicts.value[0]
    const s2Relation = state.fieldRecords.find((r) => r.sourceId === 's2')!.relationId
    await resolveFieldConflict(conflict.id, s2Relation, '复核确认 C 晚于 B')

    // 模拟页面刷新：状态从 IndexedDB 重新装载。
    await refresh()
    expect(state.fieldBatches[0].undone).toBe(false)
    expect(state.fieldRecords).toHaveLength(3)
    expect(openFieldConflicts.value).toHaveLength(0)
    expect(state.fieldConflicts[0]?.status).toBe('resolved')
    expect(state.fieldConflicts[0]?.winnerRelationId).toBe(s2Relation)
    expect(reachablePairs(orderEdges.value).sort()).toEqual(['A→B', 'C→B'])

    const ledger = state.fieldBatches.find((b) => b.sourceId === 's1')!
    expect(fieldBatchCanUndo(ledger)).toBe(false)
    await undo()
    expect(openFieldConflicts.value).toHaveLength(1)
    expect(fieldBatchCanUndo(ledger)).toBe(true)
    await undoFieldBatch(ledger.id)
    expect(state.fieldBatches.find((b) => b.id === ledger.id)?.undone).toBe(true)
    expect(reachablePairs(orderEdges.value)).toEqual([])

    // 撤销后重导同一文件：唯一键和内容仍可识别，不能自动重新采纳。
    await confirm(s1)
    expect(reachablePairs(orderEdges.value)).toEqual([])
    expect(state.fieldBatches.find((b) => b.id === ledger.id)?.undone).toBe(true)
    expect(state.fieldRecords.filter((r) => r.sourceId === 's1').every((r) => r.status === 'undone')).toBe(true)
  })
})
