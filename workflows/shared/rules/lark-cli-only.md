# 飞书文档操作规则

当需要获取、读取或操作飞书文档内容时，**必须且只能**使用 `lark-cli` 命令行工具，禁止使用其他方式（包括但不限于 WebFetch、curl 直接访问飞书 URL、浏览器工具等）。

## 操作方式

### 获取飞书文档内容

```bash
lark-cli docs get <doc_url_or_token>
```

### 搜索飞书文档

```bash
lark-cli docs search --query "<关键词>"
```

## 规则要求

- 遇到飞书文档链接（`*.feishu.cn/docx/*`、`*.feishu.cn/wiki/*` 等），一律通过 `lark-cli` 获取内容
- 如果 `lark-cli` 未安装或执行失败，**明确报告错误**，禁止静默降级为其他获取方式
- 禁止直接通过 HTTP 请求或浏览器工具抓取飞书文档页面
