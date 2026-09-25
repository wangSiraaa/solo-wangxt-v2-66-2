import { computed, reactive } from 'vue'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { buildSample } from './sample'
import {
  buildFieldPreview,
  isArchivedEntry,
  isWritableEntry,
  parseFieldBatchFile,
  type FieldImportSelections,
  type FieldPreview,
  type FieldPreviewEntry,
} from './fieldImport'
import type {
  Batch,
  Evidence,
  FieldBatch,
  FieldConflict,
  FieldConflictDecision,
  FieldRecord,
  FieldRecordStatus,
  Mutation,
  ProjectExport,
  Relation,
  RelationDraft,
  RelationStatus,
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
  fieldRecords: [] as FieldRecord[],
  fieldConflicts: [] as FieldConflict[],
  fieldImport: null as { fileName: string; text: string; preview: FieldPreview } | null,
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 待确认的成环关系：记录员可选择保留为矛盾记录或取消 */
  pendingCycle: null as { draft: RelationDraft; path: string[] } | null,
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
})

/* ---------- 派生数据 ---------- */

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 仅“早于”关系进入有向图；同期关联与待归并冲突被明确排除 */
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

export const openFieldConflicts = computed(() => state.fieldConflicts.filter((c) => c.status === 'open'))

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()
const evidenceId = (ref: string) => `ev:${ref}`

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
  globalThis.clearTimeout(toastTimer)
  toastTimer = globalThis.setTimeout(() => (state.toast = ''), 4000)
}

