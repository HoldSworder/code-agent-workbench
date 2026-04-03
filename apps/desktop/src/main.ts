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
    { path: '/settings', component: () => import('./views/Settings.vue') },
  ],
})

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
