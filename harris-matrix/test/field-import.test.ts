/* eslint-disable no-console */
import 'fake-indexeddb/auto'

// Node 测试环境的最小浏览器桩
;(globalThis as unknown as { window: Record<string, unknown> }).window = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
  alert: () => undefined,
}
;(globalThis as unknown as { window: Record<string, unknown> }).window.self = (
  globalThis as unknown as { window: Record<string, unknown> }
).window

import { db } from '../src/db'
import {
  commitFieldImport,
  fieldConflictVMs,
  orderEdges,
  pendingFieldConflicts,
  previewFieldImportFromText,
  refresh,
  resolveFieldConflict,
  state,
  undoFieldBatch,
  unitLabel,
} from '../src/store'
import { buildGraph } from '../src/graph'
import type { FieldBatchFile, StratUnit } from '../src/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name} ${extra}`)
  }
}

function batchFile(sourceId: string, collectedAt: string, records: FieldBatchFile['records'], note?: string): string {
  const data: FieldBatchFile = {
    app: 'harris-matrix-field-batch',
    version: 1,
    sourceId,
    sourceName: sourceId,
    collectedAt,
    records,
    ...(note ? { note } : {}),
  }
  return JSON.stringify(data)
}

function rec(key: string, from: string, to: string, collectedAt: string, extra: Record<string, unknown> = {}) {
  return { key, from, to, kind: 'earlier', source: 'observation', collectedAt, ...extra }
}

async function seedUnits(labels: string[]) {
  const now = Date.now()
  const units: StratUnit[] = labels.map((label) => ({
    id: label,
    label,
    type: 'deposit',
    note: '',
    createdAt: now,
  }))
  await db.units.bulkPut(units)
  await refresh()
}

async function importOne(fileName: string, text: string) {
  await previewFieldImportFromText(fileName, text)
  if (!state.fieldPreview) throw new Error(`预览为空：${fileName}（期望成功）`)
  await commitFieldImport()
  await refresh()
}

function edgeSet() {
  return new Set(orderEdges.value.map((e) => `${e.from}->${e.to}`))
}

function hasPath(from: string, to: string) {
  const g = buildGraph(orderEdges.value)
  if (!g.hasNode(from) || !g.hasNode(to)) return false
  const seen = new Set([from])
  const queue = [from]
  while (queue.length) {
    const cur = queue.shift()!
    let hit = false
    g.forEachOutboundNeighbor(cur, (nb) => {
      if (hit || seen.has(nb)) return
      seen.add(nb)
      if (nb === to) hit = true
      else queue.push(nb)
    })
    if (hit) return true
  }
  return false
}

async function reset() {
  await db.delete()
  await db.open()
  await refresh()
}

