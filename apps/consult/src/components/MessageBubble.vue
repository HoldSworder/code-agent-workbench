<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'

const props = defineProps<{
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}>()

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const rendered = computed(() => {
  if (props.role === 'user') return props.content
  return md.render(props.content)
})
</script>

<template>
  <div class="flex gap-2.5" :class="role === 'user' ? 'justify-end pl-16' : 'justify-start'">
    <!-- Assistant avatar -->
    <div
      v-if="role === 'assistant'"
      class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-sm shadow-indigo-500/15"
    >
      <div class="i-carbon-bot w-4 h-4 text-white" />
    </div>

    <!-- Bubble -->
    <div
      class="min-w-0 text-[13.5px] leading-relaxed"
      :class="role === 'user'
        ? 'rounded-2xl rounded-br-sm px-3.5 py-2.5 bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-sm shadow-indigo-500/10'
        : 'rounded-2xl rounded-tl-sm px-3.5 py-2.5 bg-white/80 dark:bg-[#232327]/80 text-gray-800 dark:text-gray-200'"
    >
      <div v-if="role === 'user'" class="whitespace-pre-wrap">{{ content }}</div>
      <div
        v-else
        class="msg-content prose prose-sm dark:prose-invert max-w-none"
        v-html="rendered"
      />
      <span v-if="streaming" class="inline-block w-1.5 h-4 bg-indigo-400 dark:bg-indigo-400 rounded-sm animate-pulse ml-0.5 align-text-bottom" />
    </div>

    <!-- User avatar -->
    <div
      v-if="role === 'user'"
      class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-gradient-to-br from-gray-200 to-gray-300 dark:from-white/8 dark:to-white/4"
    >
      <div class="i-carbon-user w-4 h-4 text-gray-500 dark:text-gray-400" />
    </div>
  </div>
</template>

<style scoped>
.msg-content :deep(p) {
  margin: 0.3rem 0;
}
.msg-content :deep(p:first-child) {
  margin-top: 0;
}
.msg-content :deep(p:last-child) {
  margin-bottom: 0;
}
.msg-content :deep(pre) {
  margin: 0.75rem 0;
  padding: 0.875rem 1rem;
  border-radius: 0.5rem;
  background: #1e1e2e;
  color: #cdd6f4;
  font-size: 12.5px;
  line-height: 1.65;
  overflow-x: auto;
}
:is(.dark) .msg-content :deep(pre) {
  background: #11111b;
  color: #cdd6f4;
}
.msg-content :deep(code) {
  font-size: 12px;
  padding: 0.15em 0.4em;
  border-radius: 0.25rem;
  background: #e8e8ed;
  color: #c7254e;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}
:is(.dark) .msg-content :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  color: #f0a8c0;
}
.msg-content :deep(pre code) {
  padding: 0;
  background: none;
  color: inherit;
}
.msg-content :deep(ul),
.msg-content :deep(ol) {
  margin: 0.4rem 0;
  padding-left: 1.25rem;
}
.msg-content :deep(li) {
  margin: 0.15rem 0;
}
.msg-content :deep(a) {
  color: #6366f1;
  text-decoration: none;
}
.msg-content :deep(a:hover) {
  text-decoration: underline;
}
.msg-content :deep(blockquote) {
  border-left: 3px solid #6366f1;
  margin: 0.5rem 0;
  padding: 0.3rem 0.75rem;
  color: #6b7280;
  background: rgba(99, 102, 241, 0.04);
  border-radius: 0 0.25rem 0.25rem 0;
}
:is(.dark) .msg-content :deep(blockquote) {
  border-left-color: #6366f1;
  color: #9ca3af;
  background: rgba(99, 102, 241, 0.06);
}
.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3) {
  margin: 0.75rem 0 0.4rem;
  font-weight: 600;
}
.msg-content :deep(h1) { font-size: 1.05em; }
.msg-content :deep(h2) { font-size: 1em; }
.msg-content :deep(h3) { font-size: 0.95em; }
.msg-content :deep(table) {
  width: 100%;
  margin: 0.75rem 0;
  font-size: 12.5px;
  border-collapse: separate;
  border-spacing: 0;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  overflow: hidden;
}
:is(.dark) .msg-content :deep(table) {
  border-color: rgba(255, 255, 255, 0.08);
}
.msg-content :deep(th),
.msg-content :deep(td) {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #e5e7eb;
  border-right: 1px solid #e5e7eb;
  text-align: left;
  vertical-align: top;
  line-height: 1.5;
}
.msg-content :deep(th:last-child),
.msg-content :deep(td:last-child) {
  border-right: none;
}
.msg-content :deep(tr:last-child td) {
  border-bottom: none;
}
:is(.dark) .msg-content :deep(th),
:is(.dark) .msg-content :deep(td) {
  border-color: rgba(255, 255, 255, 0.06);
}
.msg-content :deep(th) {
  background: #f8f9fa;
  font-weight: 600;
  color: #374151;
  white-space: nowrap;
}
:is(.dark) .msg-content :deep(th) {
  background: rgba(255, 255, 255, 0.04);
  color: #d1d5db;
}
</style>
