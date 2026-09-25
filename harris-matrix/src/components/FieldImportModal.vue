<script setup lang="ts">
import { computed } from 'vue'
import { cancelFieldPreview, commitFieldImport, setPreviewChoice, state, unitLabel } from '../store'
import type { PreviewItem } from '../types'

function describeRel(from: string, to: string, kind: string): string {
  return kind === 'earlier'
    ? `${unitLabel(from)} 早于 ${unitLabel(to)}`
    : `${unitLabel(from)} 与 ${unitLabel(to)} 同期`
}

function fmt(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

const groups = computed(() => {
  const items = state.fieldPreview?.items ?? []
  return {
    new: items.filter((i) => i.kind === 'new'),
    duplicate: items.filter((i) => i.kind === 'duplicate'),
    revision: items.filter((i) => i.kind === 'revision'),
    conflict: items.filter((i) => i.kind === 'conflict'),
  }
})

const count = computed(() => state.fieldPreview?.items.length ?? 0)
</script>

<template>
  <div v-if="state.fieldPreview" class="modal-mask" @click.self="cancelFieldPreview">
    <div class="modal wide">
      <h3 class="normal">现场记录导入预览</h3>
      <p class="muted small">
        文件：<b>{{ state.fieldPreview.fileName }}</b
        >　来源编号：<b>{{ state.fieldPreview.parsed.meta.sourceId }}</b>
        <template v-if="state.fieldPreview.parsed.meta.sourceName">
          （{{ state.fieldPreview.parsed.meta.sourceName }}）
        </template>
        　共 {{ count }} 条
      </p>

      <div class="cats">
        <span class="cat-tag new">新增 {{ groups.new.length }}</span>
        <span class="cat-tag dup">重复 {{ groups.duplicate.length }}</span>
        <span class="cat-tag rev">修订 {{ groups.revision.length }}</span>
        <span class="cat-tag conf">冲突 {{ groups.conflict.length }}</span>
      </div>

      <div class="preview-body">
        <!-- 新增 -->
        <section v-if="groups.new.length">
          <h4 class="new">新增（{{ groups.new.length }}）</h4>
          <ul>
            <li v-for="item in groups.new" :key="item.record.versionId">
              <span class="grow">{{ describeRel(item.record.fromId, item.record.toId, item.record.kind) }}</span>
              <span class="tag" :class="item.record.source">{{ item.record.source === 'observation' ? '观察' : '推断' }}</span>
              <small class="muted">{{ fmt(item.record.collectedAt) }}</small>
            </li>
          </ul>
        </section>

        <!-- 重复：幂等跳过 / 撤销后再激活 -->
        <section v-if="groups.duplicate.length">
          <h4 class="dup">重复（{{ groups.duplicate.length }}）</h4>
          <ul>
            <li v-for="item in groups.duplicate" :key="item.record.versionId">
              <span class="grow">{{ describeRel(item.record.fromId, item.record.toId, item.record.kind) }}</span>
              <span v-if="item.duplicateMode === 'skip'" class="tag hidden">内容一致，幂等跳过</span>
              <span v-else class="tag contemp">原批次已撤销，重导将重新激活</span>
            </li>
          </ul>
        </section>

        <!-- 修订：保留旧版，用户选择接受修订或维持现状 -->
        <section v-if="groups.revision.length">
          <h4 class="rev">修订（{{ groups.revision.length }}）—旧版本保留，可选择</h4>
          <ul>
            <li v-for="item in groups.revision" :key="item.record.versionId" class="revision">
              <div class="rev-head">
                <span class="grow">
                  <span class="tag" :class="item.revision!.direction === 'upgrade' ? 'conflict' : 'hidden'">
                    {{ item.revision!.direction === 'upgrade' ? '较新版本' : '较旧版本（补录）' }}
                  </span>
                  <b>{{ describeRel(item.record.fromId, item.record.toId, item.record.kind) }}</b>
                </span>
              </div>
              <div class="rev-versions">
                <div class="rev-ver incoming">
                  <small class="muted">导入版 · 采集 {{ fmt(item.record.collectedAt) }}</small>
                  <div>{{ describeRel(item.record.fromId, item.record.toId, item.record.kind) }}</div>
                  <small v-if="item.record.note" class="muted">{{ item.record.note }}</small>
                </div>
                <div class="rev-ver old">
                  <small class="muted">现版 · 采集 {{ fmt(item.revision!.latest.collectedAt) }}</small>
                  <div>{{ describeRel(item.revision!.latest.from, item.revision!.latest.to, item.revision!.latest.kind) }}</div>
                  <small v-if="item.revision!.latest.note" class="muted">{{ item.revision!.latest.note }}</small>
                </div>
              </div>
              <div v-if="item.revision!.direction === 'upgrade'" class="rev-choice">
                <label><input type="radio" :checked="item.choice === 'accept'" @change="setPreviewChoice(state.fieldPreview!.items.indexOf(item), 'accept')" /> 接受修订（投影新版）</label>
                <label><input type="radio" :checked="item.choice === 'keep'" @change="setPreviewChoice(state.fieldPreview!.items.indexOf(item), 'keep')" /> 维持现状（新版仅存档）</label>
              </div>
              <p v-else class="hint small">较旧版本只归档留痕，当前最新版本继续在位（版本规则自动处理）。</p>
            </li>
          </ul>
        </section>

        <!-- 冲突：跨来源相反结论，进入待归并，不覆盖 -->
        <section v-if="groups.conflict.length">
          <h4 class="conf">跨来源相反结论（{{ groups.conflict.length }}）—进入待归并，不直接覆盖</h4>
          <ul>
            <li v-for="item in groups.conflict" :key="item.record.versionId" class="conflict-item">
              <div class="conf-row">
                <b>{{ describeRel(item.record.fromId, item.record.toId, item.record.kind) }}</b>
                <span class="tag conflict">本方：{{ state.fieldPreview!.parsed.meta.sourceId }}</span>
              </div>
              <div class="conf-opp">
                相反记录：
                <span v-for="(o, k) in item.conflict!.opponents" :key="k" class="opp">
                  <span class="tag" :class="o.backing === 'field' ? 'contemp' : 'inference'">
                    {{ o.backing === 'field' ? `来源 ${o.sourceId}#${o.recordKey}` : o.sourceId }}
                  </span>
                  主张 {{ describeRel(o.from, o.to, 'earlier') }}
                </span>
              </div>
              <p class="hint small">
                导入后该层位对进入「待归并冲突」：当前在位记录保留在有向图中，新记录版本完整留存但被投影屏蔽，需在冲突面板人工归并。
              </p>
            </li>
          </ul>
        </section>
      </div>

      <div v-if="state.fieldPreview.warnings.length" class="warnings">
        <b>提示（不阻断导入）：</b>
        <ul>
          <li v-for="(w, i) in state.fieldPreview.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <div class="modal-actions">
        <button class="primary" @click="commitFieldImport">确认导入（原子写入）</button>
        <button @click="cancelFieldPreview">取消</button>
      </div>
      <p class="hint small">任一层位引用非法时整批拒绝；确认时所有写入在同一 IndexedDB 事务内完成，失败自动回滚，不留半批数据。</p>
    </div>
  </div>
</template>

<style scoped>
.modal.wide {
  width: 720px;
  max-width: 94vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
h3.normal {
  color: #6d5c47;
}
.cats {
  display: flex;
  gap: 8px;
  margin: 8px 0;
}
.cat-tag {
  font-size: 12px;
  border-radius: 4px;
  padding: 2px 10px;
  border: 1px solid;
}
.cat-tag.new {
  color: #2e7d32;
  border-color: #2e7d32;
}
.cat-tag.dup {
  color: #999;
  border-color: #bbb;
}
.cat-tag.rev {
  color: #ef6c00;
  border-color: #ef6c00;
}
.cat-tag.conf {
  color: #c62828;
  border-color: #c62828;
}
.preview-body {
  overflow-y: auto;
  flex: 1;
  min-height: 80px;
  padding-right: 4px;
}
.preview-body section {
  margin-bottom: 12px;
}
.preview-body h4 {
  margin: 8px 0 4px;
  font-size: 13px;
}
.preview-body h4.new {
  color: #2e7d32;
}
.preview-body h4.dup {
  color: #888;
}
.preview-body h4.rev {
  color: #ef6c00;
}
.preview-body h4.conf {
  color: #c62828;
}
.preview-body ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.preview-body li {
  border: 1px solid #eee;
  border-radius: 6px;
  background: #fdfcfa;
  padding: 6px 8px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.revision,
.conflict-item {
  flex-direction: column;
  align-items: stretch !important;
}
.rev-head {
  display: flex;
  align-items: center;
}
.rev-versions {
  display: flex;
  gap: 8px;
  margin: 6px 0;
}
.rev-ver {
  flex: 1;
  border: 1px dashed #ccc;
  border-radius: 6px;
  padding: 6px 8px;
  background: #fff;
}
.rev-ver.incoming {
  border-color: #ef6c00;
  background: #fff8f0;
}
.rev-choice {
  display: flex;
  gap: 16px;
  font-size: 13px;
}
.conf-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.conf-opp {
  font-size: 12px;
  color: #555;
  margin-top: 4px;
}
.warnings {
  border: 1px solid #f0d080;
  background: #fffaf0;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #8a6d3b;
  max-height: 90px;
  overflow-y: auto;
}
.warnings ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.primary {
  border-color: #2e7d32;
  color: #2e7d32;
  font-weight: 600;
}
.hint {
  color: #999;
}
</style>
