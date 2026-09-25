/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断 */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

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
  /** 现场记录投影来源：含此标记的关系由 fieldVersions 物化生成，可被整体重算 */
  provenance?: { sourceId: string; recordKey: string; contentHash: string }
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

export type TableName = 'units' | 'positions' | 'relations' | 'evidences' | 'retractions'

/** 通用变更记录：before/after 支持正向应用与逆向撤销 */
export interface Mutation {
  table: TableName
  key: string
  before: unknown | null
  after: unknown | null
}

/** 一批操作（可整体撤销） */
export interface Batch {
  id: string
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
  /** 活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
  /** 多来源现场记录：批次、版本链、待归并冲突（v1 导出可选，旧文件缺省为空） */
  fieldBatches?: FieldBatch[]
  fieldVersions?: FieldVersion[]
  fieldConflicts?: FieldConflict[]
}

/* ===================== 多来源现场记录增量导入 ===================== */

/** 批次中的单条现场记录（导入文件内的原始形态） */
export interface FieldRecordPayload {
  /** 记录唯一键：在同一来源内唯一且稳定（修订记录沿用同一 key） */
  key: string
  /** 关系起点层位：填层位编号(label)或内部 id，必须能解析到既有层位 */
  from: string
  /** 关系终点层位 */
  to: string
  kind: RelationKind
  source: RelationSource
  /** 证据出处引用（按 ref 文本匹配既存证据；证据不会随导入新建） */
  evidenceRefs?: string[]
  note?: string
  /** 采集时间（ISO 字符串或毫秒时间戳）；缺省回退批次 collectedAt */
  collectedAt?: string | number
}

/**
 * 现场记录 JSON 批次格式。
 * 文件名由记录员自选，来源身份以文件内 sourceId 为准（保证重复导入同一文件可幂等识别）。
 */
export interface FieldBatchFile {
  app: 'harris-matrix-field-batch'
  version: 1
  /** 来源编号：如 T0304-乙 / 剖面S-04 / 探方日记，跨来源冲突据此追溯 */
  sourceId: string
  /** 来源说明（可选），仅作展示 */
  sourceName?: string
  /** 批次采集时间：记录缺省 collectedAt 时回退使用 */
  collectedAt: string | number
  /** 批次说明（可选） */
  note?: string
  records: FieldRecordPayload[]
}

/** 一条记录的一个内容版本（同一 sourceId+key 可有多个，旧版本永不覆盖） */
export interface FieldVersion {
  /** 确定性 id：fv::{sourceId}::{key}::{contentHash}，同内容重复导入天然幂等 */
  id: string
  sourceId: string
  recordKey: string
  /** 内容指纹：from/to/kind/source/evidenceRefs/note 的规范化哈希（不含采集时间） */
  contentHash: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceRefs: string[]
  note: string
  /** 采集时间：版本先后的首要依据 */
  collectedAt: number
  /** 入库时间：采集时间相同时的次序依据 */
  importedAt: number
  /** 所属现场批次（用于按批次撤销） */
  batchId: string
  /** 对应批次是否已撤销（撤销即停用该版本；版本行本身保留，重导可再激活） */
  active: boolean
  /** 是否为采纳版本（手动接受修订 / 自动采纳）；维持现状时新版本存在但不采纳 */
  adopted: boolean
}

/** 现场导入批次：一次确认生成一批，可整体撤销 */
export interface FieldBatch {
  id: string
  sourceId: string
  sourceName: string
  note: string
  collectedAt: number
  importedAt: number
  /** 文件名（展示用） */
  fileName: string
  /** 该批次确认后处于活跃状态的版本 id（撤销时停用） */
  activeVersionIds: string[]
  /** 该批次曾带出但确认时已存在、随后在撤销本批时无需停用的重复版本 id 仅留痕 */
  seenDuplicateIds: string[]
  undone: boolean
}

/** 归并冲突中的一方 */
export interface FieldConflictSide {
  sideKey: string
  sourceId: string
  recordKey: string
  contentHash: string
  /** manual 表示库中既有的手工/工程记录；field 表示现场记录版本 */
  backing: 'field' | 'manual'
  direction: 'forward' | 'reverse'
  relationId: string
  from: string
  to: string
  note: string
}

export type FieldConflictDecisionKind = 'resolved' | 'reopened'

/** 归并决定（全程留痕，可追溯，刷新后恢复） */
export interface FieldConflictDecision {
  at: number
  kind: FieldConflictDecisionKind
  /** 获胜方 sideKey；reopened 时为 null */
  winnerKey: string | null
  reason: string
}

/**
 * 跨来源对同一层位对的相反“早于”结论。
 * 不直接覆盖任何关系；待归并期间反对方在投影层被屏蔽，绝不进入有向图。
 */
export interface FieldConflict {
  /** 确定性 id：fc::{minUnitId}::{maxUnitId}，同一层位对只保留一行并持续追加各方 */
  id: string
  pair: [string, string]
  /** 导入时已在有向图中的一方（挑战者被屏蔽）；双方同批新到则为 null（先到者在位） */
  incumbentKey: string | null
  sides: FieldConflictSide[]
  decisions: FieldConflictDecision[]
  createdAt: number
  updatedAt: number
}
