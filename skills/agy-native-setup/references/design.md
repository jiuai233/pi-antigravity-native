# 设计思路

改插件前读一遍：哪些行为是刻意的、为什么这样做、改了会坏什么。源码路径相对 `plugin/`。

## 1. 谁管什么

| 角色 | 负责 |
| --- | --- |
| agy CLI | 跑模型；保存原生会话（`~/.gemini/antigravity-cli/conversations/<id>.db`，SQLite + protobuf）；原生 checkpoint 压缩；原生工具 `view_file`、`generate_image` |
| Pi | 会话历史和分支、工具执行与权限钩子、压缩、界面 |
| 插件 | 把两边接起来：Pi 请求 → agy 输入；agy 事件 → Pi 消息；Pi 工具 ↔ agy 的 MCP 桥 |

总原则：**Pi 的历史是唯一真源**。原生会话只是为了 prompt cache 和原生工具而续接的副本，两边对不上时丢原生会话、按 Pi 重建，不反过来。

## 2. 工具怎么到 agy 手里

- Pi 的工具经每个 Pi 会话实例一个的本地 MCP 桥交给 agy，agy 侧看到的是 `call_mcp_tool`。真正执行在 Pi 里，所以 Pi 的权限钩子、`-t/--tools` 白名单、codemode（`on`/`only`、`inlineBudget` 目录裁剪）照常生效。
- 每次请求按 Pi 当前生效的工具重新生成 agent 定义、schema 文件和 MCP `tools/list`，工具变化不用重启。
- 原生工具只开 `view_file`（读文件、读图、读归档）和 `generate_image`，声明在 `execution-surface.json`。终端、搜索等原生能力不开，免得绕过 Pi 的权限钩子。
- 隔离：agent 定义写在 `~/.gemini/config/agents/pi-native-<实例ID>/agent.md`，带完整 Pi 系统提示快照；MCP 发现配置写在 `<Pi agent 目录>/antigravity/bridges/<实例ID>/.agents/mcp_config.json`，通过附加发现目录传给 agy，不写进项目自己的 `.agents`。桥的临时地址和凭据只进私有配置，不进会被 agy 持久化的 agent 定义。会话正常退出时回收本实例的文件；崩溃遗留不批量清，免得误删别的实例。
- 模型目录缓存：`<Pi agent 目录>/antigravity/model-list.json`，跟随 `PI_CODING_AGENT_DIR`。
- 原生步骤回放：agy 的流事件常常只给"读了某文件"的摘要。插件从原生会话库补回真实行号、正文、错误和图片，通过 `antigravity` wrapper 只读回放成 Pi 工具卡片，不让 Pi 再执行一次 read/grep。多张回放卡在模型响应边界合并成一条 Pi 消息，真实的桥接调用立即交接。

## 3. 续接还是重建

平时续接同一个原生 conversation，只发 Pi 这一轮新增的用户批次：agy 侧缓存热，原生工具结果完整保留。

下面任一情况发生，丢弃原生会话，下一轮用 Pi 当前分支重建：

- Pi 压缩完成（`session_compact`）
- 切分支（`/tree`）
- 换走模型再换回
- cwd、模型或原生 profile 变化
- 非生成 agent 的系统提示或工具合同变化

生成 agent 的系统提示或工具合同变化时，通过事务更新原生元数据中的 agent 正文和 MCP 配置，保留会话 id；迁移不兼容时报告错误。桥身份由 agent 目录、cwd 和 Pi 会话 id 确定，`<Pi agent 目录>/antigravity/bridge-leases.db` 的 `bridge_lease` 表防止并发实例抢占同一身份。

Pi 压缩后必须重建的原因：早期版本压缩后仍续用旧原生会话，Pi 显示上下文降了，agy 里还有四十多万 token；按 agy 上报用量触发的自动压缩于是反复启动，每次先 `abort` 当前请求，界面不停显示 `This operation was aborted`。重置标记会写进 Pi 会话，reload 后也不会接回旧会话。

### 运行中插话（steer）不重启 agy

Pi 的插话（Pi Web 运行中直接回车即是）排在当前工具批次之后、下一次模型调用之前，所以插件重入时看到的“最新用户消息”变了。这不是新回合，正在跑的原生轮次接管它：

- agy 正在等某个 Pi 工具结果：插话放在那个结果最前面一起交回（`src/input/prompt.ts` 的 `steerNoticePrompt`，注明来自用户、优先于原计划），agy 下一次推理就能看到。
- 当时没有等待中的工具结果（回放卡片边界）：插话挂在轮次上，随下一个工具结果送达；agy 先结束本轮，就在同一条 Pi 消息内、同一原生会话续一轮，把插话作为输入发过去（`src/provider/stream.ts` 的 `#followSteer`）。
- provider 流在结果之前失败的轮次标记为脱钩，不接管插话，新消息替换它；Esc 照常中止。

