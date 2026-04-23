import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import 'virtual:uno.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Dashboard.vue') },
    { path: '/repo/:id', component: () => import('./views/RepoView.vue') },
    { path: '/repo/:repoId/task/:taskId', component: () => import('./views/TaskDetail.vue') },
    { path: '/workflow', component: () => import('./views/WorkflowEditor.vue') },
    { path: '/skills', component: () => import('./views/SkillsView.vue') },
    { path: '/workflow-skills', component: () => import('./views/WorkflowSkillsView.vue') },
    { path: '/tools', component: () => import('./views/ToolsView.vue') },
    { path: '/mcp', component: () => import('./views/McpView.vue') },
    { path: '/orchestrator', component: () => import('./views/orchestrator/OrchestratorView.vue') },
    { path: '/consult', component: () => import('./views/ConsultView.vue') },
    { path: '/settings', component: () => import('./views/Settings.vue') },
  ],
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
