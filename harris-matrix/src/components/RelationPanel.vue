<script setup lang="ts">
import { computed, reactive } from 'vue'
import { activeRelations, addRelation, evidenceRef, redundantIds, retractRelation, state, unitLabel } from '../store'
import type { Relation, RelationKind, RelationSource } from '../types'

const form = reactive({
  from: '',
  to: '',
  kind: 'earlier' as RelationKind,
  source: 'observation' as RelationSource,
  evidenceIds: [] as string[],
  note: '',
})

const sourceNames: Record<RelationSource, string> = { observation: '观察', inference: '推断' }

const sortedActive = computed(() => activeRelations.value)

function describe(r: Relation): string {
  return r.kind === 'earlier'
    ? `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}`
    : `${unitLabel(r.from)} ≈ ${unitLabel(r.to)}（同期）`
}

function isHidden(r: Relation): boolean {
  return state.viewMode === 'simplified' && redundantIds.value.has(r.id)
}

async function submit() {
  await addRelation({ ...form })
  form.note = ''
  form.evidenceIds = []
}

function retract(r: Relation) {
  const reason = window.prompt(`撤回「${describe(r)}」的理由：`)
  if (reason !== null) void retractRelation(r.id, reason)
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <section class="panel">
    <h3>新增关系</h3>
    <form class="form" @submit.prevent="submit">
      <div class="row">
        <select v-model="form.from" required>
          <option value="" disabled>起点层位</option>
          <option v-for="u in state.units" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
        <select v-model="form.kind">
          <option value="earlier">早于（有向）</option>
          <option value="contemporary">同期（无向）</option>
        </select>
        <select v-model="form.to" required>
          <option value="" disabled>终点层位</option>
          <option v-for="u in state.units" :key="u.id" :value="u.id">{{ u.label }}</option>
        </select>
      </div>
      <div class="row">
        <label><input type="radio" value="observation" v-model="form.source" /> 原始观察</label>
        <label><input type="radio" value="inference" v-model="form.source" /> 推断</label>
      </div>
      <div v-if="state.evidences.length" class="ev-pick">
        <label v-for="e in state.evidences" :key="e.id">
          <input type="checkbox" :value="e.id" v-model="form.evidenceIds" /> {{ e.ref }}
        </label>
      </div>
      <input v-model="form.note" placeholder="备注（可选）" />
      <button type="submit">添加关系</button>
      <p class="hint">先后关系会做有向成环检测；同期关联不进入有向图。</p>
    </form>
  </section>

  <section class="panel">
    <h3>活跃关系（{{ sortedActive.length }}）</h3>
    <ul class="list">
      <li v-for="r in sortedActive" :key="r.id" :class="{ faded: isHidden(r) }">
        <span class="grow">
          {{ describe(r) }}
          <span class="tag" :class="r.source">{{ sourceNames[r.source] }}</span>
          <span v-if="r.kind === 'contemporary'" class="tag contemp">无向</span>
          <span v-if="r.conflict" class="tag conflict">矛盾</span>
          <span v-if="isHidden(r)" class="tag hidden">简化视图中隐藏</span>
          <br />
          <small class="muted">
            <template v-if="r.evidenceIds.length">证据：{{ r.evidenceIds.map(evidenceRef).join('、') }}</template>
            <template v-else>无证据引用</template>
            <template v-if="r.note">　{{ r.note }}</template>
          </small>
        </span>
        <button class="sm" title="撤回该判断" @click="retract(r)">撤回</button>
      </li>
      <li v-if="sortedActive.length === 0" class="muted">暂无关系</li>
    </ul>
  </section>

  <section class="panel">
    <h3>已撤销判断（{{ state.retractions.length }}）</h3>
    <ul class="list">
      <li v-for="x in state.retractions" :key="x.id" class="retracted">
        <span class="grow">
          <s>{{ describe(x.snapshot) }}</s>
          <span class="tag" :class="x.snapshot.source">{{ sourceNames[x.snapshot.source] }}</span>
          <br />
          <small class="muted">{{ fmtTime(x.at) }}　理由：{{ x.reason }}</small>
        </span>
      </li>
      <li v-if="state.retractions.length === 0" class="muted">暂无</li>
    </ul>
  </section>
</template>

<style scoped>
.faded {
  opacity: 0.45;
}
.retracted {
  background: #faf3f3;
}
.ev-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #888;
}
</style>
