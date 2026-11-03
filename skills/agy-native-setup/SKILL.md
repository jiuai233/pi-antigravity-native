---
name: agy-native-setup
description: 安装 Pi Antigravity Native，核对 AGY 二进制、原生窗口和公开思路显示，处理 macOS 已有 512K 补丁副本及 Windows 1.4.12 窗口配方。
---

# 安装 Pi Antigravity Native

插件版本 1.2.0。仓库根目录包含 `package.json`、`plugin/` 和本技能目录。

## 1. 核对环境

- Node.js 24.15+ 或 26+；Pi 1.4+。当前开发依赖与离线装载使用 Pi SDK 1.5.0。
- AGY 已自行安装并登录；窗口补丁配方对应 AGY 1.4.12。
- 检查 `pi list`，避免同时安装多个注册 `antigravity` provider 的插件。
- 核对 `AGY_BINARY`、AGY 版本及原生设置中的 `contextWindow`。

## 2. 选择窗口

插件默认声明 512K，并在续接旧原生会话时升级其 256K 检查点。512K 配置需要原生窗口补丁和 `"contextWindow": "512K"` 同时有效。

### macOS

未显式设置 `AGY_BINARY`，且 `~/.gemini/bin/agy-512k` 存在时，插件自动使用该副本，并默认设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`。既有环境变量保留。插件不修改二进制。

macOS arm64 的 AGY 1.4.12 补丁副本已有本地 512K 验证。其它构建不能复用未核对的字节偏移。原生窗口读取方法见下文，补丁机制见 [窗口说明](references/window-patch.md)。

### Windows x64

只读检查：

```sh
python -I skills/agy-native-setup/scripts/agy_window_patch.py status
```

配方精确支持 AGY 1.4.12 Windows x64。修改二进制会使原数字签名失效；仅在明确选择窗口补丁后执行 `set-512k` 和 `apply`。更换 AGY 版本后需重新定位和验证。

### 原生 256K

未使用窗口补丁时，安装前按 [修改说明](references/modifications.md#1-原生-256k-模式)将窗口常量改为 256K，并关闭旧会话检查点升级。

## 3. 安装

GitHub 安装：

```sh
pi install git:github.com/jiuai233/pi-antigravity-native
```

本地源码安装在仓库根目录执行：

```sh
npm ci --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund
pi install .
```

Pi 本地路径安装引用源码目录，需长期保留。完整开发依赖仅在开发副本中安装；运行目录保留运行依赖，Pi SDK、TUI 和 TypeBox 由宿主提供。已有 Pi 会话执行 `/reload`。

## 4. 核验

1. `/agy doctor` 核对实际二进制；Mac 512K 路线应指向 `agy-512k`。
2. 使用真实模型完成一轮普通对话。该操作会使用已登录 AGY 账号的模型额度。
3. 在仓库根目录运行：

   ```sh
   python -I skills/agy-native-setup/scripts/check_native_window.py
   ```

   `generation_window_candidates` 中的 `1.9.10.4` 是原生实际窗口；512K 路线应为 `512000`，256K 路线应为 `256000`。单独的 `executor_checkpoint` 可能已被迁移，不能代替生成窗口检查。
4. 有公开摘要时，正文前应出现可展开、逐步增长的思考块。工具交接或结束时补齐已收到文字，保存重开后保留。上游不保证每轮都有摘要。

## 参考

- [设计与会话机制](references/design.md)
- [修改与开发](references/modifications.md)
- [故障定位](references/pitfalls.md)
- [窗口补丁](references/window-patch.md)
- [公开思路](references/public-thinking.md)
