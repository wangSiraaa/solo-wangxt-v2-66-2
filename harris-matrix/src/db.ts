import Dexie, { type Table } from 'dexie'
import type {
  Batch,
  Evidence,
  FieldBatch,
  FieldConflict,
  FieldRecord,
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
  fieldBatches!: Table<FieldBatch, string>
  fieldRecords!: Table<FieldRecord, string>
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
      batches: 'id, at, kind, fieldBatchId',
      fieldBatches: 'id, sourceId, importedAt, undone',
      fieldRecords: 'id, batchId, sourceId, sourceKey, relationId, status, [sourceId+sourceKey]',
      fieldConflicts: 'id, status, pairKey',
    })
  }
}

export const db = new MatrixDB()
