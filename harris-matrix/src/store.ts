import { computed, reactive } from 'vue'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { buildSample } from './sample'
import {
  AUTO_RETRACT_PREFIX,
  buildPreview,
  computeProjection,
  conflictIdOf,
  discoverConflictRows,
  markerRetractionId,
  parseFieldBatch,
  sideKeyOf,
  type ParsedFieldBatch,
  type PreviewItem,
} from './field'
import type {
  Batch,
  Evidence,
  FieldBatch,
  FieldConflict,
  FieldVersion,
  Mutation,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  StratUnit,
  TableName,
  UnitPosition,
  UnitType,
} from './types'

export const state = reactive({
  loaded: false,
  units: [] as StratUnit[],
  positions: {} as Record<string, UnitPosition>,
  relations: [] as Relation[],
  evidences: [] as Evidence[],
  retractions: [] as Retraction[],
  batches: [] as Batch[],
  fieldBatches: [] as FieldBatch[],
  fieldVersions: [] as FieldVersion[],
  fieldConflicts: [] as FieldConflict[],
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 待确认的成环关系：记录员可选择保留为矛盾记录或取消 */
  pendingCycle: null as { draft: RelationDraft; path: string[] } | null,
  /** 现场记录导入预览（解析后、确认前，未落库） */
  fieldPreview: null as null | {
    fileName: string
    parsed: ParsedFieldBatch
    items: PreviewItem[]
    warnings: string[]
  },
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
})

/* ---------- 派生数据 ---------- */

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 仅“早于”关系进入有向图；同期关联被明确排除 */
export const orderEdges = computed<OrderEdge[]>(() =>
  activeRelations.value.filter((r) => r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to })),
)

/** 简化视图要隐藏的传递冗余边（只隐藏，不删除） */
export const redundantIds = computed(() => redundantEdges(orderEdges.value))

export const lastBatch = computed(() => {
  for (let i = state.batches.length - 1; i >= 0; i--) {
    if (!state.batches[i].undone) return state.batches[i]
  }
  return null
})

/** 活跃（未撤销）现场导入批次，倒序 */
export const activeFieldBatches = computed(() =>
  [...state.fieldBatches].filter((b) => !b.undone).sort((a, b) => b.importedAt - a.importedAt),
)

/** 按 (sourceId,key) 分组的版本链（新在前），用于版本追溯展示 */
export const fieldVersionChains = computed(() => {
  const groups = new Map<string, { sourceId: string; recordKey: string; versions: FieldVersion[] }>()
  for (const v of state.fieldVersions) {
    const k = sideKeyOf(v.sourceId, v.recordKey)
    const g = groups.get(k) ?? { sourceId: v.sourceId, recordKey: v.recordKey, versions: [] }
    g.versions.push(v)
    groups.set(k, g)
  }
  for (const g of groups.values()) g.versions.sort((a, b) => b.collectedAt - a.collectedAt || b.importedAt - a.importedAt)
  return [...groups.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.recordKey.localeCompare(b.recordKey))
})

/** 冲突归并视图：纯函数重算，待归并/已归并/已消解状态刷新后恢复 */
export const fieldConflictVMs = computed(() =>
  computeProjection({
    versions: state.fieldVersions,
    conflicts: state.fieldConflicts,
    relations: state.relations,
    evidences: state.evidences,
    retractions: state.retractions,
    units: state.units,
  }).conflicts,
)

/** 待人工归并的冲突（红色，不进有向图） */
export const pendingFieldConflicts = computed(() => fieldConflictVMs.value.filter((c) => c.status === 'pending'))

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 4000)
}

function tableOf(name: TableName) {
  return { units: db.units, positions: db.positions, relations: db.relations, evidences: db.evidences, retractions: db.retractions }[name]
}

/** 写入 IndexedDB 前去除 Vue 响应式代理（structuredClone 无法克隆 Proxy） */
function plain<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

async function applyForward(m: Mutation) {
  const t = tableOf(m.table)
  if (m.after == null) await t.delete(m.key)
  else await t.put(plain(m.after) as never)
}

