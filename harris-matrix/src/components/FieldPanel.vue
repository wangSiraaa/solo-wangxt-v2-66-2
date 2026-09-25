<script setup lang="ts">
import { ref } from 'vue'
import {
  fieldBatchCanUndo,
  openFieldConflicts,
  resolveFieldConflict,
  state,
  undoFieldBatch,
  unitLabel,
} from '../store'
import type { FieldConflict, FieldConflictDecision } from '../types'

const resolve = ref<Record<string, FieldConflictDecision | ''>>({})
const reason = ref('')

function describeRelation(relationId: string): string {
  const r = state.relations.find((x) => x.id === relationId)
  if (!r) return relationId
  return r.kind === 'earlier' ? `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}` : `${unitLabel(r.from)} ≈ ${unitLabel(r.to)}`
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

async function submitResolve(c: FieldConflict) {
  const decision = resolve.value[c.id]
  if (!decision) return
  await resolveFieldConflict(c.id, decision, reason.value)
  resolve.value[c.id] = ''
  reason.value = ''
}

function participantLabel(c: FieldConflict, relationId: string | null | undefined): string {
  if (!relationId) return '双方均不采纳'
  const p = c.participants.find((x) => x.relationId === relationId)
  return p ? `${p.sourceName} · ${p.sourceKey}：${describeRelation(relationId)}` : describeRelation(relationId)
}
</script>

<template>
  <section class="panel">
    <h3>待归并现场冲突（{{ openFieldConflicts.length }}）</h3>
    <ul class="list">
      <li v-for="c in openFieldConflicts" :key="c.id" class="conflict-item">
        <span class="grow">
          <b>{{ unitLabel(c.pairKey.split('::')[0]) }} ⇄ {{ unitLabel(c.pairKey.split('::')[1]) }}</b>
          <div v-for="p in c.participants" :key="p.relationId" class="choice">
            <label>
              <input type="radio" :name="c.id" :value="p.relationId" v-model="resolve[c.id]" />
              {{ p.sourceName }} · {{ p.sourceKey }}：{{ describeRelation(p.relationId) }}
            </label>
          </div>
          <label class="choice">
            <input type="radio" :name="c.id" value="reject-both" v-model="resolve[c.id]" />
            双方均不采纳
          </label>
          <input v-model="reason" placeholder="归并理由（可追溯）" />
          <button class="sm" :disabled="!resolve[c.id]" @click="submitResolve(c)">确认归并</button>
        </span>
      </li>
      <li v-if="openFieldConflicts.length === 0" class="muted">暂无跨来源相反关系</li>
    </ul>
  </section>

  <section class="panel">
    <h3>现场记录批次（{{ state.fieldBatches.length }}）</h3>
    <ul class="list">
      <li v-for="b in [...state.fieldBatches].reverse()" :key="b.id" :class="{ undone: b.undone }">
        <span class="grow">
          {{ b.sourceName }} · {{ b.fileName }}
          <span v-if="b.undone" class="tag hidden">已撤销</span>
          <br />
          <small class="muted">
            {{ fmtTime(b.importedAt) }}　新增 {{ b.newCount }} / 重复 {{ b.duplicateCount }} / 修订
            {{ b.revisionCount }} / 冲突 {{ b.conflictCount }}
          </small>
        </span>
        <button
          class="sm danger"
          :disabled="b.undone || !fieldBatchCanUndo(b)"
          :title="b.undone ? '已撤销' : fieldBatchCanUndo(b) ? '撤销本批采纳记录' : '后续已有修订或归并决定'"
          @click="undoFieldBatch(b.id)"
        >
          撤销批次
        </button>
      </li>
      <li v-if="state.fieldBatches.length === 0" class="muted">尚未导入现场批次</li>
    </ul>
  </section>

  <section v-if="state.fieldConflicts.some((c) => c.status !== 'open')" class="panel">
    <h3>归并历史</h3>
    <ul class="list">
      <li v-for="c in state.fieldConflicts.filter((x) => x.status !== 'open').slice(0, 8)" :key="c.id" :class="{ cancelled: c.status === 'cancelled' }">
        <span class="grow small">
          {{ unitLabel(c.pairKey.split('::')[0]) }} / {{ unitLabel(c.pairKey.split('::')[1]) }}：
          {{ c.status === 'cancelled' ? '随批次撤销关闭' : participantLabel(c, c.winnerRelationId) }}
          <br /><small class="muted">{{ c.reason }}</small>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.conflict-item {
  align-items: flex-start;
}
.choice {
  display: block;
  margin: 4px 0;
  font-size: 12px;
}
.choice input[type='radio'] {
  width: auto;
}
.cancelled {
  opacity: 0.65;
}
.undone {
  text-decoration: line-through;
  opacity: 0.6;
}
</style>
