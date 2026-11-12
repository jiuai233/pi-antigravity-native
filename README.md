# Pi Antigravity Native

将 Antigravity（`agy` CLI）接入 Pi，复用 Pi 的聊天界面、工具、技能和会话记录。当前版本为 1.3.0。

## 功能

- AGY 模型选择、推理档位、持久进程与原生会话续接。
- 将 AGY 的公开思路摘要显示为标准 Pi 思考块，支持展开、折叠、保存和重开。
- Pi 工具与技能桥接，原生工具结果回放，以及运行中插话。
- 图片输入、原生媒体记录、后台任务、产物和配额面板。
- 稳定工具、技能和桥接身份，提供前缀指纹、缓存用量和请求阶段耗时诊断。
- macOS 自动选择已安装的 512K 或保活副本，并默认禁用副本自动更新；显式 `AGY_BINARY` 优先。

## 环境

- Node.js 24.15+，或 Node.js 26+。
- Pi 1.4+；本分支的离线回归和扩展装载使用 Pi SDK 1.5.0。
- 已自行安装并登录的 AGY CLI。当前窗口补丁配方对应 AGY 1.4.12。
- 窗口核验脚本使用 Python 3。

## 安装

```sh
pi install git:github.com/jiuai233/pi-antigravity-native@v1.3.0
```

已安装其他注册 `antigravity` provider 的插件时，先移除旧包，再安装本包。已打开的 Pi 会话执行 `/reload`。

本地源码安装：

```sh
git clone --branch v1.3.0 https://github.com/jiuai233/pi-antigravity-native.git
cd pi-antigravity-native
npm ci --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund
pi install .
```

本地路径安装直接引用源码目录，安装后需保留该目录。运行依赖随 npm 安装；Pi SDK、TUI 和 TypeBox 由 Pi 宿主提供。

## 512K 窗口

插件默认向 Pi 声明 512,000 token，并在续接旧原生会话时将 256K 检查点升级为 512K。**启用此配置需要已验证的 AGY 窗口补丁，以及原生设置中的 `"contextWindow": "512K"`。** 单独修改 Pi 显示值无法扩大原生窗口。GPT-OSS 保留原生 98,304 token 窗口。

macOS 上未显式设置 `AGY_BINARY` 时，按顺序选择已安装的 `~/.gemini/bin/agy-512k-keepalive`、`~/.gemini/bin/agy-512k`，并默认设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`；显式环境变量优先。插件不会创建或修改二进制。没有副本时沿用 AGY 的标准发现路径。

macOS arm64 的 AGY 1.4.12 补丁副本已有 512K 本地验证记录，Gemini 3.8 Flash 一次验证的最大输入为 427,399 token，三项回忆检查全部正确。这项记录属于既有 512K 定制，不代表新版思路显示已完成 Mac 真实模型验收。

Windows x64 的补丁与核验工具见 [安装技能](skills/agy-native-setup/SKILL.md)。未使用窗口补丁时，安装前按[修改说明](skills/agy-native-setup/references/modifications.md#1-原生-256k-模式)将窗口常量改为 256K，并关闭检查点升级。

## Mac 缓存保活

```sh
python3 -I skills/agy-native-setup/scripts/agy_keepalive_patch.py status
python3 -I skills/agy-native-setup/scripts/agy_keepalive_patch.py apply
AGY_BINARY="$HOME/.gemini/bin/agy-512k-keepalive" pi
```

脚本只接受已核验的 macOS arm64 AGY 1.4.12 512K 构建，创建独立副本并完成本地签名，拒绝覆盖已有文件。保活每 270 秒最多发送 6 次真实模型请求，会消耗缓存读取等用量。停用时显式设置 `AGY_BINARY="$HOME/.gemini/bin/agy-512k"` 并重启 Pi。进程退出、休眠及服务端路由变化可能使保活失效，详见[保活说明](skills/agy-native-setup/references/keepalive-patch.md)。

## 等待与恢复

模型步骤默认没有总时限；普通静默 5 分钟、原生工具静默 10 分钟触发恢复，等待 Pi 工具结果时暂停计时。对应环境变量为 `AGY_TURN_TIMEOUT_MS`、`AGY_STALL_TIMEOUT_MS`、`AGY_TOOL_STALL_TIMEOUT_MS`；设为 `0` 可关闭对应时限。

恢复长会话时最多发送 4 次历史预填请求，再处理当前输入；预填同样消耗模型额度。桥接租约存储在 Pi agent 目录的 `antigravity/bridge-leases.db` 中，前缀和运行状态可通过 `/agy`、`/agy doctor` 查看。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/agy` | 查看原生会话、窗口和进程状态 |
| `/agy reset` | 下一轮使用新的原生会话 |
| `/agy models` | 刷新 AGY 模型目录 |
| `/agy agents` | 查看原生代理 |
| `/agy doctor` | 检查二进制、模型和桥接状态 |
| `/agy-tasks` | 查看后台任务 |
| `/agy-artifacts` | 查看产物 |
| `/agy-usage` | 查看模型配额 |

## 公开思路与媒体等待

公开思路从当前原生响应步骤的公开 `thinking` 字段只读获取，默认每 200ms 读取一次，已收到文字按 40ms 小段显示。工具交接、结束、取消和错误时立即补齐已有内容。没有公开摘要时保留耗时、token 数等计量提示。该功能不增加模型请求，不读取 `raw_thinking` 或签名。

大媒体会话包含一个调用间隔策略：上一模型步骤之前保留的图片、音频、视频累计达到 10,000,000 字节时，下一次原生模型调用会补足距上一响应生成结束的 15 秒间隔。已达到间隔则直接继续。该策略按附件大小和时间触发，不检测上游缓存是否就绪。

- `PI_AGY_MEDIA_CACHE_SETTLE_MS`：间隔毫秒数，默认 `15000`；设为 `0` 可关闭额外等待。
- `PI_AGY_MEDIA_CACHE_MIN_BYTES`：媒体大小阈值，默认 `10000000`。

## 开发

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
python3 -I skills/agy-native-setup/scripts/test_keepalive_patch.py
node --test plugin/test/bridge-reload.e2e.mjs
```

默认测试不启动 AGY、不调用付费模型。可选的真实 Pi SDK 离线工具回放测试：

```sh
PI_STACK_PI_ROOT="<已安装的 pi-coding-agent 包目录>" \
  node --test plugin/test/replay-allowlist.e2e.mjs
```

真实摘要显示需在正常 AGY 对话中核验，详见[公开思路说明](skills/agy-native-setup/references/public-thinking.md)。

## 来源与许可

插件源自 [TianZuo555/pi-extensions](https://github.com/TianZuo555/pi-extensions)，保留原作者 Tian Zuo 的 MIT 版权声明。本分支包含公开思路显示、工具桥和 macOS 512K 配置适配。

源代码中的 macOS 补丁配方不包含 AGY 官方二进制，使用前需自行安装对应构建。

许可见 [LICENSE](LICENSE)。