async function applyInverse(m: Mutation) {
  const t = tableOf(m.table)
  if (m.before == null) await t.delete(m.key)
  else await t.put(plain(m.before) as never)
}

export async function refresh() {
  const [units, positions, relations, evidences, retractions, batches, fieldBatches, fieldVersions, fieldConflicts] =
    await Promise.all([
      db.units.toArray(),
      db.positions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.batches.orderBy('at').toArray(),
      db.fieldBatches.orderBy('importedAt').toArray(),
      db.fieldVersions.toArray(),
      db.fieldConflicts.toArray(),
    ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches
  state.fieldBatches = fieldBatches
  state.fieldVersions = fieldVersions
  state.fieldConflicts = fieldConflicts
  state.loaded = true
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 撤销最近一个未撤销的批次：关系与证据引用随逆向变更一起恢复 */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone)
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  for (const m of [...batch.mutations].reverse()) await applyInverse(m)
  await db.batches.update(batch.id, { undone: true })
  await refresh()
  toast(`已撤销：${batch.label}`)
}

/* ---------- 层位 ---------- */

export async function addUnit(label: string, type: UnitType, note: string) {
  label = label.trim()
  if (!label) return
  if (state.units.some((u) => u.label === label)) {
    toast(`层位 ${label} 已存在`)
    return
  }
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: Date.now() }
  await runBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 连带删除涉及该层位的关系及其撤销记录（全部记入批次，可整体撤销）
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
  }
  await runBatch(`删除层位 ${unit.label}（连带 ${mutations.length - (pos ? 2 : 1)} 条关系）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  toast(`已删除层位 ${unit.label}`)
}

/* ---------- 证据 ---------- */

export async function addEvidence(ref: string, text: string) {
  ref = ref.trim()
  if (!ref) return
  const ev: Evidence = { id: uid(), ref, text: text.trim(), createdAt: Date.now() }
  await runBatch(`登记证据 ${ref}`, [{ table: 'evidences', key: ev.id, before: null, after: ev }])
  toast(`已登记证据 ${ref}`)
}

/* ---------- 关系 ---------- */

function makeRelation(draft: RelationDraft, conflict: boolean): Relation {
  return {
    id: uid(),
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    source: draft.source,
    status: 'active',
    conflict,
    evidenceIds: [...draft.evidenceIds],
    note: draft.note.trim(),
    createdAt: Date.now(),
  }
}

function describe(draft: RelationDraft): string {
  return draft.kind === 'earlier'
    ? `${unitLabel(draft.from)} 早于 ${unitLabel(draft.to)}`
    : `${unitLabel(draft.from)} 与 ${unitLabel(draft.to)} 同期`
}

/**
 * 新增关系。先后关系先做有向成环检测：若成环则挂起并给出完整环路径，
 * 由记录员决定保留为矛盾记录或取消。同期关联不进入有向图，直接保存。
 */
export async function addRelation(draft: RelationDraft, allowConflict = false) {
  if (!draft.from || !draft.to) return
  if (draft.kind === 'earlier' && draft.from === draft.to) {
    toast('层位不能早于其自身')
    return
  }
  const dup = activeRelations.value.some(
    (r) => r.from === draft.from && r.to === draft.to && r.kind === draft.kind,
  )
  if (dup) {
    toast('相同的关系已存在')
    return
  }

  if (draft.kind === 'contemporary') {
    // 同期关联：只存档，不作为有向边参与偏序
    const relation = makeRelation(draft, false)
    await runBatch(`新增同期关联：${describe(draft)}`, [
      { table: 'relations', key: relation.id, before: null, after: relation },
    ])
    toast('已保存同期关联（不进入有向图）')
    return
  }

  const cycle = cyclePathIfAdded(orderEdges.value, draft.from, draft.to)
  if (cycle && !allowConflict) {
    state.pendingCycle = { draft: { ...draft }, path: cycle }
    return
  }
  const relation = makeRelation(draft, cycle !== null)
  await runBatch(
    cycle ? `新增矛盾记录：${describe(draft)}` : `新增先后关系：${describe(draft)}`,
    [{ table: 'relations', key: relation.id, before: null, after: relation }],
  )
  toast(cycle ? '已保存为矛盾记录（成环路径见画布红边）' : '已添加先后关系')
}

/** 确认保留成环关系为矛盾记录 */
export async function confirmCycle() {
  const pending = state.pendingCycle
  if (!pending) return
  state.pendingCycle = null
  await addRelation(pending.draft, true)
}

export function cancelCycle() {
  state.pendingCycle = null
}

/** 撤回判断：关系标记为 retracted，快照与理由单独存入 retractions 表 */
export async function retractRelation(id: string, reason: string) {
  const rel = state.relations.find((r) => r.id === id)
  if (!rel || rel.status !== 'active') return
  const retraction: Retraction = {
    id: uid(),
    relationId: id,
    snapshot: { ...rel },
    reason: reason.trim() || '（未填写理由）',
    at: Date.now(),
  }
  await runBatch(`撤回判断：${unitLabel(rel.from)} → ${unitLabel(rel.to)}`, [
    { table: 'relations', key: id, before: rel, after: { ...rel, status: 'retracted' as const } },
    { table: 'retractions', key: retraction.id, before: null, after: retraction },
  ])
  // 若撤回的是现场记录投影：同步停用其采纳版本，避免下次自愈重算复活
  if (rel.provenance) {
    const pv = state.fieldVersions.find(
      (v) =>
        v.active &&
        v.sourceId === rel.provenance!.sourceId &&
        v.recordKey === rel.provenance!.recordKey &&
        v.contentHash === rel.provenance!.contentHash,
    )
    if (pv) await db.fieldVersions.update(pv.id, { active: false, adopted: false })
    // 撤回投影可能解除一处冲突在压：重算一次（手动撤回不自动恢复他方，归并状态保持留痕）
    await restoreFieldProjection()
  }
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 画布位置（与地层身份分离，不进入撤销批次） ---------- */

export async function savePosition(unitId: string, x: number, y: number) {
  const pos: UnitPosition = { unitId, x, y }
  await db.positions.put(pos)
  state.positions = { ...state.positions, [unitId]: pos }
}

/** 按最长路径分层自动排布（忽略成环边） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按地层早晚自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sample.relations.filter((r) => r.kind === 'earlier' && r.status === 'active'),
  )
  const mutations: Mutation[] = []
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  for (const r of sample.relations) mutations.push({ table: 'relations', key: r.id, before: null, after: r })
  for (const x of sample.retractions) mutations.push({ table: 'retractions', key: x.id, before: null, after: x })
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  state.layoutVersion++
  toast('示例工程已载入（含切割事件、孤立层位、矛盾记录与已撤销判断）')
}

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据？此操作不可撤销。')) return
  await db.transaction(
    'rw',
    [
      db.units,
      db.positions,
      db.relations,
      db.evidences,
      db.retractions,
      db.batches,
      db.fieldBatches,
      db.fieldVersions,
      db.fieldConflicts,
    ],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.fieldBatches.clear(),
        db.fieldVersions.clear(),
        db.fieldConflicts.clear(),
      ])
    },
  )
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

export function exportProject() {
  const data: ProjectExport = {
    app: 'harris-matrix-workbench',
    version: 1,
    exportedAt: new Date().toISOString(),
    units: state.units,
    positions: Object.values(state.positions),
    relations: state.relations,
    evidences: state.evidences,
    retractions: state.retractions,
    partialOrder: reachablePairs(orderEdges.value),
    fieldBatches: state.fieldBatches,
    fieldVersions: state.fieldVersions,
    fieldConflicts: state.fieldConflicts,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出（偏序闭包 ${data.partialOrder.length} 个可达对）`)
}

