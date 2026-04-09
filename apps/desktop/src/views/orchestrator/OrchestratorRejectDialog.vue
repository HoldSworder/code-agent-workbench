<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  confirm: [feedback: string]
  cancel: []
}>()

const feedback = ref('')
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" @click="emit('cancel')" />
      <div class="relative w-full max-w-md mx-4 bg-white dark:bg-[#28282c] rounded-xl shadow-2xl">
        <div class="px-5 pt-5 pb-3">
          <h3 class="text-sm font-semibold">拒绝此次运行</h3>
          <p class="text-xs text-gray-500 mt-1">请提供拒绝原因，Leader 将在下次处理中参考此反馈。</p>
        </div>
        <div class="px-5 pb-3">
          <textarea
            v-model="feedback"
            rows="4"
            placeholder="例如：登录功能缺少表单校验和错误提示…"
            class="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 resize-none"
          />
        </div>
        <div class="flex justify-end gap-2 px-5 pb-5">
          <button
            class="px-3 py-1.5 text-xs font-medium rounded-md text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5 transition-colors"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            class="px-3 py-1.5 text-xs font-medium rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40"
            :disabled="!feedback.trim()"
            @click="emit('confirm', feedback.trim())"
          >
            确认拒绝
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
