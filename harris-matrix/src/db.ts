import Dexie, { type Table } from 'dexie'
import type {
  Batch,
  Evidence,
  FieldBatch,
  FieldConflict,
  FieldVersion,
  Relation,
  Retraction,
  StratUnit,
  UnitPosition,
} from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）分开保存。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  retractions!: Table<Retraction, string>
  batches!: Table<Batch, string>
  /** 现场记录导入批次（按来源编号，可按批次撤销） */
  fieldBatches!: Table<FieldBatch, string>
  /** 现场记录版本链（sourceId+key+contentHash 确定性主键，旧版本保留不覆盖） */
  fieldVersions!: Table<FieldVersion, string>
  /** 跨来源相反结论的待归并冲突与决定历史 */
  fieldConflicts!: Table<FieldConflict, string>

  constructor() {
    super('harris-matrix')
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    this.version(2).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
      fieldBatches: 'id, sourceId, importedAt',
      fieldVersions: 'id, sourceId, recordKey, batchId, active, adopted',
      fieldConflicts: 'id',
    })
  }
}

export const db = new MatrixDB()