function tableOf(name: TableName) {
  return {
    units: db.units,
    positions: db.positions,
    relations: db.relations,
    evidences: db.evidences,
    retractions: db.retractions,
    fieldBatches: db.fieldBatches,
    fieldRecords: db.fieldRecords,
    fieldConflicts: db.fieldConflicts,
  }[name]
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
  const [units, positions, relations, evidences, retractions, batches, fieldBatches, fieldRecords, fieldConflicts] =
    await Promise.all([
      db.units.toArray(),
      db.positions.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.retractions.toArray(),
      db.batches.orderBy('at').toArray(),
      db.fieldBatches.orderBy('importedAt').toArray(),
      db.fieldRecords.toArray(),
      db.fieldConflicts.toArray(),
    ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches.map((b) => ({ ...b, kind: b.kind ?? 'manual' }))
  state.fieldBatches = fieldBatches.map((b) => ({ ...b, importSequence: b.importSequence ?? 1 }))
  state.fieldRecords = fieldRecords.sort((a, b) => a.collectedAt - b.collectedAt)
  state.fieldConflicts = fieldConflicts.sort((a, b) => b.updatedAt - a.updatedAt)
  state.loaded = true
}

async function runBatch(
  label: string,
  mutations: Mutation[],
  kind: Batch['kind'] = 'manual',
  fieldBatchId?: string,
  batchId = uid(),
): Promise<Batch | undefined> {
  if (mutations.length === 0) return
  const tables = [
    db.units,
    db.positions,
    db.relations,
    db.evidences,
    db.retractions,
    db.fieldBatches,
    db.fieldRecords,
    db.fieldConflicts,
    db.batches,
  ]
  let saved: Batch | undefined
  await db.transaction('rw', tables, async () => {
    for (const m of mutations) await applyForward(m)
    const batch: Batch = { id: batchId, kind, fieldBatchId, label, at: Date.now(), undone: false, mutations }
    saved = batch
    await db.batches.put(plain(batch))
  })
  await refresh()
  return saved
}

/** 若通用批次之后又有操作触碰同一对象，禁止撤销，避免把后续决定悄悄卷回 */
export function batchCanUndo(batch: Batch, allBatches = state.batches): boolean {
  if (batch.undone || (batch.kind !== 'manual' && batch.kind !== 'field-resolution')) return false
  const changed = new Set(batch.mutations.map((m) => `${m.table}:${m.key}`))
  return !allBatches
    .filter((b) => !b.undone && b.at > batch.at)
    .some((b) => b.mutations.some((m) => changed.has(`${m.table}:${m.key}`)))
}

/** 撤销最近一个未撤销的普通批次：关系与证据引用随逆向变更一起恢复 */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone && (b.kind === 'manual' || b.kind === 'field-resolution'))
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  if (!batchCanUndo(batch)) {
    toast('该操作之后已有对象被再次修改，不能直接撤销；请使用对应现场批次撤销')
    return
  }
  const tables = [
    db.units,
    db.positions,
    db.relations,
    db.evidences,
    db.retractions,
    db.fieldBatches,
    db.fieldRecords,
    db.fieldConflicts,
    db.batches,
  ]
  await db.transaction('rw', tables, async () => {
    for (const m of [...batch.mutations].reverse()) await applyInverse(m)
    await db.batches.update(batch.id, { undone: true })
  })
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
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 多来源现场记录增量导入 ---------- */

function fieldDescribe(entry: FieldPreviewEntry | FieldRecord): string {
  const p = entry.payload
  return p.kind === 'earlier'
    ? `${unitLabel(p.from)} 早于 ${unitLabel(p.to)}`
    : `${unitLabel(p.from)} 与 ${unitLabel(p.to)} 同期`
}

export async function openFieldImport(file: File) {
  let text: string
  try {
    text = await file.text()
  } catch {
    toast('读取现场批次文件失败')
    return
  }
  try {
    const parsed = parseFieldBatchFile(text, file.name)
    const preview = buildFieldPreview(
      parsed,
      {
        units: state.units,
        relations: state.relations,
        evidences: state.evidences,
        records: state.fieldRecords,
        conflicts: state.fieldConflicts,
      },
      file.name,
    )
    state.fieldImport = { fileName: file.name, text, preview }
  } catch (err) {
    state.fieldImport = null
    toast(`现场批次无法预览：${err instanceof Error ? err.message : '未知错误'}`)
  }
}

export function closeFieldImport() {
  state.fieldImport = null
}

function fieldDecision(entry: FieldPreviewEntry, selections: FieldImportSelections): FieldRecordStatus {
  if (entry.category === 'conflict') return 'pending'
  if (entry.baseCategory === 'new') return selections.records[entry.recordId] === 'keep' ? 'rejected' : 'accepted'
  if (entry.baseCategory === 'revision') return selections.records[entry.recordId] === 'accept' ? 'accepted' : 'rejected'
  return 'rejected'
}

function pushMutation(mutations: Map<string, Mutation>, m: Mutation) {
  const key = `${m.table}:${m.key}`
  const old = mutations.get(key)
  mutations.set(key, old ? { ...m, before: old.before } : m)
}

async function commitFieldImport(selections: FieldImportSelections) {
  const pending = state.fieldImport
  if (!pending) return

  const tables = [
    db.units,
    db.positions,
    db.relations,
    db.evidences,
    db.retractions,
    db.fieldBatches,
    db.fieldRecords,
    db.fieldConflicts,
    db.batches,
  ]
  const at = Date.now()
  const batchId = uid()
  let committed = false
  let committedCount = 0

  await db.transaction('rw', tables, async () => {
    const [units, relations, evidences, records, existingConflicts, existingBatches] = await Promise.all([
      db.units.toArray(),
      db.relations.toArray(),
      db.evidences.toArray(),
      db.fieldRecords.toArray(),
      db.fieldConflicts.toArray(),
      db.fieldBatches.toArray(),
    ])
    const parsed = parseFieldBatchFile(pending.text, pending.fileName)
    const preview = buildFieldPreview(parsed, { units, relations, evidences, records, conflicts: existingConflicts }, pending.fileName)

    for (const conflict of preview.conflicts) {
      const choice = selections.conflicts[conflict.id]
      if (choice && choice !== 'reject-both' && !conflict.participants.some((p) => p.relationId === choice)) {
        throw new Error(`冲突 ${conflict.pairKey} 的归并选择已过期，请重新预览`)
      }
    }

    const importSequence = existingBatches.filter((b) => b.id === preview.batch.batchId || b.id.startsWith(`${preview.batch.batchId}:`)).length
    const ledgerId = importSequence === 0 ? preview.batch.batchId : `${preview.batch.batchId}:${importSequence + 1}`

    const mutations = new Map<string, Mutation>()
    const evidenceByRef = new Map(evidences.map((e) => [e.ref, e]))
    const relationStore = new Map(relations.map((r) => [r.id, r]))
    const recordStore = new Map(records.map((r) => [r.id, r]))
    const conflictStore = new Map(existingConflicts.map((c) => [c.id, c]))
    const writable = preview.entries.filter(isWritableEntry)
    const archived = preview.entries.filter(isArchivedEntry)
    const written = [...writable, ...archived]

    // 证据按出处去重；同一出处已存在则复用，不产生重复证据。
    for (const ref of [...new Set(written.flatMap((e) => e.payload.evidenceRefs))].sort()) {
      const existing = evidenceByRef.get(ref)
      if (!existing) {
        const ev: Evidence = { id: evidenceId(ref), ref, text: '', createdAt: at }
        pushMutation(mutations, { table: 'evidences', key: ev.id, before: null, after: ev })
        evidenceByRef.set(ref, ev)
      }
    }

    for (const entry of preview.entries) {
      const decision = fieldDecision(entry, selections)
      if (!isWritableEntry(entry) && !isArchivedEntry(entry) && entry.category !== 'conflict') continue

      const relationStatus: RelationStatus =
        decision === 'accepted' ? 'active' : decision === 'pending' ? 'conflicted' : 'retracted'
      const evidenceIds = entry.payload.evidenceRefs.map(evidenceId)
      const relation: Relation = {
        id: entry.relationId,
        from: entry.payload.from,
        to: entry.payload.to,
        kind: entry.payload.kind,
        source: entry.payload.source,
        status: isArchivedEntry(entry) ? 'retracted' : relationStatus,
        conflict: false,
        evidenceIds,
        note: entry.payload.note,
        createdAt: entry.collectedAt,
      }
      pushMutation(mutations, {
        table: 'relations',
        key: relation.id,
        before: relationStore.get(relation.id) ?? null,
        after: relation,
      })

      if (isWritableEntry(entry) || isArchivedEntry(entry)) {
        const previous = entry.current && recordStore.get(entry.current.id) === entry.current ? entry.current : undefined
        const record: FieldRecord = {
          id: entry.recordId,
          batchId: ledgerId,
          sourceId: preview.batch.sourceId,
          sourceName: preview.batch.sourceName,
          sourceKey: entry.sourceKey,
          collectedAt: entry.collectedAt,
          importedAt: at,
          contentHash: entry.contentHash,
          payload: entry.payload,
          relationId: relation.id,
          status: isArchivedEntry(entry) ? 'rejected' : decision,
          previousRecordId: previous?.id,
        }
        pushMutation(mutations, { table: 'fieldRecords', key: record.id, before: null, after: record })

        if (previous && entry.baseCategory === 'revision') {
          const oldRecord: FieldRecord = { ...previous, replacedBy: record.id, status: decision === 'accepted' && !entry.conflictId ? 'rejected' : previous.status }
          const oldRelation = relationStore.get(previous.relationId)
          pushMutation(mutations, {
            table: 'fieldRecords',
            key: oldRecord.id,
            before: previous,
            after: oldRecord,
          })
          if (oldRelation) {
            const chosen = selections.conflicts[entry.conflictId ?? '']
            let oldStatus: RelationStatus
            if (decision === 'accepted' && !entry.conflictId) oldStatus = 'superseded'
            else if (entry.conflictId && chosen === 'reject-both') oldStatus = 'retracted'
            else if (entry.conflictId && chosen && chosen !== entry.relationId) oldStatus = 'retracted'
            else if (entry.conflictId && chosen === entry.relationId) oldStatus = 'superseded'
            else oldStatus = oldRelation.status
            pushMutation(mutations, {
              table: 'relations',
              key: oldRelation.id,
              before: oldRelation,
              after: { ...oldRelation, status: oldStatus },
            })
          }
        }
      }
    }

    for (const previewConflict of preview.conflicts) {
      const choice = selections.conflicts[previewConflict.id] as FieldConflictDecision
      const existing = conflictStore.get(previewConflict.id)
      const now = at
      const base: FieldConflict = {
        id: previewConflict.id,
        pairKey: previewConflict.pairKey,
        status: 'open',
        participants: previewConflict.participants,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        history: existing?.history ?? [],
      }

      // 初次导入时若已有明确归并选择，直接采纳；否则保存待归并，不写有向边。
      if (choice === 'reject-both') {
        base.status = 'resolved'
        base.resolvedAt = now
        base.decision = 'reject-both'
        base.winnerRelationId = null
        base.reason = '导入预览中归并：双方均不采纳'
      } else if (choice) {
        base.status = 'resolved'
        base.resolvedAt = now
        base.decision = choice
        base.winnerRelationId = choice
        base.reason = '导入预览中归并采纳'
      }

      if (base.status === 'resolved') {
        for (const p of base.participants) {
          const pendingMutation = mutations.get(`relations:${p.relationId}`)
          const rel = pendingMutation?.after ? (pendingMutation.after as Relation) : relationStore.get(p.relationId)
          if (!rel) continue
          const status: RelationStatus = p.relationId === base.winnerRelationId ? 'active' : 'retracted'
          const before = pendingMutation?.before ?? relationStore.get(rel.id) ?? null
          pushMutation(mutations, { table: 'relations', key: rel.id, before, after: { ...rel, status } })
        }
        base.history = [
          ...base.history,
          {
            at: now,
            decision: base.decision!,
            winnerRelationId: base.winnerRelationId,
            resolutionBatchId: batchId,
            reason: base.reason,
          },
        ]
      }

      pushMutation(mutations, { table: 'fieldConflicts', key: base.id, before: existing ?? null, after: base })
    }

    const preliminaryMutationCount = mutations.size
    if (preliminaryMutationCount === 0) return

    const ledger: FieldBatch = {
      id: ledgerId,
      sourceId: preview.batch.sourceId,
      sourceName: preview.batch.sourceName,
      fileName: pending.fileName,
      importedAt: at,
      importSequence: importSequence + 1,
      undone: false,
      recordCount: preview.batch.entries.length,
      newCount: preview.counts.new,
      duplicateCount: preview.counts.duplicate,
      revisionCount: preview.counts.revision,
      conflictCount: preview.counts.conflict,
    }
    const ledgerBefore = existingBatches.find((b) => b.id === ledger.id) ?? null
    pushMutation(mutations, { table: 'fieldBatches', key: ledger.id, before: ledgerBefore, after: ledger })
    const meaningful = [...mutations.values()]

    for (const m of mutations.values()) await applyForward(m)
    const batch: Batch = {
      id: batchId,
      kind: 'field-import',
      fieldBatchId: ledger.id,
      label: `导入现场记录：${preview.batch.sourceName}（${writable.length} 条写入）`,
      at,
      undone: false,
      mutations: meaningful,
    }
    await db.batches.put(plain(batch))
    committed = true
    committedCount = meaningful.length
  })

  state.fieldImport = null
  await refresh()
  if (committed) toast(`已原子导入现场批次：${committedCount} 项变更`)
  else toast('该批次全部为重复记录，已幂等跳过')
}

export async function confirmFieldImport(selections: FieldImportSelections) {
  try {
    await commitFieldImport(selections)
  } catch (err) {
    toast(`导入已整批回滚：${err instanceof Error ? err.message : '未知错误'}`)
  }
}

export function fieldEntryText(entry: FieldPreviewEntry | FieldRecord): string {
  return fieldDescribe(entry)
}

/* ---------- 跨来源冲突归并 ---------- */

export async function resolveFieldConflict(conflictId: string, decision: FieldConflictDecision, reason: string) {
  const conflict = state.fieldConflicts.find((c) => c.id === conflictId)
  if (!conflict || conflict.status !== 'open') return
  if (decision !== 'reject-both' && !conflict.participants.some((p) => p.relationId === decision)) {
    toast('归并选择无效')
    return
  }
  const mutations: Mutation[] = []
  const at = Date.now()
  for (const p of conflict.participants) {
    const rel = state.relations.find((r) => r.id === p.relationId)
    if (!rel) continue
    const status: RelationStatus = p.relationId === decision ? 'active' : 'retracted'
    mutations.push({ table: 'relations', key: rel.id, before: { ...rel }, after: { ...rel, status } })
  }
  const normalizedReason = reason.trim() || '（未填写归并理由）'
  const updated: FieldConflict = {
    ...conflict,
    status: 'resolved',
    resolvedAt: at,
    updatedAt: at,
    decision,
    winnerRelationId: decision === 'reject-both' ? null : decision,
    reason: normalizedReason,
  }
  const resolutionBatchId = uid()
  updated.history = [
    ...updated.history,
    { at, decision, winnerRelationId: updated.winnerRelationId, resolutionBatchId, reason: normalizedReason },
  ]
  mutations.push({ table: 'fieldConflicts', key: conflict.id, before: { ...conflict }, after: updated })

  const batch: Batch = {
    id: resolutionBatchId,
    kind: 'field-resolution',
    label: `归并现场冲突：${unitPairText(conflict.pairKey)}`,
    at,
    undone: false,
    mutations,
  }
  await db.transaction(
    'rw',
    [db.relations, db.fieldConflicts, db.batches],
    async () => {
      for (const m of mutations) await applyForward(m)
      await db.batches.put(plain(batch))
    },
  )
  await refresh()
  toast('冲突已归并，未采纳边仍作为证据保留但不进入有向图')
}

function unitPairText(pairKey: string): string {
  const [a, b] = pairKey.split('::')
  return `${unitLabel(a)} / ${unitLabel(b)}`
}

/* ---------- 现场批次撤销 ---------- */

export function fieldBatchCanUndo(ledger: FieldBatch): boolean {
  if (ledger.undone) return false
  const own = new Set(state.fieldRecords.filter((r) => r.batchId === ledger.id).map((r) => r.id))
  // 后续现场批次若修订了本批版本，必须先撤销后续批次。
  const laterRevision = state.fieldRecords.some((r) => r.status !== 'undone' && r.previousRecordId && own.has(r.previousRecordId))
  const laterConflict = state.fieldConflicts.some((c) =>
    !c.participants.every((p) => !p.recordId || own.has(p.recordId)) &&
    c.participants.some((p) => p.recordId && own.has(p.recordId)) &&
    c.status === 'resolved',
  )
  return !laterRevision && !laterConflict
}

export async function undoFieldBatch(ledgerId: string) {
  const ledger = state.fieldBatches.find((b) => b.id === ledgerId)
  if (!ledger || ledger.undone) return
  if (!fieldBatchCanUndo(ledger)) {
    toast('该现场批次之后已有修订或归并决定，请先撤销后续操作')
    return
  }

  const ownRecords = state.fieldRecords.filter((r) => r.batchId === ledgerId)
  const ownRecordIds = new Set(ownRecords.map((r) => r.id))
  const ownRelationIds = new Set(ownRecords.map((r) => r.relationId))
  const mutations: Mutation[] = []
  const tables = [
    db.units,
    db.positions,
    db.relations,
    db.evidences,
    db.retractions,
    db.fieldBatches,
    db.fieldRecords,
    db.fieldConflicts,
    db.batches,
  ]

  await db.transaction('rw', tables, async () => {
    const [records, relations, conflicts, evidences, genericBatches] = await Promise.all([
      db.fieldRecords.toArray(),
      db.relations.toArray(),
      db.fieldConflicts.toArray(),
      db.evidences.toArray(),
      db.batches.toArray(),
    ])

  const fieldImportBatchIds = new Set(
    genericBatches.filter((b) => b.kind === 'field-import' && !b.undone && b.fieldBatchId !== ledgerId).map((b) => b.id),
  )
  const previousRelationStatus = (relationId: string): Relation['status'] | undefined => {
    for (const batch of genericBatches.filter((b) => fieldImportBatchIds.has(b.id) && b.at <= ledger.importedAt).reverse()) {
      const mutation = [...batch.mutations].reverse().find((m) => m.table === 'relations' && m.key === relationId && m.after)
      if (mutation?.after) return (mutation.after as Relation).status
    }
    return undefined
  }

    // 先恢复被本批 accepted/revision 替代的旧版本。
    for (const record of records.filter((r) => ownRecordIds.has(r.id) && r.previousRecordId)) {
      const previous = records.find((r) => r.id === record.previousRecordId)
      if (!previous || previous.status === 'undone') continue
      if (previous.status === 'rejected' && !previous.replacedBy) continue
      const restoredRecord: FieldRecord = { ...previous, replacedBy: undefined, status: 'accepted' }
      mutations.push({ table: 'fieldRecords', key: previous.id, before: { ...previous }, after: restoredRecord })
      const previousRelation = relations.find((r) => r.id === previous.relationId)
      if (previousRelation) {
        const restoredStatus = previousRelationStatus(previousRelation.id)
        mutations.push({
          table: 'relations',
          key: previousRelation.id,
          before: { ...previousRelation },
          after: { ...previousRelation, status: restoredStatus ?? 'active' },
        })
      }
    }

    // 本批写入的所有记录与版本保留，仅标记撤销；这样重导同内容仍能幂等识别。
    for (const record of records.filter((r) => ownRecordIds.has(r.id))) {
      mutations.push({
        table: 'fieldRecords',
        key: record.id,
        before: { ...record },
        after: { ...record, status: 'undone' as const },
      })
    }
    for (const relation of relations.filter((r) => ownRelationIds.has(r.id))) {
      mutations.push({
        table: 'relations',
        key: relation.id,
        before: { ...relation },
        after: { ...relation, status: 'undone' as const },
      })
    }

    // 本批新建证据若没有其他记录引用则删除；现场证据可随批次整体撤销。
    const otherRefs = new Set(
      records
        .filter((r) => !ownRecordIds.has(r.id) && r.status !== 'undone')
        .flatMap((r) => r.payload.evidenceRefs.map(evidenceId)),
    )
    const ownRefs = new Set(ownRecords.flatMap((r) => r.payload.evidenceRefs.map(evidenceId)))
    for (const ev of evidences) {
      if (ownRefs.has(ev.id) && !otherRefs.has(ev.id)) {
        mutations.push({ table: 'evidences', key: ev.id, before: { ...ev }, after: null })
      }
    }

    // 本批首次产生且所有参与者均来自本批的冲突关闭；跨来源老冲突则重开并移除本批参与者。
    for (const conflict of conflicts) {
      const hasOwn = conflict.participants.some((p) => p.recordId && ownRecordIds.has(p.recordId))
      if (!hasOwn) continue
      const allOwn = conflict.participants.every((p) => !p.recordId || ownRecordIds.has(p.recordId))
      const before: FieldConflict = { ...conflict }
      if (allOwn) {
        mutations.push({
          table: 'fieldConflicts',
          key: conflict.id,
          before,
          after: { ...before, status: 'cancelled', updatedAt: Date.now() },
        })
      } else {
        const participants = before.participants.filter((p) => !p.recordId || !ownRecordIds.has(p.recordId))
        mutations.push({
          table: 'fieldConflicts',
          key: conflict.id,
          before,
          after: { ...before, status: 'open', participants, decision: undefined, winnerRelationId: undefined, resolvedAt: undefined, updatedAt: Date.now() },
        })
      }
    }

    mutations.push({
      table: 'fieldBatches',
      key: ledgerId,
      before: { ...ledger },
      after: { ...ledger, undone: true },
    })

    for (const m of mutations) await applyForward(m)
    for (const b of genericBatches.filter((b) => b.fieldBatchId === ledgerId && !b.undone)) {
      await db.batches.update(b.id, { undone: true })
    }
  })

  await refresh()
  toast(`已撤销现场批次：${ledger.fileName}`)
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
      db.fieldBatches,
      db.fieldRecords,
      db.fieldConflicts,
      db.batches,
    ],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.fieldBatches.clear(),
        db.fieldRecords.clear(),
        db.fieldConflicts.clear(),
        db.batches.clear(),
      ])
    },
  )
  state.selectedUnitId = null
  state.fieldImport = null
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
    fieldBatches: state.fieldBatches,
    fieldRecords: state.fieldRecords,
    fieldConflicts: state.fieldConflicts,
    partialOrder: reachablePairs(orderEdges.value),
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
      db.fieldBatches,
      db.fieldRecords,
      db.fieldConflicts,
      db.batches,
    ],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.fieldBatches.clear(),
        db.fieldRecords.clear(),
        db.fieldConflicts.clear(),
        db.batches.clear(),
      ])
      await db.units.bulkPut(data.units)
      await db.positions.bulkPut(data.positions ?? [])
      await db.relations.bulkPut(data.relations)
      await db.evidences.bulkPut(data.evidences ?? [])
      await db.retractions.bulkPut(data.retractions ?? [])
      await db.fieldBatches.bulkPut(data.fieldBatches ?? [])
      await db.fieldRecords.bulkPut(data.fieldRecords ?? [])
      await db.fieldConflicts.bulkPut(data.fieldConflicts ?? [])
    },
  )
  state.fieldImport = null
  await refresh()
  state.layoutVersion++
  // 偏序一致性校验：重算可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  toast(same ? `导入完成，偏序校验一致（${actual.length} 个可达对）` : '导入完成，但偏序与导出时不一致，请检查数据')
}