export async function importProject(file: File) {
  let data: ProjectExport
  try {
    data = JSON.parse(await file.text())
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    toast('导入失败：文件格式不符')
    return
  }
  if (!window.confirm('导入将替换当前工程（不可撤销），继续？')) return
  await db.transaction(
    'rw',
    [
      db.units,
      db.positions,
      db.relations,
      db.evidences,
      db.retractions,
      db.batches,
      db.fieldBatches,
      db.fieldVersions,
      db.fieldConflicts,
    ],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.fieldBatches.clear(),
        db.fieldVersions.clear(),
        db.fieldConflicts.clear(),
      ])
      await db.units.bulkPut(data.units)
      await db.positions.bulkPut(data.positions ?? [])
      await db.relations.bulkPut(data.relations)
      await db.evidences.bulkPut(data.evidences ?? [])
      await db.retractions.bulkPut(data.retractions ?? [])
      await db.fieldBatches.bulkPut(data.fieldBatches ?? [])
      await db.fieldVersions.bulkPut(data.fieldVersions ?? [])
      await db.fieldConflicts.bulkPut(data.fieldConflicts ?? [])
    },
  )
  await refresh()
  state.layoutVersion++
  // 现场投影按导入的版本链与归并决定重算，保证有向图与持久化状态一致
  await restoreFieldProjection()
  // 偏序一致性校验：重算可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  toast(same ? `导入完成，偏序校验一致（${actual.length} 个可达对）` : '导入完成，但偏序与导出时不一致，请检查数据')
}

