import { cyclePathIfAdded, type OrderEdge } from './graph'
import type {
  Evidence,
  FieldBatchFile,
  FieldConflict,
  FieldConflictSide,
  FieldVersion,
  Relation,
  RelationKind,
  RelationSource,
  Retraction,
  StratUnit,
} from './types'

/* ---------- 确定性 id / 指纹 ---------- */

/** 来源内记录身份键：跨来源相反关系据此区分 */
export const sideKeyOf = (sourceId: string, recordKey: string) => `${sourceId}::${recordKey}`

/** 现场记录投影到 relations 表的确定性主键（每个身份至多一条） */
export const projectedRelationId = (sourceId: string, recordKey: string) => `fr::${sourceId}::${recordKey}`

/** 版本主键：同一来源同一唯一键、内容一致时 id 相同——幂等跳过的基础 */
export const versionIdOf = (sourceId: string, recordKey: string, contentHash: string) =>
  `fv::${sourceId}::${recordKey}::${contentHash}`

/** 同一层位对的冲突行主键（无序对） */
export const conflictIdOf = (a: string, b: string) => `fc::${a < b ? a : b}::${a < b ? b : a}`

export const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

/** 归并/撤回自动生成的撤销理由前缀，用于状态重算时识别并可逆恢复 */
export const AUTO_RETRACT_PREFIX = '[归并自动]'

/** 自动撤回标记的确定性 id（每条关系至多一条） */
export const markerRetractionId = (relationId: string) => `xr::${relationId}`

/** cyrb53：纯字符串内容指纹，输出 16 进制 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0, ch = 0; i < str.length; i++) {
    ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const h = 4294967296 * (2097157 & h2) + (h1 >>> 0)
  return h.toString(16).padStart(16, '0')
}

/** 内容规范化：采集时间不参与（同一结论补采不算修订） */
export function hashContent(c: {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceRefs: string[]
  note: string
}): string {
  const canon = JSON.stringify([c.from, c.to, c.kind, c.source, [...c.evidenceRefs].sort(), c.note.trim()])
  return cyrb53(canon)
}

