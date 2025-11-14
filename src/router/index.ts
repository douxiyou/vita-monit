import { createMemoryHistory, createRouter } from 'vue-router'
import Dashboard from '@/views/dashboard/index.vue'
const routes = [
  { path: '/', component: Dashboard },
]

const router = createRouter({
  history: createMemoryHistory(),
  routes,
})
export default router