/* ===================== 多来源现场记录增量导入 ===================== */

const FIELD_TABLES = [
  db.units,
  db.evidences,
  db.fieldBatches,
  db.fieldVersions,
  db.fieldConflicts,
  db.relations,
  db.retractions,
] as const

function plainField<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

/** 读取现场批次文件并生成四类预览（不落库；任一非法引用整批拒绝） */
export async function previewFieldImport(file: File) {
  let text: string
  try {
    text = await file.text()
  } catch {
    toast('导入失败：无法读取文件')
    return
  }
  await previewFieldImportFromText(file.name, text)
}

/** 文本入口（同样供测试调用）：解析 + 整批校验 + 四类预览 */
export async function previewFieldImportFromText(fileName: string, text: string) {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  const parsed = parseFieldBatch(raw, {
    units: state.units,
    evidences: state.evidences,
    fileName,
  })
  if (!parsed.ok) {
    state.fieldPreview = null
    // 明确列出全部致命错误：整批放弃，不产生任何写入
    const msg = `现场批次无法导入（${parsed.errors.length} 处错误，整批未写入）：\n\n${parsed.errors.join('\n')}`
    if (typeof window !== 'undefined' && window.alert) window.alert(msg)
    else console.warn(msg)
    return
  }
  const items = buildPreview(parsed.batch, {
    versions: state.fieldVersions,
    relations: state.relations,
  })
  const warnings = [...new Set(items.flatMap((i) => i.record.warnings))]
  state.fieldPreview = { fileName, parsed: parsed.batch, items, warnings }
}

export function cancelFieldPreview() {
  state.fieldPreview = null
}

export function setPreviewChoice(index: number, choice: 'accept' | 'keep') {
  const p = state.fieldPreview
  if (!p) return
  const item = p.items[index]
  if (item.kind === 'revision' && item.revision?.direction === 'upgrade') item.choice = choice
}

