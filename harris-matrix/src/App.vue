<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MatrixCanvas from './components/MatrixCanvas.vue'
import UnitPanel from './components/UnitPanel.vue'
import RelationPanel from './components/RelationPanel.vue'
import BatchPanel from './components/BatchPanel.vue'
import {
  autoLayout,
  cancelCycle,
  clearAll,
  confirmCycle,
  exportProject,
  importProject,
  lastBatch,
  loadSample,
  redundantIds,
  refresh,
  state,
  undo,
  unitLabel,
} from './store'

const fileInput = ref<HTMLInputElement>()

const cyclePathText = computed(() => state.pendingCycle?.path.map(unitLabel).join(' → ') ?? '')

onMounted(() => {
  void refresh()
})

function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void importProject(file)
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <h1>地层矩阵编辑台</h1>
      <div class="view-toggle" role="tablist">
        <button :class="{ on: state.viewMode === 'raw' }" @click="state.viewMode = 'raw'">原始关系</button>
        <button :class="{ on: state.viewMode === 'simplified' }" @click="state.viewMode = 'simplified'">
          简化视图
        </button>
      </div>
      <span v-if="state.viewMode === 'simplified'" class="muted small">
        已隐藏 {{ redundantIds.size }} 条传递边（原始记录保留）
      </span>
      <span class="spacer"></span>
      <button @click="autoLayout">自动分层排布</button>
      <button :disabled="!lastBatch" :title="lastBatch ? `撤销：${lastBatch.label}` : '没有可撤销的操作'" @click="undo">
        撤销{{ lastBatch ? `：${lastBatch.label}` : '' }}
      </button>
      <button @click="loadSample">载入示例</button>
      <button @click="exportProject" :disabled="state.units.length === 0">导出工程</button>
      <button @click="fileInput?.click()">导入…</button>
      <input ref="fileInput" type="file" accept="application/json" hidden @change="onImportFile" />
      <button class="danger" @click="clearAll()">清空</button>
    </header>

    <main class="main">
      <aside class="sidebar">
        <UnitPanel />
        <RelationPanel />
        <BatchPanel />
      </aside>
      <MatrixCanvas />
    </main>

    <footer class="statusbar">
      数据仅保存于本机浏览器 IndexedDB，不上传任何现场资料。地层身份与画布位置分离存储；撤销以批次为单位，关系与证据引用一并恢复。
    </footer>

    <!-- 成环确认对话框：给出完整环路径 -->
    <div v-if="state.pendingCycle" class="modal-mask" @click.self="cancelCycle">
      <div class="modal">
        <h3>该关系将构成环</h3>
        <p>新增此先后关系后，将形成如下循环：</p>
        <p class="cycle-path">{{ cyclePathText }}</p>
        <p>这通常意味着两条记录互相矛盾。可以保留为矛盾记录（标红显示，不删除任何原始观察），或取消本次添加。</p>
        <div class="modal-actions">
          <button class="danger" @click="confirmCycle">保留为矛盾记录</button>
          <button @click="cancelCycle">取消</button>
        </div>
      </div>
    </div>

    <div v-if="state.toast" class="toast">{{ state.toast }}</div>
  </div>
</template>
