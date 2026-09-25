<script setup lang="ts">
import { state } from '../store'

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <section class="panel">
    <h3>操作批次（{{ state.batches.length }}）</h3>
    <ul class="list">
      <li v-for="b in [...state.batches].reverse()" :key="b.id" :class="{ undone: b.undone }">
        <span class="grow" :class="{ undone: b.undone }">
          {{ b.label }}
          <br />
          <small class="muted">{{ fmtTime(b.at) }}　{{ b.kind === 'manual' ? '手工操作' : '现场记录' }}　{{ b.mutations.length }} 项变更</small>
        </span>
        <span v-if="b.undone" class="tag hidden">已撤销</span>
        <span v-else-if="b.kind !== 'manual'" class="tag contemp">现场</span>
      </li>
      <li v-if="state.batches.length === 0" class="muted">暂无操作</li>
    </ul>
  </section>
</template>

<style scoped>
.undone {
  text-decoration: line-through;
  opacity: 0.6;
}
</style>
