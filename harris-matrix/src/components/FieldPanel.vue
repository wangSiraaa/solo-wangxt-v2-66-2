<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  activeFieldBatches,
  adoptFieldVersion,
  fieldConflictVMs,
  fieldVersionChains,
  previewFieldImport,
  reopenFieldConflict,
  resolveFieldConflict,
  state,
  undoFieldBatch,
  unitLabel,
} from '../store'
import type { FieldVersion } from '../types'

const fileInput = ref<HTMLInputElement>()
const tab = ref<'conflicts' | 'batches' | 'versions'>('conflicts')

const pendingCount = computed(() => fieldConflictVMs.value.filter((c) => c.status === 'pending').length)

function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void previewFieldImport(file)
  if (fileInput.value) fileInput.value.value = ''
}

function describe(from: string, to: string, kind: string): string {
  return kind === 'earlier' ? `${unitLabel(from)} 早于 ${unitLabel(to)}` : `${unitLabel(from)} ≈ ${unitLabel(to)}（同期）`
}

function fmt(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function chooseWinner(conflictId: string, sideKey: string) {
  const reason = window.prompt('采纳该方的归并理由（败方将屏蔽/撤回并留痕，可随时重开）：')
  if (reason !== null) void resolveFieldConflict(conflictId, sideKey, reason)
}

function relKindOf(v: FieldVersion) {
  return v.kind
}

function batchOfVersion(v: FieldVersion) {
  return state.fieldBatches.find((b) => b.id === v.batchId)
}
</script>

<template>
  <section class="panel field-panel">
    <h3 class="field-head">
      现场记录导入
      <button class="sm" @click="fileInput?.click()">导入现场批次…</button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
    </h3>

    <div class="tabs">
      <button :class="{ on: tab === 'conflicts' }" @click="tab = 'conflicts'">
        待归并<span v-if="pendingCount" class="badge-count">{{ pendingCount }}</span>
      </button>
      <button :class="{ on: tab === 'batches' }" @click="tab = 'batches'">批次</button>
      <button :class="{ on: tab === 'versions' }" @click="tab = 'versions'">版本链</button>
    </div>

    <!-- 冲突归并 -->
    <div v-if="tab === 'conflicts'">
      <ul class="list">
        <li v-for="c in fieldConflictVMs" :key="c.id" class="conflict-card" :class="c.status">
          <div class="conf-title">
            <b>{{ unitLabel(c.pair[0]) }} ↔ {{ unitLabel(c.pair[1]) }}</b>
            <span class="tag" :class="c.status === 'pending' ? 'conflict' : c.status === 'resolved' ? 'observation' : 'hidden'">
              {{ c.status === 'pending' ? '待归并' : c.status === 'resolved' ? '已归并' : '已消解' }}
            </span>
          </div>
          <ul class="sides">
            <li v-for="s in c.sides" :key="s.sideKey" :class="{ winner: s.isWinner, inactive: !s.active }">
              <span class="grow">
                <span class="tag" :class="s.backing === 'field' ? 'contemp' : 'inference'">
                  {{ s.backing === 'field' ? `来源 ${s.sourceId}#${s.recordKey}` : s.sourceId }}
                </span>
                <template v-if="s.active">{{ describe(s.from, s.to, 'earlier') }}</template>
                <template v-else class="muted">（该版本已停用）</template>
                <span v-if="c.incumbentKey === s.sideKey && c.status === 'pending'" class="tag hidden">在立方</span>
                <span v-if="s.isWinner" class="tag observation">采纳</span>
              </span>
              <button
                v-if="c.status === 'pending' && s.active"
                class="sm"
                @click="chooseWinner(c.id, s.sideKey)"
              >
                采纳此方
              </button>
            </li>
          </ul>
          <details v-if="c.decisions.length">
            <summary class="muted small">归并记录（{{ c.decisions.length }}，全程留痕）</summary>
            <ul class="decisions">
              <li v-for="(d, i) in c.decisions" :key="i" class="small">
                <span :class="d.kind === 'resolved' ? 'tag observation' : 'tag conflict'">
                  {{ d.kind === 'resolved' ? '归并' : '重开' }}
                </span>
                {{ fmt(d.at) }}　{{ d.reason }}
              </li>
            </ul>
          </details>
          <button v-if="c.status === 'resolved'" class="sm reopen" @click="reopenFieldConflict(c.id)">重开归并</button>
          <p v-if="c.status === 'pending'" class="hint small">待归并期间仅在立方进入有向图，反对方已屏蔽，不会污染地层偏序。</p>
        </li>
        <li v-if="fieldConflictVMs.length === 0" class="muted">暂无跨来源冲突</li>
      </ul>
    </div>

    <!-- 批次（可按批撤销） -->
    <div v-else-if="tab === 'batches'">
      <ul class="list">
        <li v-for="b in activeFieldBatches" :key="b.id" class="batch-card">
          <span class="grow">
            <b>{{ b.fileName }}</b>
            <span class="tag contemp">{{ b.sourceId }}</span>
            <br />
            <small class="muted">
              {{ fmt(b.importedAt) }}　采纳/激活 {{ b.activeVersionIds.length }} 条，重复 {{ b.seenDuplicateIds.length }} 条
              <template v-if="b.note">　{{ b.note }}</template>
            </small>
          </span>
          <button class="sm danger" @click="undoFieldBatch(b.id)">按批撤销</button>
        </li>
        <li v-if="activeFieldBatches.length === 0" class="muted">暂无已导入批次（已撤销批次仍保留在版本链中可追溯）</li>
      </ul>
    </div>

    <!-- 版本链 -->
    <div v-else>
      <ul class="list">
        <li v-for="g in fieldVersionChains" :key="g.sourceId + g.recordKey" class="chain-card">
          <div class="chain-head">
            <span class="tag contemp">{{ g.sourceId }}</span>
            <b>#{{ g.recordKey }}</b>
          </div>
          <ol class="versions">
            <li v-for="v in g.versions" :key="v.id" :class="{ adopted: v.adopted, inactive: !v.active }">
              <span class="grow">
                {{ describe(v.from, v.to, relKindOf(v)) }}
                <span v-if="v.adopted" class="tag observation">采纳中</span>
                <span v-if="!v.active" class="tag hidden">已随批撤销</span>
                <br />
                <small class="muted">
                  采集 {{ fmt(v.collectedAt) }}　导入 {{ fmt(v.importedAt) }}
                  <template v-if="batchOfVersion(v)">· {{ batchOfVersion(v)!.fileName }}</template>
                </small>
              </span>
              <button v-if="v.active && !v.adopted" class="sm" @click="adoptFieldVersion(v.id)">采用此版</button>
            </li>
          </ol>
        </li>
        <li v-if="fieldVersionChains.length === 0" class="muted">暂无版本记录</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.tabs button {
  flex: 1;
  font-size: 12px;
  padding: 4px 6px;
  position: relative;
}
.tabs button.on {
  background: #efe7db;
  border-color: #8d7d6b;
}
.badge-count {
  display: inline-block;
  background: #c62828;
  color: #fff;
  border-radius: 9px;
  font-size: 10px;
  padding: 0 5px;
  margin-left: 3px;
}
.conflict-card.pending {
  border-color: #f0b8b0;
  background: #fdf6f5;
}
.conflict-card.resolved {
  border-color: #b7dcb9;
  background: #f6fbf6;
}
.conflict-card.obsolete {
  opacity: 0.7;
}
.conf-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.sides {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sides li {
  display: flex;
  align-items: center;
  border: 1px solid #eee;
  background: #fff;
  border-radius: 5px;
  padding: 4px 6px;
  margin-bottom: 3px;
}
.sides li.winner {
  border-color: #2e7d32;
  background: #f1f8f2;
}
.sides li.inactive {
  opacity: 0.5;
}
.decisions {
  margin: 4px 0;
  padding-left: 16px;
}
.decisions li {
  border: none;
  background: none;
  padding: 2px 0;
}
.reopen {
  margin-top: 4px;
}
.batch-card small {
  word-break: break-all;
}
.chain-card {
  flex-direction: column;
  align-items: stretch;
}
.chain-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.versions {
  margin: 0;
  padding-left: 18px;
}
.versions li {
  display: flex;
  align-items: center;
  padding: 3px 4px;
}
.versions li.adopted {
  background: #f1f8f2;
  border-color: #b7dcb9;
}
.versions li.inactive {
  opacity: 0.5;
}
.hint {
  margin: 4px 0 0;
}
</style>