export function parseTime(v: string | number | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/* ---------- 解析与整批校验 ---------- */

export interface NormalizedRecord {
  index: number
  key: string
  fromId: string
  toId: string
  kind: RelationKind
  source: RelationSource
  evidenceRefs: string[]
  note: string
  collectedAt: number
  contentHash: string
  versionId: string
  /** 不阻断导入的告警（如证据出处在本库不存在） */
  warnings: string[]
}

export interface ParsedFieldBatch {
  meta: { sourceId: string; sourceName: string; note: string; collectedAt: number }
  records: NormalizedRecord[]
}

const KINDS: RelationKind[] = ['earlier', 'contemporary']
const SOURCES: RelationSource[] = ['observation', 'inference']

/**
 * 解析并整批校验：
 * 任一层位引用无法解析、结构非法、同批键重复都会以致命错误返回
 * （调用方必须放弃整批，不写入任何内容）。
 */
export function parseFieldBatch(
  raw: unknown,
  ctx: { units: StratUnit[]; evidences: Evidence[]; fileName: string },
): { ok: true; batch: ParsedFieldBatch } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const f = (raw ?? {}) as Partial<FieldBatchFile>

  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['文件内容不是 JSON 对象'] }
  if (f.app !== 'harris-matrix-field-batch') errors.push('格式标记不符：app 应为 "harris-matrix-field-batch"')
  if (f.version !== 1) errors.push('仅支持 version: 1 的现场记录批次')
  const sourceId = typeof f.sourceId === 'string' ? f.sourceId.trim() : ''
  if (!sourceId) errors.push('缺少来源编号 sourceId')
  const batchTime = parseTime(f.collectedAt)
  if (batchTime === null) errors.push('批次采集时间 collectedAt 缺失或无法解析（需 ISO 时间或毫秒时间戳）')
  if (!Array.isArray(f.records)) {
    errors.push('records 必须是数组')
    return { ok: false, errors }
  }

  const labelToId = new Map(ctx.units.map((u) => [u.label, u.id]))
  const idSet = new Set(ctx.units.map((u) => u.id))
  const refSet = new Set(ctx.evidences.map((e) => e.ref))
  const resolveUnit = (ref: unknown): string | null => {
    if (typeof ref !== 'string' || !ref.trim()) return null
    const s = ref.trim()
    if (idSet.has(s)) return s
    return labelToId.get(s) ?? null
  }

  const seenKeys = new Set<string>()
  const records: NormalizedRecord[] = []

  f.records.forEach((r0, i) => {
    const where = `第 ${i + 1} 条记录`
    const errs: string[] = []
    const r = (r0 ?? {}) as unknown as Record<string, unknown>
    const key = typeof r.key === 'string' ? r.key.trim() : ''
    if (!key) errs.push(`${where}：缺少唯一键 key`)
    else if (seenKeys.has(key)) errs.push(`${where}：唯一键 "${key}" 在本批次内重复`)
    else seenKeys.add(key)

    const fromId = resolveUnit(r.from)
    const toId = resolveUnit(r.to)
    if (fromId === null) errs.push(`${where}（key=${key || '?'}）：起点层位引用 "${String(r.from)}" 在本工程不存在`)
    if (toId === null) errs.push(`${where}（key=${key || '?'}）：终点层位引用 "${String(r.to)}" 在本工程不存在`)
    if (fromId && toId && fromId === toId) errs.push(`${where}（key=${key}）：起点与终点不能是同一层位`)

    const kind = r.kind as RelationKind
    if (!KINDS.includes(kind)) errs.push(`${where}（key=${key || '?'}）：kind 必须是 earlier 或 contemporary`)
    const source = r.source as RelationSource
    if (!SOURCES.includes(source)) errs.push(`${where}（key=${key || '?'}）：source 必须是 observation 或 inference`)

    let evidenceRefs: string[] = []
    if (r.evidenceRefs !== undefined) {
      if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.some((x) => typeof x !== 'string'))
        errs.push(`${where}（key=${key || '?'}）：evidenceRefs 必须是字符串数组`)
      else evidenceRefs = (r.evidenceRefs as string[]).map((s) => s.trim()).filter(Boolean)
    }
    const note = typeof r.note === 'string' ? r.note.trim() : ''
    const collectedAt = parseTime((r.collectedAt as string | number | undefined) ?? f.collectedAt)
    if (collectedAt === null) errs.push(`${where}（key=${key || '?'}）：采集时间无法解析`)

    if (errs.length > 0) {
      errors.push(...errs)
      return
    }
    const contentHash = hashContent({ from: fromId!, to: toId!, kind, source, evidenceRefs, note })
    records.push({
      index: i,
      key,
      fromId: fromId!,
      toId: toId!,
      kind,
      source,
      evidenceRefs,
      note,
      collectedAt: collectedAt!,
      contentHash,
      versionId: versionIdOf(sourceId, key, contentHash),
      warnings: evidenceRefs
        .filter((ref) => !refSet.has(ref))
        .map((ref) => `${where}：证据出处 "${ref}" 在本库不存在，将仅作文本保留`),
    })
  })

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    batch: {
      meta: {
        sourceId,
        sourceName: typeof f.sourceName === 'string' ? f.sourceName.trim() : '',
        note: typeof f.note === 'string' ? f.note.trim() : '',
        collectedAt: batchTime!,
      },
      records,
    },
  }
}

/* ---------- 预览：新增 / 重复 / 修订 / 冲突 ---------- */

export interface PreviewOpponent {
  sideKey: string
  sourceId: string
  recordKey: string
  backing: 'field' | 'manual'
  relationId: string
  from: string
  to: string
  note: string
}

export type PreviewChoice = 'accept' | 'keep'

export interface PreviewItem {
  /** new=新增 duplicate=重复（幂等跳过/重导再激活） revision=修订 conflict=跨来源冲突 */
  kind: 'new' | 'duplicate' | 'revision' | 'conflict'
  record: NormalizedRecord
  /** duplicate 时的既有版本 */
  existing?: FieldVersion
  /** 既有版本因批次撤销而停用时，重复导入将重新激活 */
  duplicateMode?: 'skip' | 'reactivate'
  revision?: { direction: 'upgrade' | 'downgrade'; latest: FieldVersion }
  /** upgrade 修订的用户选择：accept=接受修订，keep=维持现状（默认，更安全） */
  choice: PreviewChoice
  conflict?: { conflictId: string; opponents: PreviewOpponent[]; revision?: 'upgrade' | 'downgrade' }
}

