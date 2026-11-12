# 按需修改插件

源码路径相对 `plugin/`。依赖安装与测试命令在仓库根目录执行。已加载的扩展修改后通过 `/reload` 或新会话生效。

## 1. 原生 256K 模式

必须改的两处：

```ts
// src/provider/models.ts
export const AGY_PI_SCHEDULING_CONTEXT_WINDOW = 256_000; // 原为 512_000，以补丁为前提
```

```ts
// src/native/native-results.ts
function upgradeCheckpoint512k(ckpt: Buffer): Buffer {
  return ckpt; // 未打补丁：不把老会话的 checkpoint 改成 512K（原版 agy 上那样改的后果没验证过）
}
```

随之更新的测试：

- `test/model-window.test.mjs`：期望值 `512_000` 改 `256_000`（gpt-oss 的 98,304 不变）。
- `test/native-results.test.mjs`：`legacy migration adds tools and 512k ...` 这条断言的是 512K 字节 `[0x28, 0x80, 0xa0, 0x1f]`，改成断言仍为 256K 字节 `[0x28, 0x80, 0xd0, 0x0f]`，标题同步改。
- `test/golden/baseline.json`：按第 8 节重新生成。

想两种模式来回切，可以把常量改成读环境变量（例如 `PI_AGY_CONTEXT_WINDOW`，默认 512000），并让 `upgradeCheckpoint512k` 在窗口不是 512000 时直接返回。这是建议做法，本工具包没有实现。

## 2. agy 单条输入上限变了

`src/input/pi-input.ts`：`MAX_NATIVE_INPUT_BYTES = 176_000`（重建首条输入的总预算），`RESERVED_RECEIPT_BYTES = 16_000`。

agy 换版本后先实测新上限（末尾口令法，见 `pitfalls.md`），预算取实测上限减去一点余量。只改常量，不改切分逻辑；切分要保持确定性，工具循环重入时请求内容才不变。

## 3. Pi 侧压缩

`~/.pi/agent/settings.json`（或项目 `.pi/settings.json`）：

```json
{ "compaction": { "enabled": true, "reserveTokens": 65536, "keepRecentTokens": 20000 } }
```

- `reserveTokens` 决定何时开始压缩（剩余空间低于它时），默认 16384。512K 下建议加大，见 `pitfalls.md`。
- `compaction.modelOverrides` 可以按模型调这些数字。
- 要让摘要换模型写，需要 Pi 扩展接管压缩，参考 Pi 文档 `docs/compaction.md` 和 `examples/extensions/custom-compaction.ts`。

## 4. 原生工具

`execution-surface.json` 的 `native_tools`，默认 `["view_file", "generate_image"]`。

- 去掉 `view_file` 会让这些功能失效：读归档历史、读超长请求的全文、图片输入（插件靠 `view_file` 把图片交给模型）。插件按是否包含 `view_file` 决定能不能给模型归档路径。
- 加别的原生工具（终端、写文件等）会绕过 Pi 的权限钩子和白名单，慎重。
- 原生工具白名单变化会更新合同哈希；生成 agent 在下一轮通过事务迁移现有会话配置，非生成 agent 重建会话。

## 5. 模型能力和价格

`src/provider/models.ts`：

- `capabilitiesForModel`：每个模型的 `maxTokens`、输入模态（text / image）、窗口。新出的模型系列默认只声明 text，确认支持读图后再加。
- `pricingForModel`：只影响 Pi 里显示的费用估算。

## 6. 路径和环境变量

- `AGY_BINARY`：agy 可执行文件，优先于 macOS 自动副本选择。
- `AGY_TURN_TIMEOUT_MS`：模型步骤预算，默认 0。
- `AGY_STALL_TIMEOUT_MS`、`AGY_TOOL_STALL_TIMEOUT_MS`：普通和工具静默时限，默认 300,000、600,000 毫秒；0 表示禁用。
- `JETSKI_APP_DATA_DIR`：agy 数据目录（默认 `~/.gemini/antigravity-cli`），插件读写会话库时也认它。
- `PI_CODING_AGENT_DIR`：Pi agent 目录，插件的桥配置和模型缓存跟着走。
- 写回 Pi 历史的工具结果截到 16,000 字符：`src/extension/wrapper-tool.ts`、`src/provider/native-cards.ts`（`view_file` 不截）。

## 7. 运行中插话的提示文字

插话随工具结果交给 agy 时，前面那段说明文字在 `src/input/prompt.ts` 的 `steerNoticePrompt`。模型不理会插话时可以改这段措辞；改了会改变模型可见输出，`golden.test.mjs` 会报红，按下一节重新生成基线。

不要恢复“最新用户消息变了就中止原生轮次”的写法（旧版 `runtime.ts` 的 `#attachOrStart`），原因见 `pitfalls.md`。

## 8. 跑测试

在开发副本的仓库根目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
python3 -I skills/agy-native-setup/scripts/test_keepalive_patch.py
node --test plugin/test/bridge-reload.e2e.mjs
```

默认测试使用临时文件和离线活动，不启动 AGY，不调用模型。Pi SDK、TUI 和 TypeBox 的开发实体版本固定在根目录 `package-lock.json`。

已安装 Pi SDK 的离线工具回放：

```sh
PI_STACK_PI_ROOT="<已安装的 pi-coding-agent 包目录>" \
  node --test plugin/test/replay-allowlist.e2e.mjs
```

`plugin/test/golden/baseline.json` 记录模型输入、工具合同和活动序列。改变这些内容后需逐项核对预期变化，再更新对应数据。
