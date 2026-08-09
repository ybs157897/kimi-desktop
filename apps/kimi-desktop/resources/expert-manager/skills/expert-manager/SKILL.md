---
name: expert-manager
description: 通过对话创建或修改本地专家团，包括团长、成员、职责、工具权限和颜色标记。
---

# 专家团创建器

当用户要求创建、修改或设计专家团时，使用本 Skill。专家团是 Kimi 自己的本地配置；不要读取或依赖 WorkBuddy、其他应用的插件目录或配置文件。

## 工作流程

1. 先确认专家团解决的问题和预期交付物。
2. 和用户确定一个团长，以及至少一位成员。角色之间的职责必须互补，避免多个角色做同一件事。
3. 为每个角色确定显示名称、职责说明、系统提示词和工具权限。团长负责拆解、委派、核验和汇总；普通成员默认是叶子 Agent。
4. 确定颜色标记，可选值：`amber`、`coral`、`orange`、`mint`、`cyan`、`blue`、`violet`、`pink`。
5. 生成符合下方格式的 JSON 草稿，先向用户展示角色结构和权限摘要。只有用户确认后，才能执行保存命令。
6. 将 JSON 写入临时文件，然后运行：

```sh
node "${KIMI_SKILL_DIR}/scripts/expertctl.mjs" save /absolute/path/to/spec.json
```

7. 命令成功后，告诉用户生成的斜杠命令，例如 `/expert-code-review`。不要声称加载了未在命令输出中确认的外部配置。

修改已有专家团时，先运行：

```sh
node "${KIMI_SKILL_DIR}/scripts/expertctl.mjs" show TEAM_ID
```

## JSON 格式

```json
{
  "id": "code-review",
  "displayName": "代码审查专家团",
  "description": "从正确性和可维护性两个角度审查代码变更。",
  "color": "cyan",
  "lead": {
    "id": "lead",
    "displayName": "审查负责人",
    "description": "划定审查范围、分派成员并汇总结论。",
    "prompt": "你是代码审查负责人……",
    "toolPreset": "read-only"
  },
  "members": [
    {
      "id": "correctness",
      "displayName": "正确性专家",
      "description": "寻找可复现的逻辑错误和边界条件问题。",
      "prompt": "你是正确性审查专家……",
      "toolPreset": "read-only"
    }
  ],
  "quickPrompts": ["审查当前未提交变更"]
}
```

`id` 和角色 `id` 只能包含小写字母、数字和连字符。`toolPreset` 只能是 `read-only` 或 `full`。除非成员必须修改文件，否则优先使用 `read-only`。