/** 应用投影计划：冲突在压/败方一律不进入有向图；手工败方自动撤回并留痕可恢复 */
async function applyProjectionPlan(plan: ReturnType<typeof computeProjection>) {
  for (const rel of plan.desired.values()) await db.relations.put(plainField(rel))
  for (const id of plan.retractProvenanceIds) {
    const rel = await db.relations.get(id)
    if (rel && rel.status === 'active') {
      await db.relations.put({ ...plainField(rel), status: 'retracted' })
      await db.retractions.put({
        id: markerRetractionId(id),
        relationId: id,
        snapshot: plainField(rel),
        reason: `${AUTO_RETRACT_PREFIX}跨来源相反结论待归并/判定败方，该现场记录暂不进入有向图。`,
        at: Date.now(),
      })
    }
  }
  for (const id of plan.deleteRelationIds) {
    await db.relations.delete(id)
    await db.retractions.where('relationId').equals(id).delete()
  }
  for (const rel of plan.autoRetractManual) {
    if (rel.status !== 'active') continue
    await db.relations.put({ ...plainField(rel), status: 'retracted' })
    const xid = markerRetractionId(rel.id)
    const existed = await db.retractions.get(xid)
    await db.retractions.put({
      id: xid,
      relationId: rel.id,
      snapshot: plainField(rel),
      reason: `${AUTO_RETRACT_PREFIX}归并决定采纳现场记录 ${rel.provenance?.sourceId ?? ''}，原手工判断撤回（可随重开恢复）。`,
      at: Date.now(),
    })
    void existed
  }
  for (const id of plan.restoreRelationIds) {
    const x = await db.retractions.get(markerRetractionId(id))
    if (x) {
      const desired = plan.desired.get(id)
      if (desired) await db.relations.put(plainField(desired))
      else await db.relations.put({ ...plainField(x.snapshot), status: 'active' })
      await db.retractions.delete(x.id)
    }
  }
}

/** 全量重算投影（发现冲突行 + 物化关系），用于提交后、撤销后、归并后与启动恢复 */
async function reconcileFieldProjection(now: number) {
  await db.transaction('rw', FIELD_TABLES, async () => {
    const [versions, relations, evidences, retractions, existingConflicts, units] = await Promise.all([
      db.fieldVersions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.fieldConflicts.toArray(),
      db.units.toArray(),
    ])
    const conflicts = discoverConflictRows({ versions, relations, existing: existingConflicts, now })
    for (const c of conflicts) await db.fieldConflicts.put(plainField(c))
    const plan = computeProjection({ versions, conflicts, relations, evidences, retractions, units })
    await applyProjectionPlan(plan)
  })
  await refresh()
}

/**
 * 一次确认：版本、批次、冲突、投影原子写入单个事务。
 * 解析阶段已经保证无非法层位引用；此处任何写入失败由 Dexie 回滚整批，不留半批数据。
 */