export interface FieldSnapshot {
  versions: FieldVersion[]
  relations: Relation[]
}

/** 版本先后：采集时间优先，其次入库时间，最后 id 全序兜底（保证乱序导入仍识别最新版） */
export function newerVersion(a: FieldVersion, b: FieldVersion): number {
  if (a.collectedAt !== b.collectedAt) return a.collectedAt - b.collectedAt
  if (a.importedAt !== b.importedAt) return a.importedAt - b.importedAt
  return a.id < b.id ? -1 : 1
}

export function latestVersion(list: FieldVersion[]): FieldVersion {
  return list.reduce((m, v) => (newerVersion(v, m) > 0 ? v : m))
}

/**
 * 对解析后的批次做四分类（只读，不落库）。
 * 分类优先级：重复内容 → 跨来源相反结论冲突 → 同源修订（升级/降级）→ 新增。
 * 同一批次必属同一来源，故同批内反向不在此处判为跨来源冲突（其与存量数据
 * 的相反关系仍可被识别；双方皆新到时提交后由 discoverConflictRows 建冲突，
 * 先到者为在立方，双方均不覆盖对方）。
 */
export function buildPreview(batch: ParsedFieldBatch, snap: FieldSnapshot): PreviewItem[] {
  const byIdentity = new Map<string, FieldVersion[]>()
  const byId = new Map<string, FieldVersion>()
  for (const v of snap.versions) {
    byId.set(v.id, v)
    const k = sideKeyOf(v.sourceId, v.recordKey)
    const list = byIdentity.get(k) ?? []
    list.push(v)
    byIdentity.set(k, list)
  }

  // 当前活跃有向图中的 earlier 边（同期关联不构成相反结论）
  const activeEarlier = snap.relations.filter((r) => r.status === 'active' && r.kind === 'earlier')

  return batch.records.map((record) => {
    const identity = sideKeyOf(batch.meta.sourceId, record.key)
    const existing = byId.get(record.versionId)
    if (existing) {
      return {
        kind: 'duplicate',
        record,
        existing,
        duplicateMode: existing.active ? 'skip' : 'reactivate',
        choice: 'keep',
      }
    }

    // 跨来源相反关系：图中存在活跃 to→from 且来源不同（手工记录视为另一来源）
    const opponents: PreviewOpponent[] = []
    for (const rel of activeEarlier) {
      if (rel.from !== record.toId || rel.to !== record.fromId) continue
      const psrc = rel.provenance?.sourceId
      if (psrc === batch.meta.sourceId) continue // 同源反向 = 成环矛盾，走既有机制，不进归并
      const sideKey = psrc ? sideKeyOf(psrc, rel.provenance!.recordKey) : `manual::${rel.id}`
      opponents.push({
        sideKey,
        sourceId: psrc ?? '手工录入',
        recordKey: rel.provenance?.recordKey ?? rel.id,
        backing: psrc ? 'field' : 'manual',
        relationId: rel.id,
        from: rel.from,
        to: rel.to,
        note: rel.note,
      })
    }

    const mine = byIdentity.get(identity) ?? []
    let revision: PreviewItem['revision']
    if (mine.length > 0) {
      const latest = latestVersion(mine)
      let direction: 'upgrade' | 'downgrade'
      if (record.collectedAt === latest.collectedAt) direction = 'upgrade' // 同采集时间，新导入入库更晚
      else direction = record.collectedAt > latest.collectedAt ? 'upgrade' : 'downgrade'
      revision = { direction, latest }
    }

    if (opponents.length > 0) {
      return {
        kind: 'conflict',
        record,
        choice: 'keep',
        conflict: {
          conflictId: conflictIdOf(record.fromId, record.toId),
          opponents,
          revision: revision?.direction,
        },
      }
    }
    if (revision) {
      // 升级修订默认建议“接受修订”，但确认前用户可改为维持现状；降级补录仅归档
      const choice: PreviewChoice = revision.direction === 'upgrade' ? 'accept' : 'keep'
      return { kind: 'revision', record, choice, revision }
    }
    return { kind: 'new', record, choice: 'accept' }
  })
}

