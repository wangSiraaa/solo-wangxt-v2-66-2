<script setup lang="ts">
import { reactive, watch } from 'vue'
import { closeFieldImport, confirmFieldImport, state, unitLabel } from '../store'
import type { FieldConflictDecision, FieldRelationPayload } from '../types'

const selections = reactive({
  records: {} as Record<string, 'accept' | 'keep'>,
  conflicts: {} as Record<string, string>,
})

watch(
  () => state.fieldImport?.preview,
  (preview) => {
    selections.records = {}
    selections.conflicts = {}
    preview?.entries.forEach((e) => {
      if (e.decision) selections.records[e.recordId] = e.decision
    })
  },
  { immediate: true },
)

function payloadText(p: FieldRelationPayload): string {
  return p.kind === 'earlier'
    ? `${unitLabel(p.from)} 早于 ${unitLabel(p.to)}`
    : `${unitLabel(p.from)} 与 ${unitLabel(p.to)} 同期`
}

function time(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

const categoryNames = {
  new: '新增',
  duplicate: '重复',
  revision: '修订',
  conflict: '冲突',
} as const

function conflictDecisionLabel(value: string): string {
  if (value === 'reject-both') return '双方均不采纳'
  const entry = state.fieldImport?.preview.entries.find((e) => e.relationId === value)
  if (entry) return `采纳：${payloadText(entry.payload)}`
  return value
}

function submit() {
  void confirmFieldImport(selections as { records: Record<string, 'accept' | 'keep'>; conflicts: Record<string, FieldConflictDecision> })
}
</script>

<template>
  <div v-if="state.fieldImport" class="modal-mask wide" @click.self="closeFieldImport">
    <div class="modal import-modal">
      <h3>多来源现场记录导入预览</h3>
      <p class="muted small">
        {{ state.fieldImport.fileName }}　来源：{{ state.fieldImport.preview.batch.sourceName }}
        （{{ state.fieldImport.preview.batch.sourceId }}）
      </p>
      <div class="summary">
        <span class="pill new">新增 {{ state.fieldImport.preview.counts.new }}</span>
        <span class="pill duplicate">重复 {{ state.fieldImport.preview.counts.duplicate }}</span>
        <span class="pill revision">修订 {{ state.fieldImport.preview.counts.revision }}</span>
        <span class="pill conflict">冲突 {{ state.fieldImport.preview.counts.conflict }}</span>
        <span v-if="state.fieldImport.preview.newEvidenceRefs.length" class="muted small">
          新证据 {{ state.fieldImport.preview.newEvidenceRefs.length }} 条
        </span>
      </div>

      <div class="preview-scroll">
        <template v-for="group of ['new', 'revision', 'conflict', 'duplicate']" :key="group">
          <section
            v-if="state.fieldImport.preview.entries.some((e) => e.category === group)"
            class="preview-group"
          >
            <h4>{{ categoryNames[group] }}</h4>
            <ul>
              <li v-for="entry in state.fieldImport.preview.entries.filter((e) => e.category === group)" :key="entry.recordId">
                <div class="entry-head">
                  <b>{{ payloadText(entry.payload) }}</b>
                  <span class="tag observation">{{ entry.payload.source === 'observation' ? '观察' : '推断' }}</span>
                </div>
                <p class="muted small">
                  {{ entry.sourceKey }}　采集：{{ time(entry.collectedAt) }}
                  <br />{{ entry.reason }}
                </p>

                <div v-if="entry.baseCategory === 'revision'" class="choices">
                  <label>
                    <input type="radio" :value="'keep'" v-model="selections.records[entry.recordId]" />
                    维持现状（保留旧版本）
                  </label>
                  <label>
                    <input type="radio" :value="'accept'" v-model="selections.records[entry.recordId]" />
                    接受修订（旧版标记为 superseded）
                  </label>
                </div>

                <div v-if="entry.baseCategory === 'new' && entry.category !== 'conflict'" class="choices">
                  <label><input type="radio" value="accept" v-model="selections.records[entry.recordId]" /> 采纳</label>
                  <label><input type="radio" value="keep" v-model="selections.records[entry.recordId]" /> 暂不采纳</label>
                </div>
              </li>
            </ul>
          </section>
        </template>

        <section v-if="state.fieldImport.preview.conflicts.length" class="preview-group conflict-box">
          <h4>待归并冲突</h4>
          <p class="muted small">冲突参与者在归并前均不写入有向图；已有活跃关系会保留到做出归并决定。</p>
          <ul>
            <li v-for="c in state.fieldImport.preview.conflicts" :key="c.id">
              <div class="entry-head">
                <b>{{ unitLabel(c.pairKey.split('::')[0]) }} ⇄ {{ unitLabel(c.pairKey.split('::')[1]) }}</b>
                <span v-if="c.reopened" class="tag conflict">重新打开</span>
              </div>
              <label v-for="p in c.participants" :key="p.relationId" class="choice-line">
                <input type="radio" :name="c.id" :value="p.relationId" v-model="selections.conflicts[c.id]" />
                {{ p.sourceName }} · {{ p.sourceKey }}：{{ unitLabel(p.from) }} → {{ unitLabel(p.to) }}
              </label>
              <label class="choice-line">
                <input type="radio" :name="c.id" value="reject-both" v-model="selections.conflicts[c.id]" />
                双方均不采纳
              </label>
              <p class="muted small">当前：{{ conflictDecisionLabel(selections.conflicts[c.id] ?? '待归并（可先保存）') }}</p>
            </li>
          </ul>
        </section>
      </div>

      <div class="modal-actions">
        <button @click="closeFieldImport">取消</button>
        <button class="primary" @click="submit">原子确认导入</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask.wide {
  z-index: 25;
}
.import-modal {
  width: 780px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
.summary {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.pill {
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 12px;
  border: 1px solid;
}
.pill.new { color: #2e7d32; border-color: #9ccc65; }
.pill.duplicate { color: #777; border-color: #bbb; }
.pill.revision { color: #ef6c00; border-color: #ffb74d; }
.pill.conflict { color: #c62828; border-color: #ef9a9a; }
.pill.old { color: #607d8b; border-color: #90a4ae; }
.preview-scroll {
  overflow-y: auto;
  min-height: 120px;
  border-top: 1px solid #eee;
}
.preview-group h4 {
  margin: 12px 0 6px;
  font-size: 13px;
}
.preview-group ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-group li {
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 7px 9px;
  background: #fdfcfa;
}
.entry-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.entry-head p {
  margin: 3px 0;
}
.choices {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  margin-top: 4px;
}
.choice-line {
  display: block;
  margin: 4px 0;
  font-size: 12px;
}
.conflict-box {
  border: 1px solid #ef9a9a;
  background: #fff8f8;
  padding: 8px;
  border-radius: 8px;
  margin-top: 10px;
}
.primary {
  border-color: #2e7d32;
  color: #2e7d32;
}
</style>
