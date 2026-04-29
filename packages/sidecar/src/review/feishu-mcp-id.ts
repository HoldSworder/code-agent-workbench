/**
 * 飞书项目 MCP 的固定逻辑 id（业务约定，非 SQL 强约束）。
 *
 * - 通过 MCP 页"快捷配置卡片"创建/更新该 MCP 时，以此 id 落库。
 * - sidecar 运行时仍通过 `is_feishu_project=1` 标记位定位（兼容历史记录）。
 * - 与历史 `name='lark-project'` 记录共存：启动时一次性迁移把旧记录置标记。
 */
export const FEISHU_PROJECT_MCP_ID = 'feishu-project'

/** 快捷卡片创建时的默认显示名（用户可在卡片里修改）。受 mcp_servers.name UNIQUE 约束保护。 */
export const FEISHU_PROJECT_MCP_DEFAULT_NAME = '飞书项目 MCP'

/** 历史命名（v1 通过 findByName 定位时用），仅用于一次性迁移识别。 */
export const FEISHU_PROJECT_MCP_LEGACY_NAME = 'lark-project'
