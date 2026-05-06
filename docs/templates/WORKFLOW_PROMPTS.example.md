# Workflow

本文档是一个通用 `WORKFLOW_PROMPTS.md` 模板骨架，用来说明：

- 如何声明默认执行流程
- 如何定义节点级 Prompt
- 如何约束“禁止追问、必须落盘、信息不足时做最小假设”

请按你的项目实际节点、技能和产物路径替换下面的占位内容，不要直接照搬节点名称或输出文件名。

## 可用变量示例

```text
{{taskId}}
{{taskTitle}}
{{taskPrompt}}
{{gitBranch}}
{{gitBaseBranch}}
{{gitWorktreePath}}
{{projectName}}
{{projectDefaultBranch}}
```

## Agents 默认执行流程

按照如下流程执行，并且必须保证顺序：

1. 阶段一
   - `NodeA`
   - `NodeB`

2. 阶段二
   - `NodeC`

## 节点 Prompt 模板

### NodeA

```text
使用 `<your-skill-name>` 技能，基于以下输入完成本节点目标：
{{taskPrompt}}

项目信息：
- 项目：{{projectName}}
- 任务：{{taskTitle}}
- 分支：{{gitBranch}}
- 工作目录：{{gitWorktreePath}}

输出要求：
1. 不要向用户追问问题，不要只输出“待确认项”后停止。
2. 如果信息不足，只允许做最小必要假设，并在产物中单独列出“假设与风险”或“待确认项”。
3. 必须将结果写入约定文件，例如 `docs/{{gitBranch}}/<your-artifact>.md`。
4. 不允许只在 stdout 输出分析而不落盘。
5. 最终回复应简短说明产物已生成到指定路径。
```

推荐配置：

- `requiresApproval: false`
- `loopEnabled: false`
- `maxLoops: 1`

### NodeB

```text
使用 `<your-skill-name>` 技能，优先基于上游产物完成本节点任务。

输入示例：
- 原始需求：{{taskPrompt}}
- 上游产物：`docs/{{gitBranch}}/<upstream-artifact>.md`

项目信息：
- 项目：{{projectName}}
- 任务：{{taskTitle}}
- 分支：{{gitBranch}}
- 工作目录：{{gitWorktreePath}}

输出要求：
1. 若上游产物缺失或信息不足，只允许做最小必要假设。
2. 所有假设必须单独列出，不得混入正式结论。
3. 必须将结果写入约定文件，例如 `docs/{{gitBranch}}/<next-artifact>.md`。
4. 不允许只在 stdout 输出总结而不写文件。
```

推荐配置：

- `requiresApproval: false`
- `loopEnabled: false`
- `maxLoops: 1`

### NodeC

```text
使用 `<your-skill-name>` 技能执行实现、校验或收尾工作。

输入示例：
- 原始需求：{{taskPrompt}}
- 相关文档：`docs/{{gitBranch}}/<artifact>.md`

项目信息：
- 项目：{{projectName}}
- 任务：{{taskTitle}}
- 默认分支：{{projectDefaultBranch}}
- 当前分支：{{gitBranch}}
- 工作目录：{{gitWorktreePath}}

执行要求：
1. 直接修改仓库或更新指定产物，不要只给方案不执行。
2. 不要向用户追问问题。
3. 信息不足时只允许做最小必要假设，并单列风险与待确认项。
4. 必须写入约定结果文件，例如 `docs/{{gitBranch}}/<result>.md`。
5. 如果这是循环节点，可在结果文件中写入状态与原因，供工作流判断是否继续。
```

推荐配置：

- `requiresApproval: false`
- `loopEnabled: true`
- `maxLoops: 3`

## 使用说明

- 将 `NodeA`、`NodeB`、`NodeC` 替换为你的真实节点名。
- 将 `<your-skill-name>` 替换为节点实际优先使用的技能。
- 将 `docs/{{gitBranch}}/<...>.md` 替换为你的真实产物路径。
- 如果你的节点允许循环，建议为循环节点单独约定结果文件和退出标记。
- 如果你的项目不希望节点追问用户，务必在每个节点 Prompt 中重复写明“不要向用户追问问题”。
