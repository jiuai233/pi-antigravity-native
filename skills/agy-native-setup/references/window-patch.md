# 窗口补丁：机制、验证与重新定位

## 机制（agy 1.4.12 Windows x64）

agy 是 Go 程序。设置里的窗口有两个 getter：

| Go 函数 | 虚拟地址 | 文件偏移 | 行为 |
| --- | --- | --- | --- |
| `store.(*Store).ContextWindowChoice` | `0x1432f6e40` | 53437504 | 读 settings.json 的 `contextWindow`，再 `ParsePresetContextWindow` |
| `store.(*Store).ContextWindow` | `0x1432f6e80` | 53437568 | 走模型/能力分支，**不读保存值**；原生预算用的是它 |

补丁把 `ContextWindow` 入口 5 字节 `4c 8d 64 24 80` 换成 `e9 bb ff ff ff`：

- 原指令是 `lea r12, [rsp-0x80]`，Go 大栈帧栈检查序言的第一条，5 字节正好一条完整指令。
- 新指令是相对跳转，位移 = `0x1432f6e40 - 0x1432f6e80 - 5 = -0x45`（小端 `bbffffff`），尾跳到 `ContextWindowChoice`。两者 receiver 相同、返回约定相同，跳过去等于直接返回保存的选择。
- 栈增长（morestack）后会回到函数入口，入口现在就是这条跳转，所以仍然进入 `ContextWindowChoice`。
- 不改 checkpoint 截断、模型目录、认证或其它任何字节。

文件指纹：原版 `b4bbcc9f…2da6858`，打补丁后 `c87dbdd5…af27cec0`（完整值见 `scripts/recipes/recipe-windows-x64-1.4.12.json`）。

## 已验证与未验证

- 已验证：隔离环境里打补丁的 1.4.12，`gemini-4-argon` 真实请求，会话库 generation `max_context_tokens = 512000`、executor `checkpoint_config.max_token_limit = 512000`；原版同样设置下是 256000。更早的 1.4.x 长上下文对照：原版在实际输入约 256K 处触发 checkpoint，打补丁副本实际输入 257,929 仍未压缩。
- 二进制里还有一个 `GetCheckpointConfig` 的 `min(calculated, 256000)` 分支，补丁没动。Gemini Argon 这条路径不经过它；其它模型是否经过**没验证**。Claude 1M 档模型的原生预算是 840000，与补丁无关。
- 同一版本号在不同机器上的 exe 是否逐字节相同，没有核对过。脚本按完整 SHA256 判断，不同就拒绝。
- 补丁会让 Authenticode 签名失效。

## 给别的 Windows x64 版本重新定位

全部在副本上做，正式文件只在最后由 `agy_window_patch.py apply` 替换。

1. 准备一份**未打补丁**的 agy.exe 副本（新装的 agy 就是原版）。
2. `pip install pefile capstone`
3. 列出候选函数（只读，几十秒）：

   ```text
   python -I scripts/relocate/inspect-getters.py --binary <副本> --out analysis.json
   ```

   它恢复 Go 的 pclntab，输出名字匹配 `Store\).*ContextWindow` 的函数的地址、文件偏移和反汇编。

4. 人工核对，任一条不成立就停下：
   - `ContextWindow` 和 `ContextWindowChoice` 都在，且仍是 `(*Store)` 方法。
   - `ContextWindowChoice` 的反汇编里调用了 `ParsePresetContextWindow`（说明它读保存值），`ContextWindow` 没有。
   - 两者返回约定相同：看它们 `ret` 前设置的寄存器，以及调用方怎么用返回值。
   - `ContextWindow` 入口的前 5 字节是完整指令（或几条完整指令），且函数内没有跳回入口第 1～4 字节的分支。不是 5 字节对齐时，不要硬套，换覆写长度需要重新论证。
5. 计算新配方：

   ```python
   import hashlib, json, struct
   data = open("<副本>", "rb").read()
   a = json.load(open("analysis.json"))
   f = {x["name"].rsplit(".", 1)[-1]: x for x in a["functions"]}
   o, d = f["ContextWindow"], f["ContextWindowChoice"]
   after = b"\xe9" + struct.pack("<i", int(d["address"], 16) - int(o["address"], 16) - 5)
   off = o["file_offset"]; before = data[off:off + 5]
   patched = data[:off] + after + data[off + 5:]
   print(off, before.hex(), after.hex(), hashlib.sha256(data).hexdigest(), hashlib.sha256(patched).hexdigest())
   ```

   复制 `recipes/recipe-windows-x64-1.4.12.json` 为 `recipe-windows-x64-<版本>.json`，填入 `version`、`base`、`result`、`offset`、`before`、`after` 和两个函数地址。
6. 校验配方（核对偏移是 `ContextWindow` 入口、跳转目标、结果指纹、精确逆变换，并确认无关字节漂移会被拒绝）：

   ```text
   python -I scripts/relocate/verify-recipe.py --binary <副本> --analysis analysis.json --recipe <新配方> --out verify.json
   ```

7. 实测生效：把打好补丁的副本另存（可用 `agy_window_patch.py apply --agy <副本>`），Pi 里设 `AGY_BINARY` 指向它，开**新**对话聊一两轮，`check_native_window.py` 看到 `512000` 才算成功。
8. 成功后 `agy_window_patch.py apply` 会按哈希自动匹配新配方去改正式文件。

## macOS 与 Linux

- macOS arm64 的 AGY 1.4.12 补丁副本已有 512K 本地验证；Linux 尚未验证。
- macOS / Linux 的 agy 是 Mach-O / ELF，可能是 arm64。`inspect-getters.py` 只解析 PE + x86-64，需要改成读对应格式的段（Go pclntab 本身结构相同）。
- arm64 的跳转是 4 字节 `B imm26`，覆写入口一条指令，位移按 4 字节对齐计算。
- macOS 改字节后代码签名失效，通常要 `codesign --force --sign - <文件>` 重新做临时签名才能运行。
- 做不到时走 256K 路线，功能完整，只是窗口小一半。
