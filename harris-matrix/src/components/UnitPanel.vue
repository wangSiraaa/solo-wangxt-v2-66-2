<script setup lang="ts">
import { reactive } from 'vue'
import { addEvidence, addUnit, deleteUnit, state } from '../store'
import type { UnitType } from '../types'

const unitForm = reactive({ label: '', type: 'deposit' as UnitType, note: '' })
const evForm = reactive({ ref: '', text: '' })

const typeNames: Record<UnitType, string> = {
  deposit: '堆积',
  cut: '切割',
  fill: '填充',
  interface: '界面',
  other: '其他',
}

async function submitUnit() {
  await addUnit(unitForm.label, unitForm.type, unitForm.note)
  unitForm.label = ''
  unitForm.note = ''
}

async function submitEvidence() {
  await addEvidence(evForm.ref, evForm.text)
  evForm.ref = ''
  evForm.text = ''
}

function confirmDelete(id: string, label: string) {
  if (window.confirm(`删除层位 ${label}？涉及它的关系将一并删除（可整体撤销）。`)) {
    void deleteUnit(id)
  }
}
</script>

<template>
  <section class="panel">
    <h3>层位（{{ state.units.length }}）</h3>
    <form class="form" @submit.prevent="submitUnit">
      <div class="row">
        <input v-model="unitForm.label" placeholder="编号，如 1021" required />
        <select v-model="unitForm.type">
          <option v-for="(name, t) in typeNames" :key="t" :value="t">{{ name }}</option>
        </select>
      </div>
      <input v-model="unitForm.note" placeholder="备注（可选）" />
      <button type="submit">新增层位</button>
    </form>
    <ul class="list">
      <li
        v-for="u in state.units"
        :key="u.id"
        :class="{ selected: state.selectedUnitId === u.id }"
        @click="state.selectedUnitId = state.selectedUnitId === u.id ? null : u.id"
      >
        <span class="badge" :class="u.type">{{ typeNames[u.type] }}</span>
        <span class="grow">
          <b>{{ u.label }}</b>
          <small v-if="u.note">　{{ u.note }}</small>
        </span>
        <button class="danger sm" title="删除层位" @click.stop="confirmDelete(u.id, u.label)">删</button>
      </li>
      <li v-if="state.units.length === 0" class="muted">暂无层位</li>
    </ul>
  </section>

  <section class="panel">
    <h3>证据（{{ state.evidences.length }}）</h3>
    <form class="form" @submit.prevent="submitEvidence">
      <input v-model="evForm.ref" placeholder="出处，如 田野日记·第13页" required />
      <input v-model="evForm.text" placeholder="摘要（可选）" />
      <button type="submit">登记证据</button>
    </form>
    <ul class="list">
      <li v-for="e in state.evidences" :key="e.id">
        <span class="grow">
          <b>{{ e.ref }}</b>
          <small v-if="e.text">　{{ e.text }}</small>
        </span>
      </li>
      <li v-if="state.evidences.length === 0" class="muted">暂无证据</li>
    </ul>
  </section>
</template>