为什么不杀掉重开：杀掉会让已规划的后续工具作废、挂起的推理档位切换生效、缓存从头算，Pi 已执行的副作用还得另外补交接。1.1.1 及更早版本就是这么做的。

## 4. 输入预算：192,000 字节这道坎

实测方法：在输入末尾放一个随机口令，问模型口令是什么。agy 1.4.12 只把**单条输入的前 192,000 UTF-8 字节**交给模型：184,968 字节时口令可见，200,505 和 245,013 字节都不可见。会话库存的是全文，**库里完整不代表模型看到了**。中文一个字 3 字节，比按字符估算紧得多。

插件因此这样处理：

- 最终输入 ≤ 176,000 字节（`src/input/pi-input.ts` 的 `MAX_NATIVE_INPUT_BYTES`）。历史最多先按 172,000 字节分 4 次预填，再提交当前输入。预填会发起真实模型请求。放不下的历史写入归档文件，输入保留全文路径和恢复提示。
- 重建时保留当前请求里**已有结果**的工具调用和结果，避免模型重复执行；没有结果的调用不算完成。
- 当前请求本身超长：按行边界保留开头和结尾，注明省略的行号；有 `view_file` 时把全文归档并要求模型先读。切法是确定性的，工具循环重入时请求内容不变。

## 5. 压缩

- 不调用 agy 原生 `/compact`（启动参数带 `--disable-slash-commands`）。原生压缩要多付一次摘要费用，摘要和 Pi 显示的不一致，失败时还得回落到重置。
- Pi 的压缩摘要和分支摘要请求同样走这个 provider，但放进一次性原生会话，不写进用户原生会话的历史。摘要请求也受 192KB 限制，后果见 `pitfalls.md`。
- 原生事件流里没有"压缩了"的事件，插件按用量骤降推测并显示横幅；runtime 主动丢弃会话时补发 `conversation_fallback`，不把换新会话误记成原生压缩。

## 6. 窗口

- 原版 agy：settings.json 里存 `contextWindow: "512K"`，但原生预算仍是 256K，因为 `Store.ContextWindow` 不读保存值。补丁让它读保存值，预算变成 512K。机制见 `window-patch.md`。
- 插件给 Pi 报的窗口：`src/provider/models.ts` 的 `AGY_PI_SCHEDULING_CONTEXT_WINDOW = 512_000`（gpt-oss 固定 98,304）。这个数字**以打了补丁为前提**。
- 续接老会话前，插件在一个 SQLite 事务里把会话库的 256K checkpoint 改成 512K，并对齐原生工具过滤（`src/native/native-results.ts` 的 `upgradeNativeConversationDb`，幂等）。

## 7. 其它刻意行为

- 超过 10,240 字节的桥接工具结果保存为本地全文文件，并向原生模型返回有界的首尾摘要和路径。原生工具自身的长输出仍由 AGY 管理。写回 Pi 历史的工具结果截到 16,000 字符（`view_file` 除外）。
- 图片：在请求边界把 Pi 的图片块存成原图文件，把路径交给原生 `view_file`；聊天历史保留原始图片块，内部路径和读图指令不写进用户消息。Gemini、Claude 系列声明支持 text+image，GPT-OSS 和未核实的系列只声明 text。
- 用量：Pi 的 `totalTokens` = input + output + cacheRead（thinking 已计入 output），避免上下文估算漏掉缓存输入。
- 终态归属：支持历史错误残留和当前轮 EOF、500、503 重试成功的纠正。校验当前轮已完成、多段回答与返回一致、最终没有待执行工具；权限等非瞬时 API 错误保持失败。纠正过程只读原生数据库。
- 等待策略：模型步骤默认不限总时长；普通静默 300,000 毫秒、原生工具静默 600,000 毫秒触发恢复，等待 Pi 工具结果期间暂停计时。
- 前缀诊断：记录哈希、计数和请求阶段耗时，不修改提示词，不记录思考及签名原文。可选缓存保活由原生二进制副本提供，见 [保活说明](keepalive-patch.md)。
- 媒体审计：回合结束后把原生转录里真实收到的附件写成 Pi 自定义条目 `pi-antigravity-native-media`（哈希、字节数、mime；装了 ffprobe 时附时长）。这是"收到了附件"的证据，不是"模型看懂了"的证据。
- 闭卷 profile `evidence_only_v1` 只在子代理 runner 提供任务包时启用，普通使用不涉及。