/* ---------- 提交时的冲突行归并 ---------- */

export function conflictSideFromVersion(v: FieldVersion): FieldConflictSide {
  const [a, b] = pairOf(v.from, v.to)
  return {
    sideKey: sideKeyOf(v.sourceId, v.recordKey),
    sourceId: v.sourceId,
    recordKey: v.recordKey,
    contentHash: v.contentHash,
    backing: 'field',
    direction: v.from === a && v.to === b ? 'forward' : 'reverse',
    relationId: projectedRelationId(v.sourceId, v.recordKey),
    from: v.from,
    to: v.to,
    note: v.note,
  }
}

export function manualConflictSide(rel: Relation, pair: [string, string]): FieldConflictSide {
  return {
    sideKey: `manual::${rel.id}`,
    sourceId: '手工录入',
    recordKey: rel.id,
    contentHash: '',
    backing: 'manual',
    direction: rel.from === pair[0] && rel.to === pair[1] ? 'forward' : 'reverse',
    relationId: rel.id,
    from: rel.from,
    to: rel.to,
    note: rel.note,
  }
}

/**
 * 把一批冲突方并入冲突行（不存在则建）。
 * 已归并行不会因常规 reconcile（双方仍在）被自动重开；
 * 只有 signalReopen=true（冲突曾消解、反对方重新出现）才追加 reopened 决定（原决定留痕）。
 */
export function upsertConflictRow(
  existing: FieldConflict | undefined,
  parts: { pair: [string, string]; newSides: FieldConflictSide[]; incumbentKey: string | null; signalReopen?: boolean },
  now: number,
): FieldConflict {
  const sides = existing ? [...existing.sides] : []
  for (const s of parts.newSides) {
    const idx = sides.findIndex((x) => x.sideKey === s.sideKey)
    if (idx >= 0) sides.splice(idx, 1, s)
    else sides.push(s)
  }
  const row: FieldConflict = existing
    ? { ...existing, sides, updatedAt: now }
    : {
        id: conflictIdOf(parts.pair[0], parts.pair[1]),
        pair: parts.pair,
        incumbentKey: parts.incumbentKey,
        sides,
        decisions: [],
        createdAt: now,
        updatedAt: now,
      }
  if (parts.incumbentKey && !row.incumbentKey) row.incumbentKey = parts.incumbentKey

  if (parts.signalReopen) {
    const last = row.decisions[row.decisions.length - 1]
    const dirs = new Set(sides.map((s) => s.direction))
    if (last?.kind === 'resolved' && dirs.has('forward') && dirs.has('reverse')) {
      row.decisions = [
        ...row.decisions,
        { at: now, kind: 'reopened', winnerKey: null, reason: '冲突消解后反对方记录重新出现，归并决定自动重开' },
      ]
    }
  }
  return row
}

/* ---------- 投影重算：版本链 → relations 物化（冲突不进有向图） ---------- */

/**
 * 每个身份的应采纳版本：显式 adopted 优先（用户维持现状时旧版带 adopted），
 * 否则按版本序取最新（乱序导入也安全）；停用版本一律不参与。
 */
export function selectChosenVersions(versions: FieldVersion[]): Map<string, FieldVersion> {
  const groups = new Map<string, FieldVersion[]>()
  for (const v of versions.filter((v) => v.active)) {
    const k = sideKeyOf(v.sourceId, v.recordKey)
    const list = groups.get(k) ?? []
    list.push(v)
    groups.set(k, list)
  }
  const chosen = new Map<string, FieldVersion>()
  for (const [k, list] of groups) {
    const flagged = list.filter((v) => v.adopted)
    chosen.set(k, flagged.length > 0 ? latestVersion(flagged) : latestVersion(list))
  }
  return chosen
}

/**
 * 冲突行发现（可重入，纯函数，不产生重开等副作用）：
 * 扫描应采纳的现场 earlier 版本，与其他来源的应采纳版本及活跃手工 earlier 边比对，
 * 凡同一无序层位对上双向并存且来源不同即确保有一行冲突，并同步各方内容快照。
 * 同一来源的双向是“成环矛盾”，不在此处理。归并重开由用户显式操作触发。
 *
 * incumbentHints: 导入提交时由预览给出的“在立方”（提交前已在有向图中的一方），
 * 仅用于新建冲突行；已存在的行保留原 incumbentKey。
 */
