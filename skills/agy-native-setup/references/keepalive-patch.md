# macOS 原生提示缓存保活

AGY 1.4.12 arm64 内置提示缓存保活器。补丁将 `modelapiccpa.keepAlivePings` 固定返回 6，启用现有调度、请求裁剪和停止逻辑。补丁不增加聊天消息，也不由 Pi 定时调用模型。

## 支持范围与安装

仅支持已核验的 macOS arm64 AGY 1.4.12 512K 副本：

- 输入文件 SHA-256：`4a313dca845e8ceb77ae11288d80281622e94930ed8c8848750edf684a7177f9`。
- 函数虚拟地址：`0x1023f41b0`；文件偏移：`37700016`。
- 原始入口：`900b40f9ff6330eb`。
- 替换入口：`c00080d2c0035fd6`，即 `mov x0, #6; ret`，遵循 Go ARM64 ABIInternal 整数返回约定。

完整文件摘要约束用于防止将固定偏移写入其它构建。相同版本号、不同签名或不同窗口补丁的文件也会拒绝处理。

```sh
python3 -I skills/agy-native-setup/scripts/agy_keepalive_patch.py status
python3 -I skills/agy-native-setup/scripts/agy_keepalive_patch.py apply
```

默认源文件为 `~/.gemini/bin/agy-512k`，输出为 `~/.gemini/bin/agy-512k-keepalive`。可通过 `--agy`、`--output` 指定路径。脚本拒绝覆盖源文件或已有目标，创建副本后执行 ad-hoc 本地签名、签名校验和版本检查。该签名不是官方开发者签名；受组织安全策略限制的机器可能拒绝运行。

`status` 的 `patched_entry` 仅表示指定地址包含保活指令，不证明整份二进制的来源。`apply` 会在写入前核对完整源文件。

## 启用与停用

```sh
AGY_BINARY="$HOME/.gemini/bin/agy-512k-keepalive" pi
```

未设置 `AGY_BINARY` 的 macOS 环境会优先选择已安装的保活副本。显式指定的二进制和自动更新环境变量保持优先。自动选择副本时默认设置 `AGY_CLI_DISABLE_AUTO_UPDATE=true`。

停用保活时，设置 `AGY_BINARY="$HOME/.gemini/bin/agy-512k"` 并重新启动 Pi。已有常驻 AGY 进程不会因文件新增或环境变量变化自动切换。

## 原生机制与成本

`keepAlivePings` 原本查询 `enable-prompt-cache-keep-alive` 和 `prompt_cache_keep_alive_max_pings`。未启用灰度时返回 0；补丁固定为 6。

原生保活器基于主对话请求登记定时任务，每 270 秒最多发起 6 次后台请求，名义覆盖约 27 分钟。请求复用已登记的前缀、裁剪末尾块，将 `MaxOutputTokens` 设为 1，并附加 `prompt_cache_keep_alive=true`。收到带用量的流块后取消连接；不进入正常聊天步骤机。

上游实现包含迟到和冷缓存停止条件：调度超过锚点 285 秒时停止；首包不满足 `cache_read_tokens > input_tokens` 时不再排下一次。原生服务端缓存寿命和路由并非客户端保证，跨副本路由、前缀变化及休眠均可能导致缓存失效。

每次保活是实际模型请求，会产生缓存读取、少量未缓存输入及输出用量。插件的价格仅用于展示估算，不代表订阅额度扣减规则。保活停止后继续闲置，可能同时承担保活和下次冷读成本。

## 进程与窗口

- 保活需要常驻 AGY 进程；`PI_ANTIGRAVITY_DRIVER=0` 的单次进程模式不能跨轮保活。
- Pi 退出、宿主卸载会话或电脑休眠时不能依赖保活继续。
- 补丁只修改保活函数入口，原有 512K 修改保留。
- `check_native_window.py --conversation <id>` 中 `generation_window_candidates` 的 `1.9.10.4=512000` 用于确认实际窗口；单独的 checkpoint 不足以证明生成窗口。

## 验证

```sh
python3 -I skills/agy-native-setup/scripts/test_keepalive_patch.py
python3 -I skills/agy-native-setup/scripts/agy_keepalive_patch.py status --agy "$HOME/.gemini/bin/agy-512k-keepalive"
```

真实验证需要隔离会话：先完成请求并建立热缓存，保持进程存活超过 5 分钟，再检查下一轮的缓存读取用量；同时比较静置前后的 `steps` 和 `gen_metadata`，确认后台请求没有增加正常聊天记录。真实验证消耗账号用量。
