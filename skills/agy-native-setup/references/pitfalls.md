# 坑点

按现象查。每条写了原因和处理；没在作者机器上复现过的会注明。

## 窗口与压缩

### Pi 显示上下文还剩很多，模型却突然忘了前面的内容

- 原因：没打补丁（或补丁被 agy 升级覆盖），原生预算只有 256K，插件却按 512K 给 Pi 报窗口。agy 在原生侧先做了 checkpoint 压缩，后续请求只剩摘要。
- 处理：`agy_window_patch.py status`。`applied` 以外的状态，要么打补丁，要么按 `modifications.md` 第 1 节改成 256K。用 `check_native_window.py` 在新会话上确认实际窗口。

### agy 升级后出现上面的症状

- 原因：agy 自更新换掉了 exe，补丁没了，`status` 显示 `unknown`。
- 处理：重新定位补丁（`window-patch.md`），或改 256K。**不要**把旧版本打过补丁的 exe 拷到新版本上。

### 压缩之后，摘要漏掉了中间一大段

- 原因：Pi 默认用当前模型写压缩摘要，摘要请求也走 agy。窗口 512K 时压缩在约 495K token 才触发，序列化的历史远超 176,000 字节，插件只能保留开头和结尾、省略中间（同时注明省略范围），所以摘要只覆盖首尾。
- 处理：让压缩摘要换一个能直接吃大输入的模型写。Pi 的扩展可以接管压缩，参考 Pi 文档 `docs/compaction.md` 的自定义压缩一节和 `examples/extensions/custom-compaction.ts`。作者自己的环境用的是另写的压缩扩展，没有放进本工具包。没条件换写手时，至少知道这时的摘要不完整。

### 想确认模型是否收到了完整输入，去会话库里看

- 原因：库里 `steps.step_payload` 存的是全文，但 agy 只把前 192,000 字节交给模型。
- 处理：用末尾口令法测：构造指定字节数的输入，最后一行放随机口令，问模型口令是什么，二分出上限。

### Pi 的自动压缩来得比原生 checkpoint 晚

- 原因：Pi 默认 `compaction.reserveTokens = 16384`，512K 下约 495K 才压缩，很贴近原生 512K。一轮里原生 `view_file` 连读大量文件时，Pi 在回合边界才检查，可能被原生 checkpoint 抢先。
- 处理：`~/.pi/agent/settings.json` 里加大 `compaction.reserveTokens`（例如 65536，约 446K 触发）。只影响何时开始压缩，不影响保留多少。未专门复现。

### 手动 `/compact` 后反复出现 `This operation was aborted`

- 原因：旧版插件压缩后仍续用旧的大原生会话。1.1.1 起已修（压缩后重置原生会话）。
- 处理：改 `session_compact` 相关钩子时保留重置逻辑；见 `design.md` 第 3 节。

### agy 干活时插一句话，它前面规划好的步骤作废、缓存全冷

- 原因：1.1.1 及更早版本把 Pi 的插话（steer，Pi Web 运行中直接回车即是）当成新回合：发现“最新用户消息变了”就中止并杀掉 agy，再用插话重开一轮。已规划的后续工具作废，挂起的推理档位切换趁机生效，缓存从头算。
- 处理：1.1.2 已修，插话放在 agy 正在等的那个工具结果最前面一起交回，进程不重启；当时没有工具在等就先挂起，agy 先结束则在同一原生会话续一轮。自己改 `runtime.ts`/`stream.ts` 时保留这条行为。作者在 Pi 1.4.0 上实测：旧版原生会话出现 2 条用户输入（被重开），新版 1 条。
- 只有“当时没有工具在等结果”那条路径只做过离线测试。

### 界面显示"AGY 已压缩"，实际没有

- 原因：原生事件流没有压缩事件，横幅是按用量骤降推测的。
- 处理：以 `check_native_window.py` 或会话库的 checkpoint 步骤为准。

## 安装

### 删掉解压目录后插件不见了

- 原因：`pi install <本地路径>` 直接从该路径加载，不复制。
- 处理：先把 `plugin/` 放到长期目录再安装。