export async function commitFieldImport() {
  const preview = state.fieldPreview
  if (!preview) return
  const { parsed, items, fileName } = preview
  const now = Date.now()

  try {
    await db.transaction('rw', FIELD_TABLES, async () => {
      const versions = await db.fieldVersions.toArray()
      const relations = await db.relations.toArray()
      const evidences = await db.evidences.toArray()
      const retractions = await db.retractions.toArray()
      const existingConflicts = await db.fieldConflicts.toArray()
      const units = await db.units.toArray()

      const activeVersionIds: string[] = []
      const seenDuplicateIds: string[] = []
      const incumbentHints: Record<string, string> = {}

      const setOthersNotAdopted = (identity: string, exceptId: string) => {
        for (const other of versions) {
          if (other.id !== exceptId && other.active && sideKeyOf(other.sourceId, other.recordKey) === identity)
            other.adopted = false
        }
      }

      for (const item of items) {
        const r = item.record
        if (item.kind === 'duplicate') {
          seenDuplicateIds.push(r.versionId)
          if (item.duplicateMode === 'reactivate' && item.existing) {
            // 撤销后重导同一内容：按版本规则再激活（不产生新版本行，幂等），
            // 直接改事务内读出的版本数组，随后随 bulkPut 一并持久化。
            const cur = versions.find((v) => v.id === r.versionId)
            const target = cur ?? item.existing
            target.active = true
            target.adopted = true
            activeVersionIds.push(target.id)
          }
          continue
        }

        // 修订规则同样适用于冲突项：升级默认接受（用户可选维持现状），降级一律归档旧版继续在位
        const isUpgrade = item.kind === 'new' || item.revision?.direction === 'upgrade' || item.conflict?.revision === 'upgrade'
        const userWantsNew = item.kind === 'new' || item.choice !== 'keep'
        const adoptNew = isUpgrade ? userWantsNew : false

        const identity = sideKeyOf(parsed.meta.sourceId, r.key)
        const version: FieldVersion = {
          id: r.versionId,
          sourceId: parsed.meta.sourceId,
          recordKey: r.key,
          contentHash: r.contentHash,
          from: r.fromId,
          to: r.toId,
          kind: r.kind,
          source: r.source,
          evidenceRefs: r.evidenceRefs,
          note: r.note,
          collectedAt: r.collectedAt,
          importedAt: now,
          batchId: '__pending__',
          active: true,
          adopted: adoptNew,
        }
        versions.push(version)
        activeVersionIds.push(version.id)

        if (adoptNew) {
          // 旧版本保留（不覆盖、不删除），仅撤下采纳标志；投影层的相反方向由冲突规则屏蔽
          setOthersNotAdopted(identity, version.id)
        } else {
          // 维持现状 / 降级归档：让既有最新版本继续作为采纳版本
          const keep = item.revision?.latest
          if (keep) {
            keep.adopted = true
            setOthersNotAdopted(identity, keep.id)
          }
        }

        // 记录“在立方”提示：预览时已在位的相反手工/现场边（仅新建冲突行时使用）
        if (item.kind === 'conflict') {
          const cid = conflictIdOf(r.fromId, r.toId)
          const incumbent = item.conflict!.opponents.find((o) =>
            relations.some((rel) => rel.id === o.relationId && rel.status === 'active'),
          )
          if (incumbent) incumbentHints[cid] = incumbent.sideKey
        }
      }

      const batch: FieldBatch = {
        id: uid(),
        sourceId: parsed.meta.sourceId,
        sourceName: parsed.meta.sourceName,
        note: parsed.meta.note,
        collectedAt: parsed.meta.collectedAt,
        importedAt: now,
        fileName,
        activeVersionIds,
        seenDuplicateIds,
        undone: false,
      }
      for (const v of versions) if (v.batchId === '__pending__') v.batchId = batch.id

      await db.fieldBatches.put(plainField(batch))
      await db.fieldVersions.bulkPut(versions.map(plainField))

      const conflicts = discoverConflictRows({ versions, relations, existing: existingConflicts, incumbentHints, now })
      for (const c of conflicts) await db.fieldConflicts.put(plainField(c))
      const plan = computeProjection({ versions, conflicts, relations, evidences, retractions, units })
      await applyProjectionPlan(plan)
    })

    const stats = {
      new: items.filter((i) => i.kind === 'new').length,
      duplicate: items.filter((i) => i.kind === 'duplicate').length,
      revision: items.filter((i) => i.kind === 'revision').length,
      conflict: items.filter((i) => i.kind === 'conflict').length,
    }
    state.fieldPreview = null
    await refresh()
    toast(
      `已确认导入：新增 ${stats.new}、重复跳过/再激活 ${stats.duplicate}、修订 ${stats.revision}、待归并冲突 ${stats.conflict}`,
    )
  } catch (err) {
    // 事务回滚：不会留下半批数据
    state.fieldPreview = null
    await refresh()
    toast(`导入失败，整批已回滚：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 按批次撤销已采纳记录：停用本批版本并重算投影；随后重导仍按版本规则处理 */
export async function undoFieldBatch(batchId: string) {
  const batch = state.fieldBatches.find((b) => b.id === batchId)
  if (!batch || batch.undone) return
  if (!window.confirm(`撤销批次「${batch.fileName}（${batch.sourceId}）」？其记录将停用并从矩阵投影移除，版本链保留。`))
    return
  const now = Date.now()
  await db.transaction('rw', FIELD_TABLES, async () => {
    for (const vid of batch.activeVersionIds) {
      const v = await db.fieldVersions.get(vid)
      if (v && v.batchId === batchId) {
        v.active = false
        v.adopted = false
        await db.fieldVersions.put(plainField(v))
      } else if (v && v.active) {
        // 重导再激活的版本：仅停用，不删除（仍归属其原始批次行）
        v.active = false
        v.adopted = false
        await db.fieldVersions.put(plainField(v))
      }
    }
    await db.fieldBatches.put(plainField({ ...batch, undone: true }))
    const [versions, relations, evidences, retractions, existingConflicts, units] = await Promise.all([
      db.fieldVersions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.fieldConflicts.toArray(),
      db.units.toArray(),
    ])
    const conflicts = discoverConflictRows({ versions, relations, existing: existingConflicts, now })
    for (const c of conflicts) await db.fieldConflicts.put(plainField(c))
    await applyProjectionPlan(computeProjection({ versions, conflicts, relations, evidences, retractions, units }))
  })
  await refresh()
  toast(`已撤销现场批次：${batch.fileName}`)
}

/** 归并决定：采纳某一方（胜方进入有向图，败方屏蔽/撤回，决定留痕） */
export async function resolveFieldConflict(conflictId: string, winnerKey: string, reason: string) {
  const now = Date.now()
  await db.transaction('rw', FIELD_TABLES, async () => {
    const conflict = await db.fieldConflicts.get(conflictId)
    if (!conflict) throw new Error('冲突不存在')
    if (!conflict.sides.some((s) => s.sideKey === winnerKey)) throw new Error('获胜方不存在')
    conflict.decisions = [
      ...conflict.decisions,
      { at: now, kind: 'resolved', winnerKey, reason: reason.trim() || '（未填写理由）' },
    ]
    conflict.updatedAt = now
    await db.fieldConflicts.put(plainField(conflict))
    const [versions, relations, evidences, retractions, existingConflicts, units] = await Promise.all([
      db.fieldVersions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.fieldConflicts.toArray(),
      db.units.toArray(),
    ])
    await applyProjectionPlan(computeProjection({ versions, conflicts: existingConflicts, relations, evidences, retractions, units }))
  })
  await refresh()
  toast('已记录归并决定')
}

/** 重开归并：回到待归并，在立方恢复投影，原决定全程留痕 */
export async function reopenFieldConflict(conflictId: string) {
  const now = Date.now()
  await db.transaction('rw', FIELD_TABLES, async () => {
    const conflict = await db.fieldConflicts.get(conflictId)
    if (!conflict) return
    conflict.decisions = [...conflict.decisions, { at: now, kind: 'reopened', winnerKey: null, reason: '记录员手动重开归并' }]
    conflict.updatedAt = now
    await db.fieldConflicts.put(plainField(conflict))
    const [versions, relations, evidences, retractions, existingConflicts, units] = await Promise.all([
      db.fieldVersions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.fieldConflicts.toArray(),
      db.units.toArray(),
    ])
    await applyProjectionPlan(computeProjection({ versions, conflicts: existingConflicts, relations, evidences, retractions, units }))
  })
  await refresh()
  toast('冲突已重开为待归并')
}

/** 手动采纳某一历史版本（版本链上的“采用此版”），重算投影 */
export async function adoptFieldVersion(versionId: string) {
  const now = Date.now()
  await db.transaction('rw', FIELD_TABLES, async () => {
    const target = await db.fieldVersions.get(versionId)
    if (!target || !target.active) {
      toast('该版本已随批次撤销，无法直接采用；请重新导入对应批次')
      return
    }
    const versions = await db.fieldVersions.toArray()
    const sideKey = sideKeyOf(target.sourceId, target.recordKey)
    for (const v of versions) {
      if (v.active && sideKeyOf(v.sourceId, v.recordKey) === sideKey) v.adopted = v.id === target.id
    }
    await db.fieldVersions.bulkPut(versions.map(plainField))
    const [relations, evidences, retractions, existingConflicts, units] = await Promise.all([
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.fieldConflicts.toArray(),
      db.units.toArray(),
    ])
    const conflicts = discoverConflictRows({ versions, relations, existing: existingConflicts, now })
    for (const c of conflicts) await db.fieldConflicts.put(plainField(c))
    await applyProjectionPlan(computeProjection({ versions, conflicts, relations, evidences, retractions, units }))
  })
  await refresh()
  toast('已采用所选版本')
}

/** 启动/刷新后的自愈恢复：重算全部现场投影（批次、版本、归并决定、撤销状态均已持久化） */
export async function restoreFieldProjection() {
  await reconcileFieldProjection(Date.now())
}
