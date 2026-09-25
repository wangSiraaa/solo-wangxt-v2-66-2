/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断 */
export type RelationSource = 'observation' | 'inference'

/**
 * active：已采纳，同期关系可显示；只有 active + earlier 进入有向图。
 * retracted：人工撤回或归并时明确不采纳；superseded：已被同来源新版本替代；
 * conflicted：跨来源待归并；undone：所属导入批次已撤销（版本仍保留供幂等识别）。
 */
export type RelationStatus = 'active' | 'retracted' | 'superseded' | 'conflicted' | 'undone'

/** 地层身份：与画布位置完全分离 */
export interface StratUnit {
  id: string
  label: string
  type: UnitType
  note: string
  createdAt: number
}

/** 画布位置：独立成表，删除/修改不影响地层身份 */
export interface UnitPosition {
  unitId: string
  x: number
  y: number
}

export interface Relation {
  id: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  status: RelationStatus
  /** 与既有记录构成环时被标记为矛盾记录（仍保留为证据） */
  conflict: boolean
  evidenceIds: string[]
  note: string
  createdAt: number
}

/** 原始证据：日记页码、照片号、剖面图编号等，仅保存在本地 IndexedDB */
export interface Evidence {
  id: string
  ref: string
  text: string
  createdAt: number
}

/** 被撤销的判断：单独成表保存快照与理由，不混入活跃关系 */
export interface Retraction {
  id: string
  relationId: string
  snapshot: Relation
  reason: string
  at: number
}

/** 多来源现场记录中的一条关系结论（内容指纹不包含来源、唯一键和采集时间） */
export interface FieldRelationPayload {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  note: string
  evidenceRefs: string[]
}

export type FieldRecordStatus = 'accepted' | 'rejected' | 'pending' | 'undone'

/** 同一来源同一唯一键的一个现场记录版本 */
export interface FieldRecord {
  id: string
  batchId: string
  sourceId: string
  sourceName: string
  sourceKey: string
  collectedAt: number
  importedAt: number
  contentHash: string
  payload: FieldRelationPayload
  relationId: string
  status: FieldRecordStatus
  /** 修订导入时所基于的同来源同唯一键旧版本 */
  previousRecordId?: string
  /** 被哪个新版本替代；撤销导入时据此恢复旧版本 */
  replacedBy?: string
}

/** 一次现场 JSON 导入的批次台账 */
export interface FieldBatch {
  id: string
  sourceId: string
  sourceName: string
  fileName: string
  importedAt: number
  /** 同一文件重复导入时递增；整文件内容全重复仍幂等不写台账 */
  importSequence: number
  undone: boolean
  recordCount: number
  newCount: number
  duplicateCount: number
  revisionCount: number
  conflictCount: number
}

export interface FieldConflictParticipant {
  sourceId: string
  sourceName: string
  sourceKey: string
  recordId?: string
  relationId: string
  from: string
  to: string
  collectedAt: number
}

export type FieldConflictStatus = 'open' | 'resolved' | 'cancelled'
export type FieldConflictDecision = string | 'reject-both'

/** 不同来源对同一层位对给出相反结论；归并前任何待裁决边都不进入有向图 */
export interface FieldConflict {
  id: string
  pairKey: string
  status: FieldConflictStatus
  participants: FieldConflictParticipant[]
  createdAt: number
  updatedAt: number
  resolvedAt?: number
  decision?: FieldConflictDecision
  winnerRelationId?: string | null
  resolutionBatchId?: string
  reason?: string
  history: Array<{
    at: number
    decision: FieldConflictDecision
    winnerRelationId?: string | null
    resolutionBatchId: string
    reason?: string
  }>
}

export type TableName =
  | 'units'
  | 'positions'
  | 'relations'
  | 'evidences'
  | 'retractions'
  | 'fieldBatches'
  | 'fieldRecords'
  | 'fieldConflicts'

/** 通用变更记录：before/after 支持正向应用与逆向撤销 */
export interface Mutation {
  table: TableName
  key: string
  before: unknown | null
  after: unknown | null
}

export type BatchKind = 'manual' | 'field-import' | 'field-resolution'

/** 一批操作（可整体撤销） */
export interface Batch {
  id: string
  kind: BatchKind
  fieldBatchId?: string
  label: string
  at: number
  undone: boolean
  mutations: Mutation[]
}

export interface RelationDraft {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceIds: string[]
  note: string
}

/** 现场记录批次 JSON */
export interface FieldBatchFile {
  app: 'harris-matrix-field-batch'
  version: 1
  sourceId: string
  sourceName?: string
  exportedAt?: string
  records: Array<{
    key: string
    collectedAt: string
    relation: {
      from: string
      to: string
      kind: RelationKind
      source?: RelationSource
      note?: string
      evidenceRefs?: string[]
    }
  }>
}

/** 导出文件格式：携带偏序闭包用于导入校验 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 1
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  fieldBatches: FieldBatch[]
  fieldRecords: FieldRecord[]
  fieldConflicts: FieldConflict[]
  /** 活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
}