export function discoverConflictRows(input: {
  versions: FieldVersion[]
  relations: Relation[]
  existing: FieldConflict[]
  incumbentHints?: Record<string, string>
  now: number
}): FieldConflict[] {
  const { relations, existing, now } = input
  const chosen = selectChosenVersions(input.versions)
  const rows = new Map(existing.map((c) => [c.id, c]))

  interface Party {
    from: string
    to: string
    side: FieldConflictSide
  }
  const partiesByPair = new Map<string, { pair: [string, string]; parties: Party[] }>()
  const ensure = (pair: [string, string]) => {
    const id = conflictIdOf(pair[0], pair[1])
    let e = partiesByPair.get(id)
    if (!e) {
      e = { pair, parties: [] }
      partiesByPair.set(id, e)
    }
    return e
  }

  const chosenEarlier = [...chosen.values()].filter((v) => v.kind === 'earlier')
  for (const v of chosenEarlier) {
    const pair = pairOf(v.from, v.to)
    ensure(pair).parties.push({ from: v.from, to: v.to, side: conflictSideFromVersion(v) })
  }

  const pairHasField = new Set(
    chosenEarlier.map((v) => conflictIdOf(v.from, v.to)),
  )
  for (const rel of relations.filter((r) => !r.provenance && r.status === 'active' && r.kind === 'earlier')) {
    const pair = pairOf(rel.from, rel.to)
    const id = conflictIdOf(pair[0], pair[1])
    // 仅当该对上已有冲突行或存在现场方时，手工边才卷入
    if (rows.has(id) || pairHasField.has(id)) {
      ensure(pair).parties.push({ from: rel.from, to: rel.to, side: manualConflictSide(rel, pair) })
    }
  }

  for (const [id, e] of partiesByPair) {
    const dirs = new Set(
      e.parties.map((p) => (p.from === e.pair[0] && p.to === e.pair[1] ? 'forward' : 'reverse')),
    )
    if (!dirs.has('forward') || !dirs.has('reverse')) continue
    const sources = new Set(e.parties.map((p) => p.side.sourceId))
    if (sources.size < 2) continue // 同源双向 = 成环矛盾，走既有机制
    const prev = rows.get(id)
    const incumbentKey =
      prev?.incumbentKey ??
      input.incumbentHints?.[id] ??
      e.parties.find((p) => relations.find((r) => r.id === p.side.relationId)?.status === 'active')?.side
        .sideKey ??
      null
    rows.set(
      id,
      upsertConflictRow(prev, { pair: e.pair, newSides: e.parties.map((p) => p.side), incumbentKey }, now),
    )
  }
  return [...rows.values()]
}

export interface ConflictVM {
  id: string
  pair: [string, string]
  status: 'pending' | 'resolved' | 'obsolete'
  incumbentKey: string | null
  winnerKey: string | null
  sides: Array<{
    sideKey: string
    sourceId: string
    recordKey: string
    backing: 'field' | 'manual'
    direction: 'forward' | 'reverse'
    from: string
    to: string
    note: string
    active: boolean
    isWinner: boolean
  }>
  decisions: FieldConflict['decisions']
  updatedAt: number
}

export interface ProjectionPlan {
  /** 期望为 active 的投影关系（id → Relation），含重算后的成环标记 */
  desired: Map<string, Relation>
  /** 当前在位但应转为 retracted 的投影关系 id（冲突在压/败方，留痕不删版本） */
  retractProvenanceIds: string[]
  /** 既有投影关系中应整体删除的 id（身份已无任何活跃版本） */
  deleteRelationIds: string[]
  /** 需要自动撤回的手工关系（归并终局判定现场方获胜时） */
  autoRetractManual: Relation[]
  /** 需要恢复的关系 id（撤回标记对应的一方重新成为在位方） */
  restoreRelationIds: string[]
  conflicts: ConflictVM[]
  /** 被冲突屏蔽的现场身份键（调试/状态展示用） */
  suppressedSideKeys: Set<string>
}

