import type { Evidence, Relation, Retraction, StratUnit } from './types'
import { cyclePathIfAdded, type OrderEdge } from './graph'

/**
 * 示例工程：一处含基槽切割、灰坑切割的堆积序列。
 * 故意包含：切割事件、孤立层位（1018）、互相矛盾的观察记录、一条已撤销的推断。
 */
export function buildSample(now: number): {
  units: StratUnit[]
  evidences: Evidence[]
  relations: Relation[]
  retractions: Retraction[]
} {
  const units: StratUnit[] = [
    { id: '1001', label: '1001', type: 'deposit', note: '现代表土层', createdAt: now },
    { id: '1003', label: '1003', type: 'deposit', note: '冲积淤积层', createdAt: now },
    { id: '1005', label: '1005', type: 'fill', note: '基槽填土', createdAt: now },
    { id: '1006', label: '1006', type: 'cut', note: '基槽切割（切割事件）', createdAt: now },
    { id: '1007', label: '1007', type: 'interface', note: '被切割的居住面', createdAt: now },
    { id: '1009', label: '1009', type: 'fill', note: '灰坑填土', createdAt: now },
    { id: '1010', label: '1010', type: 'cut', note: '灰坑切割（切割事件）', createdAt: now },
    { id: '1012', label: '1012', type: 'deposit', note: '陶片富集层', createdAt: now },
    { id: '1015', label: '1015', type: 'interface', note: '踩踏面', createdAt: now },
    { id: '1018', label: '1018', type: 'deposit', note: '孤立层位：探方东南角，关系未明', createdAt: now },
  ]

  const evidences: Evidence[] = [
    { id: 'E1', ref: '田野日记·第12页', text: '1003 淤积层被 1001 表土直接覆盖，界面清晰。', createdAt: now },
    { id: 'E2', ref: '剖面图 S-04', text: '基槽 1006 切穿居住面 1007，槽内填土 1005。', createdAt: now },
    { id: 'E3', ref: '照片 IMG_2031', text: '灰坑 1010 剖面：坑口切过陶片层 1012，坑内填土 1009。', createdAt: now },
    { id: 'E4', ref: '记录员乙·地层卡#7', text: '乙认为灰坑填土 1009 早于陶片层 1012（与剖面观察矛盾）。', createdAt: now },
  ]

  // [from, to, kind, source, evidenceIds, note]
  const raw: Array<[string, string, Relation['kind'], Relation['source'], string[], string]> = [
    ['1003', '1001', 'earlier', 'observation', ['E1'], '淤积层被表土覆盖'],
    ['1007', '1003', 'earlier', 'observation', ['E1'], '居住面被淤积层覆盖'],
    ['1007', '1006', 'earlier', 'observation', ['E2'], '基槽切割居住面，切割更晚'],
    ['1006', '1005', 'earlier', 'observation', ['E2'], '填土晚于切割本身'],
    ['1005', '1003', 'earlier', 'inference', ['E2'], '推断：基槽填土被淤积层覆盖'],
    ['1012', '1010', 'earlier', 'observation', ['E3'], '灰坑切割陶片层'],
    ['1010', '1009', 'earlier', 'observation', ['E3'], '坑内填土晚于坑的切割'],
    ['1009', '1003', 'earlier', 'inference', [], '推断：灰坑填土被淤积层覆盖'],
    ['1012', '1015', 'contemporary', 'observation', ['E3'], '陶片层与踩踏面为同期活动面（无向关联）'],
    // 矛盾记录：与 1012→1010→1009 构成环
    ['1009', '1012', 'earlier', 'observation', ['E4'], '记录员乙：灰坑填土早于陶片层'],
    // 将被撤销的推断
    ['1015', '1003', 'earlier', 'inference', [], '推断：踩踏面被淤积层覆盖'],
  ]

  const relations: Relation[] = []
  const edges: OrderEdge[] = []
  raw.forEach(([from, to, kind, source, evidenceIds, note], i) => {
    let conflict = false
    if (kind === 'earlier') {
      conflict = cyclePathIfAdded(edges, from, to) !== null
      edges.push({ id: `R${i + 1}`, from, to })
    }
    relations.push({
      id: `R${i + 1}`,
      from,
      to,
      kind,
      source,
      status: 'active',
      conflict,
      evidenceIds,
      note,
      createdAt: now + i,
    })
  })

  // 撤销最后一条推断，并留下独立的撤销记录
  const retracted = relations[relations.length - 1]
  const snapshot: Relation = { ...retracted }
  retracted.status = 'retracted'
  const retractions: Retraction[] = [
    {
      id: 'X1',
      relationId: retracted.id,
      snapshot,
      reason: '剖面复核后 1015 与 1003 的叠压关系不明，撤回该推断。',
      at: now + 100,
    },
  ]

  return { units, evidences, relations, retractions }
}
