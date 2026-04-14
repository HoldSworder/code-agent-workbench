import { isTauri } from '@tauri-apps/api/core'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import { ref } from 'vue'

let childProcess: Child | null = null
let requestId = 0
const pendingRequests = new Map<
  number,
  {
    resolve: (value: any) => void
    reject: (reason: any) => void
  }
>()
let buffer = ''

export const sidecarReady = ref(false)

const mockInstalledSkills = new Map<string, { slug: string, displayName: string, description: string }>()

function mockRpc<T>(method: string, params: Record<string, any>): T {
  switch (method) {
    case 'requirement.list':
      return [] as T
    case 'repo.list':
      return [] as T
    case 'task.listByRepo':
    case 'task.listByRequirement':
      return [] as T
    case 'message.list':
      return [] as T
    case 'requirement.create':
      return {
        id: `mock-${Date.now()}`,
        title: params.title,
        description: params.description,
        source: params.source,
        source_url: params.source_url ?? null,
        status: 'draft',
        created_at: new Date().toISOString(),
      } as T
    case 'repo.create':
      return {
        id: `mock-${Date.now()}`,
        name: params.name,
        alias: params.alias ?? null,
        local_path: params.local_path,
        default_branch: params.default_branch,
        agent_provider: null,
        created_at: new Date().toISOString(),
      } as T
    case 'repo.update':
      return {
        id: params.id,
        name: params.name ?? 'mock',
        alias: params.alias ?? null,
        local_path: '',
        default_branch: params.default_branch ?? 'main',
        agent_provider: null,
        created_at: new Date().toISOString(),
      } as T
    case 'task.create':
      return {
        id: `mock-${Date.now()}`,
        requirement_id: params.requirementId,
        repo_id: params.repoId,
        branch_name: 'feature/mock',
        change_id: 'mock',
        current_stage: 'planning',
        current_phase: 'task-breakdown',
        phase_status: 'pending',
        openspec_path: '',
        worktree_path: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T
    case 'workflow.start':
    case 'workflow.retry':
    case 'workflow.reset':
    case 'workflow.resetPhase':
    case 'workflow.rollback':
    case 'workflow.rollbackToStage':
    case 'repo.delete':
    case 'requirement.delete':
    case 'workflow.confirm':
    case 'workflow.feedback':
    case 'workflow.cancel':
    case 'workflow.executeRequirementPhase':
    case 'workflow.setPhaseEnabled':
    case 'workflow.confirmAndAdvanceToPhase':
      return { ok: true } as T
    case 'workflow.getAdvanceOptions':
      return {
        defaultNext: { phaseId: 'self-test', phaseName: '代码 Review', stageId: 'development' },
        optionalPhases: [{
          phaseId: 'integration',
          phaseName: '联调',
          stageId: 'development',
          entryInput: { label: '联调信息', description: '请提供后端 Spec / API 文档 URL 或直接粘贴内容', placeholder: '粘贴后端 Spec URL、API 文档内容、联调环境地址等...' },
        }],
      } as T
    case 'workflow.getPhaseEnabledMap':
      return {} as T
    case 'workflow.phases':
      return { stages: [
        { id: 'planning', name: '任务规划', phases: [
          { id: 'task-breakdown', name: '任务拆分' },
          { id: 'task-validate', name: '任务验证' },
          { id: 'codex-cross-review-planning', name: 'Codex 交叉 Review' },
        ] },
        { id: 'development', name: '代码开发', phases: [
          { id: 'tdd-dev', name: '开发' },
          { id: 'integration', name: '联调' },
          { id: 'self-test', name: '代码 Review' },
          { id: 'codex-cross-review-dev', name: 'Codex 交叉 Review' },
        ] },
        { id: 'testing', name: '测试', phases: [
          { id: 'e2e-test', name: 'E2E 浏览器测试' },
          { id: 'bug-fix', name: 'Bug 修复' },
        ] },
        { id: 'release', name: '上线', phases: [
          { id: 'archive-deploy', name: '归档与发布' },
        ] },
      ] } as T
    case 'workflow.requirementPhases':
      return { phases: [
        { id: 'repo-scan', name: '仓库扫描' },
        { id: 'req-collect', name: '需求采集' },
        { id: 'design-draft', name: '设计稿获取', optional: true },
        { id: 'brainstorming', name: '需求对齐' },
        { id: 'gray-area', name: '灰区讨论', skippable: true },
        { id: 'spec-create', name: 'Spec 落盘' },
      ] } as T
    case 'workflow.getFullConfig':
      return {
        name: 'dev-workflow',
        description: '通用 Spec-Driven 研发工作流（五阶段层级模型）',
        dependencies: {
          openspec: { type: 'cli', check: 'which openspec', install_hint: 'npm install -g openspec', commands: ['openspec new change', 'openspec instructions', 'openspec validate', 'openspec status', 'openspec archive'] },
          superpowers: { type: 'skill-pack', skills: { 'test-driven-development': 'superpowers:test-driven-development', 'verification-before-completion': 'superpowers:verification-before-completion' } },
        },
        gate_definitions: {
          no_change_dir: { description: '无变更目录（openspec/changes 下无对应目录）', checks: [{ type: 'not_exists', path: '{{openspec_path}}' }] },
          has_proposal_and_specs_no_tasks: { description: 'proposal.md 和 specs/ 已存在，但 tasks.md 尚未创建', checks: [{ type: 'exists', path: '{{openspec_path}}/proposal.md' }, { type: 'exists', path: '{{openspec_path}}/specs' }, { type: 'not_exists', path: '{{openspec_path}}/tasks.md' }] },
          has_tasks: { description: 'tasks.md 文件已创建', checks: [{ type: 'exists', path: '{{openspec_path}}/tasks.md' }] },
          tasks_has_unchecked: { description: 'tasks.md 中存在未勾选的任务项', checks: [{ type: 'file_contains', path: '{{openspec_path}}/tasks.md', pattern: '- [ ]' }] },
          tasks_all_checked: { description: 'tasks.md 中所有任务项已勾选完成', checks: [{ type: 'file_contains', path: '{{openspec_path}}/tasks.md', pattern: '- [x]' }, { type: 'file_not_contains', path: '{{openspec_path}}/tasks.md', pattern: '- [ ]' }] },
          tasks_all_checked_no_e2e: { description: '任务全部完成但无 E2E 报告', checks: [{ type: 'file_contains', path: '{{openspec_path}}/tasks.md', pattern: '- [x]' }, { type: 'file_not_contains', path: '{{openspec_path}}/tasks.md', pattern: '- [ ]' }, { type: 'not_exists', path: '{{openspec_path}}/e2e-report.md' }] },
          e2e_report_pass: { description: 'e2e-report.md 验收结论包含"通过"或"用户同意"', checks: [{ type: 'file_section_matches', path: '{{openspec_path}}/e2e-report.md', after: '## 验收结论', pattern: '通过|用户同意' }] },
          e2e_report_fail_no_consent: { description: 'e2e-report.md 不通过且用户未同意带债上线', checks: [{ type: 'exists', path: '{{openspec_path}}/e2e-report.md' }, { type: 'file_section_not_matches', path: '{{openspec_path}}/e2e-report.md', after: '## 验收结论', pattern: '通过|用户同意' }] },
          working_tree_clean: { description: 'Git 工作区干净（无未提交的修改和暂存）', checks: [{ type: 'command_succeeds', command: 'git diff --quiet && git diff --cached --quiet' }] },
        },
        guardrail_definitions: {
          no_openspec_write_before_confirm: { description: '在用户明确同意进入下一阶段之前，禁止创建或修改 openspec 文件', severity: 'hard' },
          no_skip_tdd: { description: '必须严格遵循 TDD 纪律：写测试 → 验证失败 → 最小实现 → 验证通过', severity: 'hard' },
          no_uncommitted_claim: { description: '不得在没有运行验证命令的情况下声称任务完成', severity: 'soft' },
        },
        state_inference: {
          rules: [
            { condition: 'no_change_dir', stage: 'planning', phase: 'create-branch', description: '无变更目录 → 先创建 feature 分支' },
            { condition: 'has_proposal_and_specs_no_tasks', stage: 'planning', phase: 'task-breakdown', description: '有 proposal + specs 但无 tasks → 任务拆分' },
            { condition: 'tasks_has_unchecked', stage: 'development', phase: 'tdd-dev', description: 'tasks.md 有未勾选项 → 代码开发' },
            { condition: 'e2e_report_pass', stage: 'release', phase: 'archive-deploy', description: 'e2e-report 通过 → 可归档发布' },
            { condition: 'e2e_report_fail_no_consent', stage: 'testing', phase: 'bug-fix', description: 'e2e-report 不通过且未同意带债 → Bug 修复' },
            { condition: 'tasks_all_checked_no_e2e', stage: 'testing', phase: 'e2e-test', description: '任务全部完成但无 E2E 报告 → 进入测试' },
            { condition: 'tasks_all_checked', stage: 'development', phase: 'self-test', description: 'tasks.md 全部勾选 → 代码 Review' },
          ],
        },
        requirement_phases: [
          { id: 'feishu-requirement', name: '飞书需求获取', provider: 'external-cli', skill: 'skills/feishu-requirement.md', requires_confirm: false },
        ],
        stages: [
          { id: 'planning', name: '任务规划', gate: 'has_tasks', phases: [
            { id: 'create-branch', name: '创建分支', provider: 'external-cli', skill: 'skills/frontend/create-branch.md', requires_confirm: false, entry_gate: 'working_tree_clean' },
            { id: 'spec-create', name: 'Spec 落盘', provider: 'external-cli', skill: 'skills/frontend/spec-create.md', requires_confirm: true, invoke_commands: ['openspec new change "{{change_id}}"'], guardrails: ['no_openspec_write_before_confirm'], confirm_files: ['{{openspec_path}}/proposal.md', '{{openspec_path}}/specs/*/spec.md'] },
            { id: 'task-breakdown', name: '任务拆分', provider: 'external-cli', skill: 'skills/frontend/task-breakdown.md', requires_confirm: true, invoke_commands: ['openspec instructions tasks --change "{{change_id}}"'] },
            { id: 'task-validate', name: '任务验证', provider: 'external-cli', skill: 'skills/frontend/task-validate.md', requires_confirm: false, invoke_commands: ['openspec validate "{{change_id}}"'] },
            { id: 'codex-cross-review-planning', name: 'Codex 交叉 Review', provider: 'external-cli', skill: 'skills/frontend/codex-cross-review-planning.md', optional: true, requires_confirm: false },
          ] },
          { id: 'development', name: '代码开发', gate: 'tasks_all_checked', phases: [
            { id: 'tdd-dev', name: '开发', provider: 'external-cli', skill: 'skills/frontend/tdd-dev.md', requires_confirm: false, invoke_skills: ['superpowers:test-driven-development', 'superpowers:verification-before-completion'], guardrails: ['no_skip_tdd', 'no_uncommitted_claim'], completion_check: 'tasks_all_checked' },
            { id: 'integration', name: '联调', provider: 'external-cli', skill: 'skills/frontend/integration.md', optional: true, requires_confirm: false, triggers: ['后端spec到了', '联调', 'API文档到了', '后端接口文档来了'] },
            { id: 'self-test', name: '代码 Review', provider: 'external-cli', skill: 'skills/frontend/self-test.md', requires_confirm: false, invoke_skills: ['superpowers:verification-before-completion'] },
            { id: 'codex-cross-review-dev', name: 'Codex 交叉 Review', provider: 'external-cli', skill: 'skills/frontend/codex-cross-review-dev.md', optional: true, requires_confirm: false },
          ] },
          { id: 'testing', name: '测试', gate: 'e2e_report_pass', phases: [
            { id: 'e2e-test', name: 'E2E 浏览器测试', provider: 'external-cli', skill: 'skills/frontend/e2e-test.md', requires_confirm: false, completion_check: 'e2e_report_pass' },
            { id: 'bug-fix', name: 'Bug 修复', provider: 'external-cli', skill: 'skills/frontend/bug-fix.md', optional: true, loopable: true, loop_target: 'e2e-test', requires_confirm: false },
          ] },
          { id: 'release', name: '上线', phases: [
            { id: 'archive-deploy', name: '归档与发布', provider: 'external-cli', skill: 'skills/frontend/archive-deploy.md', requires_confirm: true, invoke_commands: ['openspec archive "{{change_id}}" --yes'], is_terminal: true },
            { id: 'post-deploy-fix', name: '测试环境 Bug 修复', provider: 'external-cli', skill: 'skills/frontend/post-deploy-fix.md', optional: true, loopable: true, loop_target: 'archive-deploy', requires_confirm: false },
          ] },
        ],
        trigger_mapping: [
          { patterns: ['新需求', '新功能', '开始开发', '做个新feature'], target_stage: 'planning', target_phase: 'spec-create' },
          { patterns: ['继续开发', '接着做', '继续这个需求'], target_stage: 'auto', strategy: 'infer_from_state' },
          { patterns: ['后端spec', '后端接口文档', 'API文档', '联调'], target_stage: 'development', target_phase: 'integration' },
          { patterns: ['跑e2e', '浏览器验证', '自动化验证', '实机测试'], target_stage: 'testing', target_phase: 'e2e-test' },
          { patterns: ['归档', 'archive', '发布测试'], target_stage: 'release', target_phase: 'archive-deploy' },
        ],
      } as T
    case 'workflow.getRawYaml':
      return { yaml: '# Mock YAML content\nname: dev-workflow\ndescription: 通用 Spec-Driven 研发工作流' } as T
    case 'workflow.resolveSkill':
      return { content: `---\nname: ${(params as any).skillPath}\n---\n\n# ${(params as any).skillPath}\n\n这是 Skill 文件的示例内容。在 Tauri 环境下将加载实际的 Skill 文件。\n\n## 执行步骤\n\n1. 分析上下文\n2. 收集信息\n3. 执行任务\n4. 生成产出\n\n## 注意事项\n\n- 遵循护栏规则\n- 确认前置条件\n- 验证产出文件` } as T
    case 'workflow.saveConfig':
      return { ok: true } as T
    case 'workflow.checkDependencies':
      return { ok: true, missing: [] } as T
    case 'task.getLiveOutput':
      return { output: '', activity: '' } as T
    case 'task.getLastError':
      return { error: null } as T
    case 'task.changedFiles':
      return { files: [] } as T
    case 'task.fileDiff':
      return { diff: '' } as T
    case 'task.agentRuns':
      return [] as T
    case 'task.sessionTranscript':
      return { turns: [], format: 'unknown', filePath: null } as T
    case 'repo.sessions':
      return { items: [], total: 0 } as T
    case 'repo.sessionTranscript':
      return { turns: [], format: 'unknown', filePath: null } as T
    case 'settings.get':
      return { value: null } as T
    case 'settings.set':
      return { ok: true } as T
    case 'settings.getAll':
      return {} as T
    case 'agent.listModels':
      return { models: [
        { id: 'auto', label: 'Auto' },
        { id: 'sonnet-4-thinking', label: 'Sonnet 4 Thinking' },
        { id: 'gpt-5', label: 'GPT-5' },
      ] } as T
    case 'mcp.list':
      return [
        { id: 'mock-2', name: 'feishu-project', description: '飞书项目管理 MCP（体积大）', transport: 'stdio', command: 'npx', args: '["@anthropic/feishu-mcp"]', env: '{}', url: null, headers: '{}', enabled: 1, created_at: '2026-04-01', updated_at: '2026-04-01' },
      ] as T
    case 'mcp.getAllBindings':
      return [
        { id: 'b1', stage_id: '_requirements', phase_id: 'req-collect', mcp_server_id: 'mock-2' },
      ] as T
    case 'mcp.create':
    case 'mcp.update':
    case 'mcp.toggle':
      return { id: `mock-${Date.now()}`, ...params } as T
    case 'mcp.test':
      return { ok: true } as T
    case 'mcp.delete':
    case 'mcp.setBindings':
      return { ok: true } as T
    case 'skill.scan': {
      const baseSkills = [
        { id: '/mock/vue', name: 'vue', description: 'Vue.js progressive JavaScript framework.', type: 'skill', dirName: 'vue', realDir: '/mock/vue', skillMdPath: '/mock/vue/SKILL.md', envs: { claude: { installed: true }, codex: { installed: true }, cursor: { installed: true } } },
        { id: '/mock/antfu', name: 'antfu', description: 'Anthony Fu\'s {Opinionated} preferences and best practices.', type: 'skill', dirName: 'antfu', realDir: '/mock/antfu', skillMdPath: '/mock/antfu/SKILL.md', envs: { claude: { installed: true, isSymlink: true }, codex: { installed: false }, cursor: { installed: false } } },
        { id: '/mock/dev-workflow', name: 'dev-workflow', description: '前端需求研发工作流编排。', type: 'skill', dirName: 'dev-workflow', realDir: '/mock/dev-workflow', skillMdPath: '/mock/SKILL.md', plugin: { name: 'fe-specflow', displayName: '前端 Specflow 研发工作流', version: '0.0.1', author: 'wenli' }, envs: { claude: { installed: false }, codex: { installed: false }, cursor: { installed: false } } },
        { id: '/mock/fe-sdd', name: 'fe-sdd', description: 'Spec-Driven 门禁：先澄清再落盘。', type: 'command', dirName: 'fe-sdd', realDir: '/mock/fe-sdd.md', skillMdPath: '/mock/fe-sdd.md', plugin: { name: 'fe-specflow', displayName: '前端 Specflow 研发工作流', version: '0.0.1', author: 'wenli' }, envs: { claude: { installed: false }, codex: { installed: false }, cursor: { installed: false } } },
      ]
      for (const [slug, meta] of mockInstalledSkills) {
        if (!baseSkills.some(s => s.dirName === slug)) {
          baseSkills.push({
            id: slug, name: meta.displayName || slug, description: meta.description || '',
            type: 'skill', dirName: slug, realDir: `/mock/store/${slug}`, skillMdPath: `/mock/store/${slug}/SKILL.md`,
            envs: { claude: { installed: true }, codex: { installed: false }, cursor: { installed: false } },
          })
        }
      }
      return { skills: baseSkills, envLabels: { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' } } as T
    }
    case 'skill.readContent':
      return { content: '---\nname: mock-skill\ndescription: Mock skill content\n---\n\n# Mock Skill\n\nThis is mock content for development.' } as T
    case 'skill.enable':
    case 'skill.disable':
      return { ok: true } as T
    case 'skillStore.list': {
      const isSkillsSh = (params.apiBase as string)?.includes('skills.sh')
      return {
        items: isSkillsSh
          ? [
              { slug: 'frontend-design', displayName: 'frontend-design', summary: 'From anthropics/skills', tags: [], stats: { downloads: 0, installs: 214080, versions: 0, stars: 0 }, highlighted: false, createdAt: 0, updatedAt: 0, latestVersion: null, source: 'anthropics/skills', installed: mockInstalledSkills.has('frontend-design') },
              { slug: 'find-skills', displayName: 'find-skills', summary: 'From vercel-labs/skills', tags: [], stats: { downloads: 0, installs: 731151, versions: 0, stars: 0 }, highlighted: false, createdAt: 0, updatedAt: 0, latestVersion: null, source: 'vercel-labs/skills', installed: mockInstalledSkills.has('find-skills') },
            ]
          : [
              { slug: 'example-skill', displayName: 'Example Skill', summary: 'A mock store skill for development', tags: ['mock'], stats: { downloads: 100, installs: 50, versions: 3, stars: 10 }, highlighted: false, createdAt: Date.now(), updatedAt: Date.now(), latestVersion: { version: '1.0.0', createdAt: Date.now(), changelog: 'Initial release' }, installed: mockInstalledSkills.has('example-skill') },
            ],
        nextCursor: null,
      } as T
    }
    case 'skillStore.search':
      return {
        items: [
          { slug: `search-${params.query}`, displayName: `Search: ${params.query}`, summary: 'Mock remote search result', tags: [], stats: { downloads: 0, installs: 5, versions: 0, stars: 0 }, highlighted: false, createdAt: 0, updatedAt: 0, latestVersion: null, source: 'mock-user/mock-repo' },
        ],
        nextCursor: null,
      } as T
    case 'skillStore.detail':
      return {
        skill: { slug: params.slug, displayName: params.slug, summary: params.source ? `From ${params.source}` : 'Mock skill detail', tags: [], stats: { downloads: 0, installs: 0, versions: 0, stars: 0 }, highlighted: false, createdAt: 0, updatedAt: 0, latestVersion: params.source ? null : { version: '1.0.0', createdAt: Date.now(), changelog: 'Mock changelog' }, source: params.source },
        latestVersion: params.source ? { version: 'latest', createdAt: 0, changelog: '', files: [{ path: 'SKILL.md', size: 128, storageKey: '', sha256: '', contentType: 'text/markdown' }] } : { version: '1.0.0', createdAt: Date.now(), changelog: 'Mock changelog', files: [{ path: 'SKILL.md', size: 128, storageKey: '', sha256: '', contentType: 'text/markdown' }] },
        owner: { handle: params.source?.split('/')[0] || 'mock-user', displayName: params.source || 'Mock User', image: '' },
        isStarred: false,
        installed: mockInstalledSkills.has(params.slug),
        readme: params.source ? `# ${params.slug}\n\nSkill from ${params.source}` : '',
      } as T
    case 'skillStore.install':
      mockInstalledSkills.set(params.slug, { slug: params.slug, displayName: params.slug, description: '' })
      return { installed: true, dirName: params.slug, path: `/mock/${params.slug}`, fileCount: 1 } as T
    case 'skillStore.uninstall':
      mockInstalledSkills.delete(params.slug)
      return { removed: true } as T
    case 'consult.start':
      return { running: true, port: 3100, localIp: '192.168.1.100' } as T
    case 'consult.stop':
      return { ok: true } as T
    case 'consult.status':
      return { running: false, port: null, localIp: null } as T
    case 'consult.listSessions':
      return [] as T
    case 'consult.getSessionMessages':
      return [] as T
    case 'orchestrator.status':
      return { running: false, teamName: 'default-team', roles: ['leader', 'frontend_dev', 'backend_dev'] } as T
    case 'orchestrator.start':
    case 'orchestrator.stop':
      return { success: true } as T
    case 'orchestrator.getRuns':
      return [
        { id: 'run-mock-001', requirement_id: 'req-mock-1', team_config: '{}', status: 'completed', leader_decision: '{"decision":"single_worker","reason":"简单需求，分配给前端开发","assignments":[{"role":"frontend_dev","title":"添加用户头像组件","description":"在个人设置页添加头像上传和裁剪功能"}]}', reject_feedback: null, created_at: '2026-04-09T10:00:00Z', completed_at: '2026-04-09T10:15:00Z' },
        { id: 'run-mock-002', requirement_id: 'req-mock-2', team_config: '{}', status: 'running', leader_decision: '{"decision":"split","reason":"需要前后端配合","assignments":[{"role":"frontend_dev","title":"登录表单 UI","description":"实现登录页面"},{"role":"backend_dev","title":"登录 API","description":"实现认证接口"}]}', reject_feedback: null, created_at: '2026-04-09T11:00:00Z', completed_at: null },
        { id: 'run-mock-003', requirement_id: 'req-mock-3', team_config: '{}', status: 'failed', leader_decision: null, reject_feedback: null, created_at: '2026-04-09T09:00:00Z', completed_at: '2026-04-09T09:05:00Z' },
      ] as T
    case 'orchestrator.getRunDetail':
      return {
        run: { id: params.runId, requirement_id: 'req-mock-1', team_config: '{}', status: 'completed', leader_decision: '{"decision":"single_worker","reason":"简单前端任务"}', reject_feedback: null, created_at: '2026-04-09T10:00:00Z', completed_at: '2026-04-09T10:15:00Z' },
        assignments: [
          { id: 'assign-1', run_id: params.runId, role: 'frontend_dev', title: '添加用户头像组件', description: '在个人设置页添加头像上传和裁剪功能', acceptance_criteria: '支持 jpg/png，最大 5MB', worktree_path: '/tmp/worker-1', branch_name: 'orchestrator/run-mock/frontend-a1b2c3', status: 'completed', agent_provider: 'claude-code', agent_model: 'claude-sonnet-4-20250514', error_message: null, created_at: '2026-04-09T10:01:00Z', completed_at: '2026-04-09T10:14:00Z' },
        ],
      } as T
    case 'orchestrator.getEvents':
      return [
        { id: 1, run_id: 'run-mock-001', assignment_id: null, event_type: 'leader_started', payload: '{"requirement":"req-mock-1"}', created_at: '2026-04-09T10:00:00Z' },
        { id: 2, run_id: 'run-mock-001', assignment_id: null, event_type: 'requirement_analyzed', payload: '{"decision":"single_worker","reason":"简单前端任务","assignment_count":1}', created_at: '2026-04-09T10:00:30Z' },
        { id: 3, run_id: 'run-mock-001', assignment_id: 'assign-1', event_type: 'task_assigned', payload: '{"role":"frontend_dev","title":"添加用户头像组件"}', created_at: '2026-04-09T10:01:00Z' },
        { id: 4, run_id: 'run-mock-001', assignment_id: 'assign-1', event_type: 'worker_started', payload: '{"role":"frontend_dev","branch":"orchestrator/run-mock/frontend-a1b2c3"}', created_at: '2026-04-09T10:01:05Z' },
        { id: 5, run_id: 'run-mock-001', assignment_id: 'assign-1', event_type: 'worker_completed', payload: '{"output":"已完成头像组件开发"}', created_at: '2026-04-09T10:14:00Z' },
        { id: 6, run_id: 'run-mock-001', assignment_id: null, event_type: 'run_completed', payload: null, created_at: '2026-04-09T10:15:00Z' },
      ] as T
    case 'orchestrator.dispatchRequirement':
      return { dispatched: true } as T
    case 'orchestrator.cancelRun':
    case 'orchestrator.rejectRun':
    case 'orchestrator.retryAssignment':
    case 'orchestrator.pauseAssignment':
    case 'orchestrator.saveTeamConfig':
    case 'orchestrator.createDefaultConfig':
      return { success: true } as T
    case 'orchestrator.getTeamConfig':
      return {
        name: 'default-team',
        description: '默认多 Agent 开发团队',
        polling: { interval_seconds: 30, board_filter: { status: 'pending' } },
        roles: {
          leader: { description: '分析需求、拆分任务、分配给合适的角色', provider: 'claude-code', model: 'claude-sonnet-4-20250514', prompt_template: '你是一个技术 Leader…' },
          frontend_dev: { description: '前端开发工程师', provider: 'claude-code', model: 'claude-sonnet-4-20250514', prompt_template: '你是一个高级前端开发工程师…' },
          backend_dev: { description: '后端开发工程师', provider: 'claude-code', model: 'claude-sonnet-4-20250514', prompt_template: '你是一个高级后端开发工程师…' },
        },
      } as T
    case 'orchestrator.getRawTeamYaml':
      return { yaml: '# Mock team.yaml' } as T
    case 'task.get':
      return {
        id: params.id,
        requirement_id: '',
        repo_id: '',
        branch_name: '',
        change_id: '',
        current_stage: '',
        current_phase: '',
        phase_status: '',
        openspec_path: '',
        worktree_path: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T
    default:
      console.warn(`Sidecar mock: unhandled RPC ${method}`)
      return undefined as T
  }
}

export async function startSidecar(): Promise<void> {
  if (!isTauri()) {
    sidecarReady.value = true
    console.warn('Sidecar: running in mock mode (no Tauri)')
    return
  }

  if (childProcess)
    return

  const command = __USE_SIDECAR_BIN__
    ? Command.sidecar('binaries/sidecar', ['--project-root', __PROJECT_ROOT__])
    : Command.create('node', [__SIDECAR_SCRIPT__])
  command.stdout.on('data', (line: string) => {
    buffer += line
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const l of lines) {
      if (!l.trim())
        continue
      try {
        const response = JSON.parse(l)
        const pending = pendingRequests.get(response.id)
        if (pending) {
          pendingRequests.delete(response.id)
          if (response.error)
            pending.reject(new Error(response.error.message))
          else
            pending.resolve(response.result)
        }
      }
      catch {
        /* ignore non-JSON lines */
      }
    }
  })

  command.stderr.on('data', (data: string) => {
    console.warn('[sidecar:stderr]', data)
    if (data.includes('sidecar: ready'))
      sidecarReady.value = true
  })

  command.on('error', (err: string) => {
    console.error('[sidecar:error]', err)
  })

  command.on('close', (data: { code: number | null, signal: number | null }) => {
    console.warn('[sidecar:close]', data)
    childProcess = null
  })

  try {
    childProcess = await command.spawn()
    console.log('[sidecar] spawned pid:', childProcess.pid)
  }
  catch (err) {
    console.error('[sidecar] spawn failed:', err)
  }
}

export async function rpc<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  if (!isTauri())
    return mockRpc<T>(method, params)

  if (!childProcess)
    throw new Error('Sidecar not started')

  const id = ++requestId
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params })

  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    childProcess!.write(`${request}\n`)
  })
}
