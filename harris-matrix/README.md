# 地层矩阵编辑台（Harris Matrix Workbench）

纯浏览器运行的考古地层矩阵编辑工具：Vue 3 + TypeScript，Graphology 管理有向关系，
Cytoscape.js 绘制矩阵，Dexie(IndexedDB) 本地持久化。**不发生任何网络上传**，现场资料只存于本机浏览器。

## 运行

```bash
npm install
npm run dev          # 开发
npm run build        # 产出静态文件到 dist/，可离线部署
npm run test:field   # 多来源现场记录增量导入的验收测试（fake-indexeddb，无需浏览器）
```

## 数据模型要点

- **身份与位置分离**：层位（`units`）与画布坐标（`positions`）分表存储，拖动/自动排布不影响地层身份。
- **三类记录分开保存**：原始观察与推断（`relations.source`）、被撤销判断（`retractions` 表，含快照与理由）。
- **同期关联不是有向边**：`contemporary` 关系只存档、以紫色虚线显示，绝不进入 Graphology 有向图与偏序闭包。
- **成环检测**：新增“早于”关系时，若 `to→…→from` 已有路径则构成环，对话框给出完整环路径，
  记录员可取消或保留为矛盾记录（红色虚线，不删除任何原始观察）。
- **矩阵简化只隐藏**：简化视图通过传递约简隐藏冗余边（如 1007→1003 被 1007→1006→1005→1003 蕴含），原始记录全部保留。
- **批次撤销**：每次操作登记为含逆变更的批次（`batches` 表），撤销整批回滚——关系、证据引用、撤销记录一起恢复。
- **导出/导入**：JSON 文件携带偏序闭包（可达对列表），导入后重算比对，偏序不一致会明确告警。

## 多来源现场记录增量导入

侧边栏「现场记录导入 → 导入现场批次…」读取带**来源编号、采集时间、记录唯一键**的 JSON 批次
（示例见 `samples/field-batch-jia.json` / `samples/field-batch-yi.json`）。

### 批次格式

```json
{
  "app": "harris-matrix-field-batch",
  "version": 1,
  "sourceId": "T0304-JIA",
  "sourceName": "探方 T0304 记录员甲",
  "collectedAt": "2026-09-20T08:30:00+08:00",
  "records": [
    {
      "key": "obs-001",
      "from": "1003",
      "to": "1001",
      "kind": "earlier",
      "source": "observation",
      "collectedAt": "2026-09-20T08:35:00+08:00",
      "evidenceRefs": ["田野日记·第12页"],
      "note": "可选"
    }
  ]
}
```

- `from`/`to` 填层位编号（label）或内部 id；`key` 在同一 `sourceId` 内稳定，**修订沿用同一 key**。
- `kind=contemporary` 同期关联只存档，不进有向图。采集时间参与版本先后，**不参与内容指纹**。

### 四类预览（确认前只读展示，不落库）

| 类别 | 判定 | 处理 |
| --- | --- | --- |
| 新增 | 来源+key 首次出现 | 直接采纳并投影 |
| 重复 | 同来源同 key 且**内容指纹一致** | 幂等跳过；若旧版本因撤销停用则重导再激活 |
| 修订 | 同来源同 key 但内容变化 | 旧版本保留不覆盖；升级默认建议接受，可选「维持现状」；降级补录只归档 |
| 冲突 | **不同来源**对同一层位对给出相反 earlier 结论 | 进入待归并：在立方保留在有向图，反对方版本留存但投影屏蔽 |

### 关键不变量

- **原子写入**：一次确认的版本、批次、冲突行、投影关系全部在同一个 IndexedDB 事务内提交；
  任一层位引用非法（或结构非法、同批 key 重复）在解析阶段整批拒绝，失败自动回滚，**不留半批数据**。
- **冲突不污染有向图**：待归并期间反对方不物化进 Graphology；归并后胜方投影、败方屏蔽（手工败方自动撤回并留痕，可恢复）。
  归并决定（含理由、时间、重开历史）写入 `fieldConflicts`，全程可追溯。
- **版本可乱序到达**：以采集时间为主、入库时间为序判定最新；先导新版后补旧版，最终仍采纳最新修订。
- **按批次撤销**：每个确认批次可整体撤销（停用其版本并重算投影）；之后重导同一文件按同一版本规则再激活，不产生重复版本行。
- **刷新可恢复**：启动时按持久化的批次、版本链、归并决定、撤销标记自愈重算投影；关闭重开浏览器后状态一致。

### 现场数据三表（DB v2）

- `fieldBatches`：导入批次（来源、文件名、激活/重复版本 id、`undone`）。
- `fieldVersions`：`sourceId+key+contentHash` 确定性主键的版本链，`active`/`adopted` 分离“是否有效”与“是否采纳”。
- `fieldConflicts`：按无序层位对去重的冲突行，含各方快照与归并决定历史。
- 投影到既有 `relations` 表的关系带 `provenance`，id 形如 `fr::{sourceId}::{key}`，每身份至多一条。

## 示例工程

「载入示例」包含：基槽/灰坑两处**切割事件**（切割晚于被切层、填土晚于切割）、
**孤立层位** 1018（紫色虚线框）、1012 与 1015 的**同期关联**、
记录员乙与剖面观察**互相矛盾的记录**（1009↔1012 成环标红）、以及一条**已撤销的推断**。

## 目录

```
src/graph.ts   Graphology 封装：成环路径、传递约简、偏序闭包、分层排布
src/store.ts   状态与业务：批次撤销、导入导出、偏序校验、现场批次提交/归并/撤销/自愈
src/field.ts   现场批次：解析校验、四类预览、版本序、冲突行发现与投影重算（纯函数）
src/db.ts      Dexie/IndexedDB 九张表（v2 增加 fieldBatches/fieldVersions/fieldConflicts）
src/sample.ts  示例工程
test/          多来源增量导入的验收测试
src/components/MatrixCanvas.vue  Cytoscape 画布
src/components/FieldPanel.vue    现场批次：待归并冲突 / 批次撤销 / 版本链
src/components/FieldImportModal.vue  导入前四类预览与确认
```
