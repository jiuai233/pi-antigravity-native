# 公开思路（1.2.0）

## 显示的是什么

只读 AGY 当前会话 SQLite 的响应步骤，提取 protobuf `[20,3]` 中的公开摘要。它是原生公开文字，不是 raw thinking、签名或额外调用模型生成的总结；展示文字也不会拼回提示词。

上游分批落盘，插件默认每 200ms 读取。收到文字后按 40ms 小段显示，效果近似逐步输出，但首批摘要到达前仍需等待；显示增量数量不是推理 token 数量。

每个原生响应步骤使用独立思考块。工具交接、结束、取消和错误时立即补齐已收到文字，不让动画挡住工具或终态。取消仍是 aborted，失败仍是 error；已经收到的思路保留。

## 代码位置

路径相对 `plugin/`：

| 文件 | 职责 |
| --- | --- |
| `src/native/native-thinking.ts` | `NativeThinkingObserver`，只读轮询与公开字段解码；构造器默认间隔 200ms |
| `src/runtime/turn.ts` | 响应显示前沿、历史基线、步骤去重及工具交接水位 |
| `src/provider/message-writer.ts` | Pi 标准思考块、`THINKING_TICK_MS = 40`、边界立即补齐 |
| `src/extension/bridge-host.ts` | 传递原生 server/tool 身份，避免桥回调比 stdout 早到时串步骤 |
| `src/driver/reducer.ts` | CLI 步骤及响应结束事件 |

## 按现象检查

- **某轮没出现文字**：先确认该轮原生公开字段是否为空。原生没有公开摘要就不生成；token/耗时提示仍可保留。
- **文字一批批来**：这是原生落盘节奏。40ms 动画只平滑已收到文字，不提前制造内容；结束时一次补齐属于正常边界行为。
- **正文和工具正常，思路缺末段**：查 `pi-antigravity-turn-diagnostic` 中“公开思路末份未确认”。SQLite 暂时不可读时不阻塞正文或工具，不靠延长锁等待解决。
- **工具后或下一轮混入旧思路**：先核对加载版本确为 1.2.0，必要时正常重载该会话；修改代码时检查历史基线、显示前沿和桥身份水位，不只改解码器。

## 验证

在按 `modifications.md` 建立的开发副本中运行：

```powershell
node --test test/native-thinking.test.mjs test/public-thinking.test.mjs test/provider-batching.test.mjs
```

这些是离线合成数据，不调用模型。覆盖公开字段选择、分段展示、空摘要、取消/失败保留、数据库超前、桥回调提前与工具重入等。

真实效果用正常 Pi 对话检查：思考块、原生只读回放、真实 Pi 工具各按原路径工作；保存重开后文字仍在。有公开摘要的轮次才能核验文字显示，空轮次用于检查不串旧内容。真实对话会消耗账号原有模型额度，插件提取不额外发请求。