### 在插件目录跑了 `npm install`，之后出现扩展警告或奇怪的重复初始化

- 原因：本地包的依赖 Pi 不管，npm 把 `peerDependencies` 里的 Pi 宿主包装成了实体副本。
- 处理：删掉 `node_modules`，用 `npm install --omit=dev --legacy-peer-deps --no-package-lock` 重建，应只剩 `@bufbuild/protobuf`、`semver`、`which`、`isexe`。

### 有两个 `antigravity` provider，或模型列表忽有忽无

- 原因：同时装了上游 `@tian.zuo/pi-antigravity` 和本插件。
- 处理：`pi list` 后 `pi remove` 掉其中一个。

### 首次 `--list-models` 的模型发出去报 `model ... is not recognized as a known model`

- 原因：第一次运行没有模型缓存，列出的是 `src/provider/models.ts` 里的内置备用清单（`FALLBACK_MODELS`），会随 agy 改名过时。插件同时在后台跑 `agy models` 写入 `<Pi agent 目录>/antigravity/model-list.json`。
- 处理：再运行一次 `pi --list-models antigravity`，用真实 id。缓存 24 小时刷新；需要时可更新备用清单。作者在干净 Pi 1.4.0 上复现过。

### `agy was not found on PATH or at ~/.gemini/bin/agy`

- 处理：设置环境变量 `AGY_BINARY` 指向 agy 可执行文件，或把 agy 所在目录加进 PATH。agy 数据目录不在默认位置时设 `JETSKI_APP_DATA_DIR`。

## 补丁

### 打补丁后 agy.exe 被系统拦截，或签名显示无效

- 原因：agy.exe 带 Authenticode 签名，改 5 个字节后签名校验失败。作者机器能正常运行；开了 Smart App Control、WDAC 或公司策略的机器可能拦。未在这类机器上实测。
- 处理：`agy_window_patch.py restore` 精确还原；策略不能放行时走 256K 路线。

### `apply` 报 `cannot move ... aside`

- 原因：exe 被锁定，通常是还有 agy 或 Pi 会话在跑。
- 处理：关掉所有 Pi 会话和 agy 再试。替换成功但留下 `*.old` 时，是旧文件仍被运行中的 agy 占用，agy 退出后删掉即可。

### `refusing: no recipe has ... as its base`

- 原因：这台机器的 agy.exe 和配方不是同一个构建（版本不同，或同版本但文件不同）。脚本按完整 SHA256 判断，宁可拒绝也不往别的构建里写固定偏移。
- 处理：`window-patch.md` 的重新定位流程，或走 256K。

## 行为

### 模型要多调一次 `view_file` 才看到工具结果

- 原因：AGY 原生对超过 10,240 字节的工具结果可能仅提供全文路径。插件桥会保存全文并返回有界的首尾摘要；原生工具自身输出不受此处理控制。
- 处理：首尾摘要不足时由模型读取全文。

### 工具卡片显示 `AGY replay only: <工具名>; no Pi tool executed`

- 原因：会话用 `-t/--tools` 白名单排除了 `antigravity` wrapper，原生步骤只能以文字记录回放。
- 处理：正常行为；需要卡片就把 `antigravity` 加进白名单。

### gpt-oss 窗口只有 98,304，也不能发图

- 原因：agy 给这个模型的原生工作预算就是 98,304；目录里它只支持文本。
- 处理：设计如此。

### 音视频附件没有时长

- 原因：时长靠可选的 `ffprobe`（PATH）。没装就只记录原因。

## 开发与测试

### 改了窗口后 `golden.test.mjs` 报红

- 原因：`test/golden/baseline.json` 是模型和 Pi 可见输出的逐字节基线，里面记录了 512000。
- 处理：有意修改时重新生成基线，见 `modifications.md` 第 8 节；生成后只允许你改的那部分字段变化。

### 跑测试报 `Cannot find package '@earendil-works/pi-ai'`

- 原因：安装目录的 `node_modules` 不含 Pi 宿主包（这是对的），测试需要它们。
- 处理：在开发副本的仓库根目录运行 `npm ci` 安装锁定的开发依赖后再测，见 `modifications.md` 第 8 节。
