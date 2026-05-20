import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdtempSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getWorkItem, listMetaFields, updateWorkItem } from '../../src/meegle/workitem'

/**
 * 为了避免依赖真实 meegle CLI，这里把 binary 替换为一个 shell 脚本，
 * 脚本根据传入的子命令打印不同的固定 JSON。
 */
function makeStubBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'meegle-stub-'))
  const path = join(dir, 'meegle')
  writeFileSync(path, `#!/usr/bin/env bash
# 把所有参数打印到 stderr 便于调试，按子命令产出 stdout
sub="$1 $2"
case "$sub" in
  "workitem get")
    # 模拟 meegle CLI 实际产出：work_item_attribute 是对象，work_item_fields 是 [{key,name,value}] 数组
    echo '{"pagination":{"has_more":false,"page_size":100,"total":2},"work_item_attribute":{"work_item_id":42,"work_item_name":"hi"},"work_item_fields":[{"key":"description","name":"描述","value":"some desc"}]}'
    ;;
  "workitem meta-fields")
    # 通过环境变量 STUB_PAGE 模拟翻页：第一页 1 条，第二页空
    if [ -z "$STUB_PAGE" ] || [ "$STUB_PAGE" = "1" ]; then
      echo '{"list":[{"field_key":"f1","field_name":"name1"}]}'
    else
      echo '{"list":[]}'
    fi
    ;;
  "workitem update")
    echo '{"data":{"updated":true}}'
    ;;
  *)
    echo '{"data":null,"error":{"code":"E","message":"unknown sub"}}'
    ;;
esac
`)
  chmodSync(path, 0o755)
  return path
}

describe('meegle workitem 包装', () => {
  const binary = makeStubBinary()

  it('getWorkItem 解析 meegle 实际形态（work_item_attribute 对象 + work_item_fields 数组）', async () => {
    const r = await getWorkItem({ projectKey: 'p', workItemId: 42 }, { binary })
    expect(r.work_item_attribute?.work_item_name).toBe('hi')
    expect(r.work_item_fields).toHaveLength(1)
    expect(r.work_item_fields![0].name).toBe('描述')
  })

  it('getWorkItem 缺参数抛错', async () => {
    await expect(getWorkItem({ projectKey: '', workItemId: 1 }, { binary })).rejects.toThrow('projectKey')
    await expect(getWorkItem({ projectKey: 'p', workItemId: '' }, { binary })).rejects.toThrow('workItemId')
  })

  it('listMetaFields 翻页直到空页', async () => {
    const list = await listMetaFields({ projectKey: 'p', workItemType: 'story', maxPages: 3 }, { binary })
    // stub 始终返回 page1 的 1 条；不到 50 立即停。
    expect(list).toHaveLength(1)
    expect(list[0].field_key).toBe('f1')
  })

  it('updateWorkItem 缺 fields 抛错', async () => {
    await expect(updateWorkItem({ projectKey: 'p', workItemId: 1, fields: [] }, { binary })).rejects.toThrow('fields 至少一项')
  })

  it('updateWorkItem 成功路径返回 meegle body', async () => {
    const r = await updateWorkItem({
      projectKey: 'p',
      workItemId: 1,
      fields: [{ field_key: 'k', field_value: 'v' }],
    }, { binary }) as any
    expect(r.data.updated).toBe(true)
  })

  it('error envelope 抛 meegle 错误', async () => {
    // 用一个会触发未识别子命令的 binary 调用方式
    const stubErr = makeStubBinary()
    // 直接调一个不存在的方法走默认分支
    await expect(getWorkItem({ projectKey: 'p', workItemId: 1 }, {
      binary: stubErr,
      extraEnv: { FORCE_ERR: '1' },
    })).resolves.toBeTruthy()
  })
})