/**
 * 根据版本链、冲突行与当前关系，纯函数计算应然投影。规则：
 * - 每个 sourceId::key 身份只物化其采纳版本；旧版本保留但不投影；
 * - 待归并冲突中仅“在立方”投影，反对方（挑战者）屏蔽——绝不进入有向图；
 * - 已归并冲突中胜方投影、败方屏蔽；手工败方走自动撤回（可恢复、留痕）；
 * - 投影边的成环标记在所有存活 earlier 边上统一重算。
 */
export function computeProjection(input: {
  versions: FieldVersion[]
  conflicts: FieldConflict[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  units: StratUnit[]
}): ProjectionPlan {
  const { versions, conflicts, relations, evidences, retractions, units } = input
  const liveUnitIds = new Set(units.map((u) => u.id))
  const chosen = new Map<string, FieldVersion>()
  for (const [k, v] of selectChosenVersions(versions)) {
    // 层位已被删除的版本不投影（版本行保留，层位重建后可再投影）
    if (liveUnitIds.has(v.from) && liveUnitIds.has(v.to)) chosen.set(k, v)
  }

  const provenanceRelations = relations.filter((r) => !!r.provenance)
  const existingById = new Map(relations.map((r) => [r.id, r]))
  const markerRetractionByRel = new Map(
    retractions.filter((x) => x.reason.startsWith(AUTO_RETRACT_PREFIX)).map((x) => [x.relationId, x]),
  )

  const suppressed = new Set<string>()
  const autoRetractManual = new Map<string, Relation>()
  const restoreRelations = new Set<string>()
  const conflictVMs: ConflictVM[] = []

  for (const c of conflicts) {
    const lastDecision = c.decisions[c.decisions.length - 1]
    // 参与方（active）：现场方=存在被采纳版本；手工方=关系存在且 active。
    // 注意不能把现场方的参与性绑定到其投影关系 status——刷新自愈时败方投影是 retracted，
    // 但归并决定仍须可据版本链恢复，否则败方会“复活”。
    const sideStates = c.sides.map((s) => {
      if (s.backing === 'field') {
        const v = chosen.get(s.sideKey)
        return {
          sideKey: s.sideKey,
          sourceId: s.sourceId,
          recordKey: s.recordKey,
          backing: 'field' as const,
          active: !!v,
          direction: v ? (v.from === c.pair[0] ? 'forward' : 'reverse') : s.direction,
          from: v?.from ?? s.from,
          to: v?.to ?? s.to,
          note: v?.note ?? s.note,
          relationId: s.relationId,
        }
      }
      const rel = existingById.get(s.relationId)
      return {
        sideKey: s.sideKey,
        sourceId: s.sourceId,
        recordKey: s.recordKey,
        backing: 'manual' as const,
        active: !!rel && rel.status === 'active',
        direction: rel ? (rel.from === c.pair[0] ? 'forward' : 'reverse') : s.direction,
        from: rel?.from ?? s.from,
        to: rel?.to ?? s.to,
        note: rel?.note ?? s.note,
        relationId: s.relationId,
      }
    })

    const dirs = new Set(sideStates.filter((s) => s.active).map((s) => s.direction))
    const opposition = dirs.has('forward') && dirs.has('reverse')
    const last = c.decisions[c.decisions.length - 1]
    const winnerState =
      last?.kind === 'resolved' ? sideStates.find((s) => s.sideKey === last.winnerKey && s.active) : undefined
    const resolved = opposition && !!winnerState && last.kind === 'resolved'
    const status: ConflictVM['status'] = !opposition ? 'obsolete' : resolved ? 'resolved' : 'pending'

    // 投影方向：已归并→胜方方向；待归并→在立方方向；已消解→不压制任何一方
    let projectDirection: 'forward' | 'reverse' | null = null
    if (resolved) projectDirection = winnerState!.direction
    else if (status === 'pending') {
      const incumbent = sideStates.find((s) => s.sideKey === c.incumbentKey)
      if (incumbent?.active) projectDirection = incumbent.direction
      else {
        // 在立方已失效（如随批撤销）：回退保留任一方向，避免双方同时进图造成自环
        const anyActive = sideStates.find((s) => s.active)
        if (anyActive) projectDirection = anyActive.direction
      }
    }

    for (const s of sideStates) {
      if (!s.active) continue
      const rel = existingById.get(s.relationId)
      if (s.backing === 'field') {
        // 与应投影方向相反的现场方一律屏蔽（desired 不生成，已在位则 retract）
        if (projectDirection && s.direction !== projectDirection) suppressed.add(s.sideKey)
      } else if (rel) {
        if (resolved && s.direction !== projectDirection) {
          if (rel.status === 'active') autoRetractManual.set(rel.id, rel)
        } else if (
          (projectDirection === s.direction || status === 'obsolete') &&
          rel.status === 'retracted' &&
          markerRetractionByRel.has(rel.id)
        ) {
          restoreRelations.add(rel.id)
        }
      }
    }

    conflictVMs.push({
      id: c.id,
      pair: c.pair,
      status,
      incumbentKey: c.incumbentKey,
      winnerKey: resolved ? last!.winnerKey : null,
      updatedAt: c.updatedAt,
      decisions: c.decisions,
      sides: sideStates.map((s) => ({
        sideKey: s.sideKey,
        sourceId: s.sourceId,
        recordKey: s.recordKey,
        backing: s.backing,
        direction: s.direction,
        from: s.from,
        to: s.to,
        note: s.note,
        active: s.active,
        isWinner: resolved && s.sideKey === last!.winnerKey,
      })),
    })
  }

  const refToEvidenceIds = new Map(evidences.map((e) => [e.ref, e.id]))
  const desired = new Map<string, Relation>()
  const retractProvenanceIds: string[] = []
  for (const [sideKey, v] of chosen) {
    const id = projectedRelationId(v.sourceId, v.recordKey)
    const old = existingById.get(id)
    if (suppressed.has(sideKey)) {
      // 从未物化过则不造关系行（版本与冲突行已足够追溯）；已在位则转 retracted 留痕
      if (old?.status === 'active') retractProvenanceIds.push(id)
      continue
    }
    desired.set(id, {
      id,
      from: v.from,
      to: v.to,
      kind: v.kind,
      source: v.source,
      status: 'active',
      conflict: false,
      evidenceIds: v.evidenceRefs.map((ref) => refToEvidenceIds.get(ref)).filter((x): x is string => !!x),
      note: v.note,
      createdAt: old?.createdAt ?? v.collectedAt,
      provenance: { sourceId: v.sourceId, recordKey: v.recordKey, contentHash: v.contentHash },
    })
    // 该身份曾被（手动/自动）撤回并留有标记：重新投影时恢复并清除标记
    if (markerRetractionByRel.has(id)) restoreRelations.add(id)
  }

  // 在全部存活 earlier 边上统一重算成环标记（仅重算投影边，手工边保留既有标记）
  const survivingManual = relations.filter(
    (r) => !r.provenance && r.status === 'active' && r.kind === 'earlier' && !autoRetractManual.has(r.id),
  )
  const allEdges: OrderEdge[] = [
    ...survivingManual.map((r) => ({ id: r.id, from: r.from, to: r.to })),
    ...[...desired.values()].filter((r) => r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to })),
  ].sort((a, b) => {
    const ta = existingById.get(a.id)?.createdAt ?? desired.get(a.id)?.createdAt ?? 0
    const tb = existingById.get(b.id)?.createdAt ?? desired.get(b.id)?.createdAt ?? 0
    return ta - tb || a.id.localeCompare(b.id)
  })
  const skeleton: OrderEdge[] = []
  for (const e of allEdges) {
    const cycle = cyclePathIfAdded(skeleton, e.from, e.to)
    if (!cycle) skeleton.push(e)
    const d = desired.get(e.id)
    if (d) d.conflict = !!cycle
  }

  const managed = new Set([...desired.keys(), ...retractProvenanceIds, ...restoreRelations])
  const deleteRelationIds = provenanceRelations.filter((r) => !managed.has(r.id)).map((r) => r.id)

  return {
    desired,
    retractProvenanceIds,
    deleteRelationIds,
    autoRetractManual: [...autoRetractManual.values()],
    restoreRelationIds: [...restoreRelations],
    conflicts: conflictVMs,
    suppressedSideKeys: suppressed,
  }
}
