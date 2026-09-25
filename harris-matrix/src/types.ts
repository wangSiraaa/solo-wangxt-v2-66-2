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
}