async function main() {
  await refresh()

  /* ============ 场景 1：同批文件连续导入不重复（幂等） ============ */
  console.log('\n[1] 同批文件连续导入不重复')
  await reset()
  await seedUnits(['1001', '1002', '1003'])
  const fileA = batchFile('T1', '2026-09-01T08:00:00Z', [
    rec('r1', '1001', '1002', '2026-09-01T08:00:00Z'),
    rec('r2', '1002', '1003', '2026-09-01T08:05:00Z'),
  ])
  await importOne('a.json', fileA)
  check('首次导入产生 2 条有向边', edgeSet().size === 2, `实际 ${edgeSet().size}`)
  check('首次导入登记 1 个批次', state.fieldBatches.length === 1)
  check('首次导入产生 2 个版本', state.fieldVersions.length === 2)

  // 第二次导入同一文件（逐字相同）
  await importOne('a.json', fileA)
  check('再次导入后仍只有 2 条边', edgeSet().size === 2, `实际 ${edgeSet().size}`)
  check('再次导入后版本数仍为 2（幂等跳过）', state.fieldVersions.length === 2, `实际 ${state.fieldVersions.length}`)
  check('再次导入登记了第 2 个批次留痕', state.fieldBatches.length === 2)
  const second = state.fieldBatches.find((b) => b.seenDuplicateIds.length > 0)
  check('第二个批次记录了 2 个重复键', (second?.seenDuplicateIds.length ?? 0) === 2)
  check('第二个批次没有新激活版本', (second?.activeVersionIds.length ?? -1) === 0)
  check('图中 1001 可达 1003', hasPath('1001', '1003'))

  /* ============ 场景 2：乱序导入旧版与新版仍识别最新修订 ============ */
  console.log('\n[2] 乱序导入：先新版后旧版，最终仍采纳最新修订')
  await reset()
  await seedUnits(['2001', '2002', '2003'])
  // 先导入较新版本：r1 结论 2001 早于 2003（采集时间更晚）
  const newer = batchFile('T2', '2026-09-10T10:00:00Z', [
    rec('r1', '2001', '2003', '2026-09-10T10:00:00Z', { note: '复核后的修订结论' }),
  ])
  await importOne('newer.json', newer)
  check('新版导入：投影 2001->2003', edgeSet().has('2001->2003'))

  // 后导入较旧版本（补录）：r1 原结论 2001 早于 2002，采集时间更早
  const older = batchFile('T2', '2026-09-01T08:00:00Z', [
    rec('r1', '2001', '2002', '2026-09-01T08:00:00Z', { note: '初判' }),
  ])
  await previewFieldImportFromText('older.json', older)
  check('旧版被识别为 revision（降级补录）', state.fieldPreview?.items[0].kind === 'revision')
  check('降级方向标记为 downgrade', state.fieldPreview?.items[0].revision?.direction === 'downgrade')
  await commitFieldImport()
  await refresh()
  check('旧版入库留痕（共 2 个版本）', state.fieldVersions.length === 2)
  check('降级补录后仍投影最新修订 2001->2003', edgeSet().has('2001->2003'), [...edgeSet()].join(','))
  check('旧版结论 2001->2002 不投影', !edgeSet().has('2001->2002'))

  // 反过来：在空库上先旧后新（正常顺序），新版默认接受
  await reset()
  await seedUnits(['2001', '2002', '2003'])
  await importOne('older.json', older)
  check('先导旧版：投影 2001->2002', edgeSet().has('2001->2002'))
  await previewFieldImportFromText('newer.json', newer)
  check('新版被识别为 revision（升级）', state.fieldPreview?.items[0].kind === 'revision')
  check('升级方向标记为 upgrade', state.fieldPreview?.items[0].revision?.direction === 'upgrade')
  check('升级项默认建议接受修订', state.fieldPreview?.items[0].choice === 'accept')
  await commitFieldImport()
  await refresh()
  check('接受升级后投影 2001->2003', edgeSet().has('2001->2003'))
  check('旧版 2001->2002 已撤下但版本保留', !edgeSet().has('2001->2002') && state.fieldVersions.length === 2)

  // 维持现状：升级时选择 keep，新版存档不投影
  await reset()
  await seedUnits(['2001', '2002', '2003'])
  await importOne('older.json', older)
  await previewFieldImportFromText('newer.json', newer)
  state.fieldPreview!.items[0].choice = 'keep'
  await commitFieldImport()
  await refresh()
  check('维持现状：仍投影旧版 2001->2002', edgeSet().has('2001->2002'))
  check('维持现状：新版 2001->2003 不投影', !edgeSet().has('2001->2003'))
  check('维持现状：新版本仍已留存可追溯', state.fieldVersions.length === 2)

  /* ============ 场景 3：跨来源相反关系形成可追溯冲突，不污染有向图 ============ */
  console.log('\n[3] 跨来源相反结论：待归并冲突且有向图不被污染')
  await reset()
  await seedUnits(['3001', '3002'])
  // 来源甲：3001 早于 3002（在立方）
  await importOne(
    'jia.json',
    batchFile('JIA', '2026-09-02T08:00:00Z', [rec('j1', '3001', '3002', '2026-09-02T08:00:00Z')]),
  )
  check('来源甲记录在位 3001->3002', edgeSet().has('3001->3002'))
  // 来源乙：3002 早于 3001（相反结论）
  await previewFieldImportFromText(
    'yi.json',
    batchFile('YI', '2026-09-03T08:00:00Z', [rec('y1', '3002', '3001', '2026-09-03T08:00:00Z')]),
  )
  check('相反记录被识别为 conflict', state.fieldPreview?.items[0].kind === 'conflict')
  check('冲突预览列出在立方对手 JIA', state.fieldPreview?.items[0].conflict?.opponents[0].sourceId === 'JIA')
  await commitFieldImport()
  await refresh()
  check('产生 1 条待归并冲突', pendingFieldConflicts.value.length === 1, `实际 ${pendingFieldConflicts.value.length}`)
  const c = fieldConflictVMs.value[0]
  check('冲突含两个来源的双方', c.sides.length === 2 && new Set(c.sides.map((s) => s.sourceId)).size === 2)
  check('待归并期间在立方 3001->3002 保留', edgeSet().has('3001->3002'))
  check('待归并期间反对方 3002->3001 被屏蔽（不进有向图）', !edgeSet().has('3002->3001'), [...edgeSet()].join(','))
  check('有向图无 3001→…→3001 自环（未被污染）', !hasPath('3002', '3001'))

  // 归并：采纳来源乙（反转在立方）
  const yiSide = c.sides.find((s) => s.sourceId === 'YI')!.sideKey
  await resolveFieldConflict(c.id, yiSide, '剖面复核，乙正确')
  await refresh()
  check('归并后冲突标记为 resolved', fieldConflictVMs.value[0].status === 'resolved')
  check('归并后胜方 3002->3001 进入有向图', edgeSet().has('3002->3001'), [...edgeSet()].join(','))
  check('归并后败方 3001->3002 撤下', !edgeSet().has('3001->3002'))
  check('归并决定已留痕', fieldConflictVMs.value[0].decisions.some((d) => d.kind === 'resolved' && d.winnerKey === yiSide))

  /* ============ 场景 4：混有非法引用时完整回滚 ============ */
  console.log('\n[4] 任一非法层位引用 → 整批失败，无半批数据')
  await reset()
  await seedUnits(['4001', '4002'])
  const before = {
    relations: (await db.relations.toArray()).length,
    versions: (await db.fieldVersions.toArray()).length,
    batches: (await db.fieldBatches.toArray()).length,
    conflicts: (await db.fieldConflicts.toArray()).length,
  }
  const bad = batchFile('BAD', '2026-09-04T08:00:00Z', [
    rec('ok1', '4001', '4002', '2026-09-04T08:00:00Z'),
    rec('bad1', '4002', '9999', '2026-09-04T08:05:00Z'), // 非法终点
    { ...rec('bad2', '4001', '4001', '2026-09-04T08:06:00Z') },
  ])
  await previewFieldImportFromText('bad.json', bad)
  check('含非法引用时预览被拒绝（fieldPreview 为空）', state.fieldPreview === null)
  await refresh()
  const after = {
    relations: (await db.relations.toArray()).length,
    versions: (await db.fieldVersions.toArray()).length,
    batches: (await db.fieldBatches.toArray()).length,
    conflicts: (await db.fieldConflicts.toArray()).length,
  }
  check('合法的那一条也没有写入（无半批版本）', after.versions === before.versions)
  check('关系表无新增', after.relations === before.relations)
  check('批次表无新增', after.batches === before.batches)
  check('冲突表无新增', after.conflicts === before.conflicts)
  check('有向图为空', edgeSet().size === 0)

  // 结构性错误同样整批拒绝（同批键重复 / 缺采集时间）
  const dupKey = batchFile('BAD', '2026-09-04T08:00:00Z', [
    rec('k', '4001', '4002', '2026-09-04T08:00:00Z'),
    rec('k', '4002', '4001', '2026-09-04T08:01:00Z'),
  ])
  await previewFieldImportFromText('dup.json', dupKey)
  check('同批唯一键重复被整批拒绝', state.fieldPreview === null)

  /* ============ 场景 5：刷新恢复 + 按批撤销后重导按版本规则处理 ============ */
  console.log('\n[5] 刷新后恢复批次/版本/归并/撤销状态；按批撤销后重导')
  await reset()
  await seedUnits(['5001', '5002', '5003', '5004'])
  await importOne(
    's1.json',
    batchFile('S-A', '2026-09-05T08:00:00Z', [
      rec('a1', '5001', '5002', '2026-09-05T08:00:00Z'),
      rec('a2', '5002', '5003', '2026-09-05T08:05:00Z'),
    ]),
  )
  // 跨来源冲突并归并
  await importOne(
    's2.json',
    batchFile('S-B', '2026-09-06T08:00:00Z', [rec('b1', '5003', '5004', '2026-09-06T08:00:00Z', { kind: 'contemporary' })]),
  )
  const b1 = state.fieldBatches.find((x) => x.sourceId === 'S-A')!
  await undoFieldBatch(b1.id)
  await refresh()
  check('撤销 S-A 后其两条边从图中移除', !edgeSet().has('5001->5002') && !edgeSet().has('5002->5003'))
  check('撤销 S-A 后批次标记 undone', state.fieldBatches.find((x) => x.id === b1.id)?.undone === true)
  check('撤销 S-A 后版本行保留但停用', state.fieldVersions.every((v) => (v.sourceId === 'S-A' ? !v.active : true)))
  check('其他批次 S-B 的记录不受影响', state.relations.some((r) => r.provenance?.sourceId === 'S-B'))

  // 模拟刷新：重置内存状态后重开数据库并自愈
  state.fieldBatches = []
  state.fieldVersions = []
  state.fieldConflicts = []
  state.relations = []
  await db.close()
  await db.open()
  const { restoreFieldProjection } = await import('../src/store')
  await restoreFieldProjection()
  await refresh()
  check('刷新后批次撤销状态恢复', state.fieldBatches.find((x) => x.id === b1.id)?.undone === true)
  check('刷新后已撤销版本仍不投影', !edgeSet().has('5001->5002'))
  check('刷新后未撤销批次记录恢复投影', state.relations.some((r) => r.provenance?.sourceId === 'S-B'))

  // 撤销后重导同一文件：按版本规则再激活（幂等、不产生新版本）
  const versionsBefore = state.fieldVersions.length
  await importOne(
    's1.json',
    batchFile('S-A', '2026-09-05T08:00:00Z', [
      rec('a1', '5001', '5002', '2026-09-05T08:00:00Z'),
      rec('a2', '5002', '5003', '2026-09-05T08:05:00Z'),
    ]),
  )
  check('重导后原版本被再激活（无新版本行）', state.fieldVersions.length === versionsBefore)
  check('重导后关系回到有向图', edgeSet().has('5001->5002') && edgeSet().has('5002->5003'))
  check('重导产生的批次记录为再激活（2 条）', state.fieldBatches.at(-1)?.activeVersionIds.length === 2)
  check('重导批次把两条都记为重复键', state.fieldBatches.at(-1)?.seenDuplicateIds.length === 2)

  /* ============ 场景 6：归并状态刷新可恢复 ============ */
  console.log('\n[6] 归并决定刷新后恢复（败方不复活）')
  await reset()
  await seedUnits(['6001', '6002'])
  await importOne('p.json', batchFile('P', '2026-09-07T08:00:00Z', [rec('p1', '6001', '6002', '2026-09-07T08:00:00Z')]))
  await importOne('q.json', batchFile('Q', '2026-09-08T08:00:00Z', [rec('q1', '6002', '6001', '2026-09-08T08:00:00Z')]))
  const cid = fieldConflictVMs.value[0].id
  const qSide = fieldConflictVMs.value[0].sides.find((s) => s.sourceId === 'Q')!.sideKey
  await resolveFieldConflict(cid, qSide, '采 Q')
  await refresh()
  check('归并后投影 Q 方向', edgeSet().has('6002->6001'))
  state.relations = []
  state.fieldConflicts = []
  await db.close()
  await db.open()
  await restoreFieldProjection()
  await refresh()
  check('刷新后归并冲突仍为 resolved', fieldConflictVMs.value[0]?.status === 'resolved')
  check('刷新后胜方 Q 方向仍投影', edgeSet().has('6002->6001'), [...edgeSet()].join(','))
  check('刷新后败方 P 方向不复活', !edgeSet().has('6001->6002'))
  check('归并理由可追溯', state.fieldConflicts[0].decisions.some((d) => d.reason === '采 Q'))

  /* ============ 场景 7：同源反向是成环矛盾，不是跨来源归并冲突 ============ */
  console.log('\n[7] 同一来源的相反记录走成环机制，不进待归并')
  await reset()
  await seedUnits(['7001', '7002'])
  await importOne('s.json', batchFile('SAME', '2026-09-09T08:00:00Z', [rec('k1', '7001', '7002', '2026-09-09T08:00:00Z')]))
  // 同来源同 key 改方向 = 修订；同来源不同 key 反向
  await importOne('s2.json', batchFile('SAME', '2026-09-09T09:00:00Z', [rec('k2', '7002', '7001', '2026-09-09T09:00:00Z')]))
  check('同源反向不产生跨来源归并冲突', pendingFieldConflicts.value.length === 0, `实际 ${pendingFieldConflicts.value.length}`)
  // 两条都进入有向图（互为反向的成环矛盾，沿用既有 conflict 标记机制，不删除任何观察）
  const cycleRels = state.relations.filter((r) => r.provenance?.sourceId === 'SAME' && r.conflict)
  check('同源成环边以 conflict 矛盾标记保留', cycleRels.length >= 1, `实际 ${cycleRels.length}`)

  /* ============ 场景 8：三方来源冲突，仅在立方投影，其余屏蔽 ============ */
  console.log('\n[8] 三方来源各执一词：在立方唯一投影，无自环污染')
  await reset()
  await seedUnits(['8001', '8002'])
  await importOne('a.json', batchFile('A', '2026-09-10T08:00:00Z', [rec('a', '8001', '8002', '2026-09-10T08:00:00Z')]))
  await importOne('b.json', batchFile('B', '2026-09-10T09:00:00Z', [rec('b', '8002', '8001', '2026-09-10T09:00:00Z')]))
  await importOne('c.json', batchFile('C', '2026-09-10T10:00:00Z', [rec('c', '8002', '8001', '2026-09-10T10:00:00Z', { note: '第三方支持 B' })]))
  const c8 = fieldConflictVMs.value.find((x) => x.status === 'pending')
  check('三方汇聚为同一条待归并冲突（按层位对去重）', !!c8 && c8.sides.length === 3, `实际 ${c8?.sides.length}`)
  check('在立方为最早的 A', c8?.incumbentKey === 'A::a')
  check('仅在立方 8001->8002 投影', edgeSet().has('8001->8002') && edgeSet().size === 1, [...edgeSet()].join(','))
  check('B、C 反向均被屏蔽', !edgeSet().has('8002->8001'))
  // 采纳第三方 C 后，B 仍屏蔽、C 投影、A 撤下
  await resolveFieldConflict(c8!.id, 'C::c', '采第三方 C')
  await refresh()
  check('归并 C 后仅 8002->8001 投影', edgeSet().has('8002->8001') && edgeSet().size === 1, [...edgeSet()].join(','))
  check('归并后 A、B 均不投影', !edgeSet().has('8001->8002'))

  console.log(`\nunitLabel 冒烟：${unitLabel('6001')}`)
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
