<div align="center">

# workbuddy-codex-bridge

**在官方 ChatGPT 桌面端里直接选 WorkBuddy 的模型，想回官方订阅随时能回。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#给开发者)
[![Tests](https://img.shields.io/badge/tests-47%20passing-success.svg)](#自检)
[![Rollback](https://img.shields.io/badge/回退-0%20步%20%7C%201%20条命令-blue.svg)](#怎么回退)
[![Status](https://img.shields.io/badge/status-实验性-orange.svg)](#常见问题)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

> [!WARNING]
> **非官方工具，会违反上游规则。**
>
> 你的 WorkBuddy 订阅授权范围是**交互式编程工具**。腾讯明确禁止自动化、自定义后端、批量调用 —— 而本项目恰好就是这个模式。**账号或套餐可能被限流、限制甚至停用。** 接受不了就别用，改用[官方 TokenHub API](https://cloud.tencent.com/document/product/1823/133532)：那是官方支持、有文档的方式，同样能让 Codex 用上这些模型，且没这个风险。

---

## 你能得到什么

你付费买了 WorkBuddy，它解锁了约 16 个模型 —— GLM-5.3、Kimi-K3.1、DeepSeek-V4.1、MiniMax-M3.1 等等。问题是：你只能在 **WorkBuddy 那个 App 里**用它们。

本项目把这些模型全部塞进 **官方 ChatGPT 桌面端的模型下拉框**，和 GPT 排在一起。选中就用，工具调用、流式输出、思考过程都正常。

还有一个多数工具都做不好的点 —— **回去很简单**：

| 你想干什么 | 你要做什么 |
| --- | --- |
| 换回官方 GPT 模型用一下 | **什么都不用做**，下拉框里选它就行 |
| 彻底不要这个项目了 | **一条命令**：`wb-bridge restore`，然后重开 App |

不用卸载，不用手改配置文件，不用惦记「那行我改回去了吗」。

---

## 三步开始

**需要准备**：Node.js 22 以上、装了 Codex 模式的 ChatGPT 桌面端。**WorkBuddy 不需要开着。**

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge
node bin/wb-bridge.js start
```

这一条命令会自己找到你的订阅、读取模型列表、注册好、然后在 `127.0.0.1:10100` 起一个本地网关。让它一直跑着。

> [!IMPORTANT]
> **现在把 ChatGPT 完全退出 —— 只关窗口不算。**
>
> 用托盘 / 菜单栏的「退出」，或者在任务管理器里结束所有 `ChatGPT.exe`。这个 App 只在启动时读一次模型列表，关窗口没用。

重新打开，切到 **Codex 模式**，点开模型下拉框。你会看到 `WB · GLM-5.3 · x0.69` 这样的条目跟 GPT 排在一起。选一个，直接打字。

就这样，三步，没有改配置这一环。

---

## 不想开终端：装成插件，用开关控制

不想一直留着一个命令行窗口的话，把这个仓库注册成 Codex 的 marketplace（只做一次），以后就在**插件设置**里用一个开关控制它，不用敲命令。

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge
codex plugin marketplace add .
codex plugin add wb-bridge@workbuddy-bridge
```

然后打开 ChatGPT 桌面端 → 设置 → 插件，里面会有 `WorkBuddy Bridge` 和它的开关。

| 开关 | 会发生什么 |
| --- | --- |
| **打开** | Codex 启动插件自带的辅助进程，它把网关拉起来，`WB ·` 模型就出现在下拉框里。 |
| **关闭** | 网关停掉，**并且**把你的 `config.toml` 还原成和原来一模一样，所以官方 GPT 模型照常能用。 |

切换开关之后要完全退出重开 App，和上面一样 —— 模型列表只在启动时读一次。

> [!NOTE]
> 「关掉 App」和「关掉插件开关」不是一回事，这两种情况是**故意**分开处理的。只关 App 的话，网关会继续跑着，因为 App 是**先**读 `config.toml`、**再**启动插件的 —— 每次退出都拆掉的话，`WB ·` 模型会隔次消失。只有关掉插件开关才会完整回退。
>
> 如果你在 App 关着的时候翻转开关，网关会自己在大约 15 秒内发现，然后把配置还原，不用再开一次 App。这个自我了断只在网关由插件启动时生效；你在终端里手动起的网关归你管，它不会碰。过程写到 `~/.wb-bridge/plugin.log`。

装好之后可以直接问助手「WorkBuddy 网关还在跑吗」，它能调用插件自带的工具去查状态、列模型，或者一键还原。

---

## 模型清单

每行都标了**积分倍率**，点之前就知道花多少。下面是笔者国内版订阅的实测结果；你自己的列表是从你账号实时读的，可能不一样。

| 下拉框里显示 | 上下文 | 费用 |
| --- | --- | --- |
| `WB · Hy4 · x0.00 · 限时免费` | 960 K | 免费档 |
| `WB · Hy4 · x0.29` | 960 K | 0.29× |
| `WB · Hy3 · x0.00 · 限时免费` | 192 K | 免费档 |
| `WB · Hy3 · x0.05` | 192 K | 0.05× |
| `WB · GLM-5.3` | 1 M | 0.69× |
| `WB · GLM-5.3-Flash` | 1 M | 0.08× |
| `WB · GLM-5.2 · 夜间折扣` | 1 M | 0.79× |
| `WB · DeepSeek-V4.1-Flash` | 1 M | 0.11× |
| `WB · DeepSeek-V4-Pro` | 1 M | 0.51× |
| `WB · Kimi-K3.1-Pro` | 1 M | 0.97× |
| `WB · Kimi-K3` | 1 M | 1.62× |
| `WB · Kimi-K2.8-Preview` | 1 M | 0.77× |
| `WB · MiniMax-M3.1-Flash` | 1 M | 0.08× |
| `WB · Space-Bunny` | 1 M | 0.08× |
| `WB · Step-5-Preview` | 1 M | 0.33× |
| `WB · Xiaomi MiMo-V2.6-Pro` | 1 M | 0.13× |

`Hy4` 和 `Hy3` 各出现两次是**故意的**：一个是免费档，一个是计费档。同一个模型，两套计费。看价格标签就能分清。

随时可以用 `node bin/wb-bridge.js models` 打印你自己的列表和实时排队状态。

---

## 怎么回退

「回退」有两种意思，答案不一样：

**「我就想用一下 GPT-4 / Jupiter / Terra。」**
不用做任何事。下拉框里选它。网关看到请求没有 `WB/` 前缀，就原样转发给 OpenAI，用你原本的登录。你的官方订阅全程都在，网关只在用 WorkBuddy 模型时才参与。

**「我要把这东西从我电脑上弄掉。」**

```bash
node bin/wb-bridge.js restore
```

然后退出重开 ChatGPT。完成。

`restore` 只删它自己加的东西：从首次运行前的备份还原你的 `config.toml`、删掉生成的模型列表，不碰任何无关设置，也不碰你的登录。

> 自己手改配置文件要 2–3 步，还容易改错。这是 0 步或 1 条命令。

---

## 网络与代理

这块容易踩坑，说直白点：

- **WorkBuddy 在国内**，**完全不需要代理**。开不开代理都能用。
- **官方 GPT 模型需要代理**，这个懂的都懂，本项目改变不了。
- **两个同时用没问题。** 网关按请求判断：WorkBuddy 模型直连，GPT 模型走你的代理。

真机实测过：开代理 → 两类模型都正常；代理完全关掉 → WorkBuddy 模型照常，GPT 模型失败（符合预期）。

如果你的代理设置在 Windows「Internet 选项」里，网关会自动读取。想手动指定就用环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`，优先级更高。

---

## 常见问题

**下拉框里只有 GPT，没有 WB 开头的。**
多半是没**完全**退出 App。关窗口不算。先用 `node bin/wb-bridge.js status` 确认状态，再把残留进程一起结束。

**模型名显示成 "Custom" 而不是 `WB · …`。**
部分桌面端版本有第二层服务端白名单，会过滤下拉框。但路由仍然是对的，请求能到正确的模型。想确认就在 `~/.codex/config.toml` 里直接写 `model = "wb/glm-5.3"` 再重启，UI 会显示 Custom 但走的确实是它。

**昨天好好的，今天不行了。**
大概率是令牌过期。重启网关，它会自动续期。如果好几个月没开过 WorkBuddy，去那边登录一次，让新凭据落盘。

**我 ChatGPT 额度用完了，所有 WB 模型都变灰了。**
这是 OpenAI 那边的规则，不是本项目的问题：原生额度耗尽后，App 会在剩余时间窗口里把其他行置灰。等重置，或者改用终端的 `codex`。

**对话中途切换模型报错。**
新建一个对话。Codex 会记录每轮的工具调用，中途换 provider 会让记录对不上。

**状态栏出现「正在重新连接 5/5」。**
v1.1.0 已修复。更新并重启即可。如果还出现，确认你跑的版本和仓库一致。

其他问题：开 issue 时附上系统、Node 版本和报错原文。

---

## 给开发者

下面是实现细节。只想用的话可以跳过。

<details>
<summary><b>为什么需要本项目（以及为什么要自己写网关）</b></summary>

直接接有三个障碍：

1. **协议不通。** Codex 只认 Responses API；WorkBuddy 后端是 Chat Completions 加一堆专有身份头。线上不兼容。
2. **桌面端登录已加密。** WorkBuddy 5.6 起本地凭据文件用 AES-256-GCM 封存，只有 App 自己能解。
3. **没有现成 provider。** [opencodex](https://opencodex.me/) 只内置了 `workbuddy-ai`（国际版订阅）。国内版没有对应 OAuth provider，而且 opencodex 的 `headers` 字段明确拒绝 `Authorization` / cookie / API key 头。

本项目吸收了两个已有项目的有用部分，但打包成单个自包含进程：

| 来源 | 吸收了什么 |
| --- | --- |
| [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | 线上协议：凭据发现与刷新、身份头集合、会话身份三元组、请求体改写、指纹中和、目录发现、流式、错误分类。 |
| [opencodex](https://opencodex.me/) | 回环注入策略：保留内置 provider，只注入两个根级键，发布共享目录 —— 完全可逆，不碰 `auth.json`。 |

</details>

<details>
<summary><b>架构</b></summary>

```
ChatGPT 桌面端 · Codex 模式
  │  model = wb/glm-5.3
  ▼
~/.codex/config.toml   →  openai_base_url = http://127.0.0.1:10100/v1
  ▼
workbuddy-codex-bridge   127.0.0.1:10100   （单 Node 进程，零依赖）
  │  Responses ⇄ Chat Completions 翻译
  │  + 凭据刷新 / 身份头 / 请求体改写
  ├─ wb/*     → https://copilot.tencent.com/v2/chat/completions
  └─ 其它     → https://chatgpt.com/backend-api/codex   （0 步回退）
```

网关同时实现了 Responses 的 **WebSocket** 传输。Codex 会先连 `ws://127.0.0.1:<port>/v1/responses`，早期版本每次要为此白等约 16 秒；现在完成 RFC 6455 握手就没有这段等待了。`sec-websocket-extensions` 有意不协商。

</details>

<details>
<summary><b>命令</b></summary>

| 命令 | 作用 |
| --- | --- |
| `wb-bridge start` | 发现、注册、注入、启动服务。平时用这个。 |
| `wb-bridge setup` | 只注册和注入，不起服务。 |
| `wb-bridge models` | 打印你账号的模型、费用和排队状态。 |
| `wb-bridge status` | 注入状态、是否在监听。 |
| `wb-bridge login` | 本地无凭据时走浏览器登录。 |
| `wb-bridge restore` | 移除它加的所有东西。 |

参数：`--port <n>`（默认 `10100`）、`--region cn|global`。

</details>

<details>
<summary><b>配置</b></summary>

```jsonc
{
  "region": "cn",              // 国际版订阅填 "global"
  "host": "127.0.0.1",
  "port": 10100,
  "credentialFile": "",        // 显式凭据路径，优先级最高
  "cnBase": "",                // 可选：国内网关子域覆盖
  "apiKey": "",                // 设了之后要求 Authorization: Bearer <apiKey>
  "deviceToken": "",           // 可选：真实设备令牌
  "timeoutMs": 120000,
  "emitReasoning": true,
  "keepModelIds": [],          // 强制保留实时列表里缺失的 id
  "extraModelIds": []          // 追加你已开通但未列出的 id
}
```

默认只绑定回环地址。要对内网暴露才设 `apiKey`。

</details>

<details>
<summary><b>凭据发现顺序</b></summary>

按顺序找，命中即止：

1. `config.credentialFile` —— 显式路径。
2. `$DSH_HOME/workbuddy-vault/<region>/*.json` —— 明文，已解密。最省事。
3. `$DSH_HOME/.workbuddy-auth.<region>.json`，或旧版文件。
4. `workbuddy-desktop.info` + AES-256-GCM 解密，密钥从 App 的 Electron 绑定里取。
5. `wb-bridge login` —— 浏览器设备授权。

令牌到期前自动刷新，以 `0600` 原子写回。企业账号通过 `X-Enterprise-Id` / `X-Tenant-Id` 支持。

注意这个顺序：桌面端是**最后兜底**，不是必需项。

</details>

<details>
<summary><b>线上细节</b></summary>

**请求头。** 每次上游调用都带完整身份集合（`X-Product`、`X-IDE-Type`、`X-Agent-Purpose`、`X-Domain`、派生设备对，以及新的会话身份三元组）。三元组缺任何一部分都会触发渠道门禁（`11128`），所以标识符按请求生成、从不复用。

**请求体。** 强制 `stream: true`；`developer` → `system`；补系统头；`tool_choice` 对象收敛成后端接受的字符串；`max_completion_tokens` → `max_tokens`；去掉 `reasoning_effort: "off"`。已知的产品名指纹用 U+200B 零宽空格中和 —— 破坏字节级匹配，但不改变模型读到的文字。

**工具。** Codex 把工具声明放在 `input[]` 的 `additional_tools` 项里，不是顶层 `tools` 字段。网关遍历该树、拍平 `namespace` 包装、把 `custom` 工具暴露成单字符串 `input` 的 schema，并丢弃未配对的工具调用半对 —— 上游对「有调用无结果」和「有结果无调用」都报错（`11148`）。

**注入。** 只加两个根级键，位置在第一个 `[table]` 之前：

```toml
# >>> workbuddy-codex-bridge (undo: wb-bridge restore) >>>
model_catalog_json = "/abs/path/.codex/workbuddy-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
# <<< workbuddy-codex-bridge <<<
```

目录会克隆全部原生的行（保证官方模型继续可用），再追加每个 WorkBuddy 模型一行。注入是幂等的。

</details>

<details>
<summary><b>实测结果</b></summary>

以下全部跑在真实国内版订阅、真实上游调用上，用的是临时 `CODEX_HOME` —— 笔者自己的 `config.toml` 全程没被改动。

| 检查项 | 结果 |
| --- | --- |
| 实时发现 | `/v3/config` + `/v2/enterprises/personal/models` 解析出 16 个模型，上下文 192 K–1 M |
| 选择器内容 | `codex debug models` 报 26 行：16 个 `wb/` + 10 个原生，全部 `visibility=list` |
| 端到端 | `codex exec -m wb/glm-5.3-flash` 输出正确，exit 0 |
| WebSocket 传输 | 握手接受，21 帧，零重试 |
| 修复后延迟 | 37,969 ms → 15,887 ms |
| 工具调用 | `function_call` 参数增量正确重组 |
| 开代理、两类模型 | WorkBuddy 200，GPT 200 |
| 关代理 | WorkBuddy 200，GPT 失败（符合预期） |
| GUI 选择器 | 已由用户在真实 Windows 环境确认 |

</details>

<details>
<summary><b>自检</b></summary>

```bash
npm test     # 47 项 —— 协议、改写、请求头、SSE、WS 帧、代理、插件生命周期、配置可逆性
```

一半是纯函数；另一半在临时 `CODEX_HOME` 里跑「注入 → 重复注入（幂等）→ 还原」，并断言字节级可逆。

</details>

<details>
<summary><b>已知限制</b></summary>

- **仅 Codex 模式。** 没有公开办法把第三方模型塞进普通 Chat / Work 界面。连 Ollama 官方集成都写明只支持 Codex 模式。
- **选择器白名单。** 部分版本有第二层远程白名单会过滤本地目录的行（[#19694](https://github.com/openai/codex/issues/19694)、[#29156](https://github.com/openai/codex/issues/29156)）。CLI 和 TUI 不受影响。
- **官方 5 小时配额。** 原生额度耗尽后 App 会把其他行置灰（[#2813](https://github.com/openai/codex/issues/2813)）。
- **`model_catalog_json` 只在启动时加载，且是替换不是合并。** 本项目克隆原生行来补偿，但每次改配置都要完全重开 App。
- **上游只支持流式。** 非流式请求会被拒（`11101`），需要缓冲时网关本地聚合。
- **协议会漂移。** 上游限流、头要求、内容审核随时可能变。
- **插件开关是「假钩子」。** 这个版本 Codex 把 `plugin_hooks` 标成 `removed`，所以插件自带的 MCP 服务器顶替了生命周期钩子：Codex 开会话时拉起它、结束会话时杀掉它。但 `codex exec` **不会**拉起插件，所以一次性 CLI 场景下这个开关没意义，请用 `wb-bridge start`。
- **关开关是靠轮询发现的。** 如果 App 关着的时候把插件关掉，网关靠每 15 秒读一次 `config.toml` 才发现。这期间不会出错，只是网关会多活几秒。

</details>

---

## 安全

- 凭据只在内存。明文副本以 `0600` 写入；Windows 上请放在有 ACL 限制的目录。
- 默认只绑回环地址；要绑得更宽就设 `apiKey`。
- `X-Refresh-Token` 只发给刷新端点，绝不出现在对话请求里。
- `~/.codex/auth.json` 本项目从不读写。
- 代理流量走 `CONNECT` 隧道 —— 代理只看得到域名，看不到你的令牌和消息内容。
- 别把 `config.json`、凭据、日志提交进仓库，`.gitignore` 已覆盖。

## 合规

仅供**研究与互操作性学习**。与 OpenAI、腾讯、WorkBuddy、CodeBuddy 均无关联。已知风控码：`11128` 身份拒绝、`11133` 参数非法、`11140` 异常活动、`11101` 非流式、`12153` 会话失效、`402` 余额不足、`429` / `14018` 配额耗尽。网关做缓解，但缓解不等于免疫。

接受不了这些条款，就用[官方 TokenHub API](https://cloud.tencent.com/document/product/1823/133532) —— 官方支持的 Codex 接入方式，没有这些风险。

---

## 参与贡献

先读 [CONTRIBUTING.md](CONTRIBUTING.md)。简单说：零依赖、每个行为变更配测试、提交 PR 前跑 `node --check`、绝不提交凭据。

安全漏洞：见 [SECURITY.md](SECURITY.md)，请不要开公开 issue。

## 许可

[MIT](LICENSE) © contributors

## 致谢

- [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) —— 线上协议的参考实现。
- [opencodex](https://opencodex.me/) —— 回环注入策略与 SSE 事件契约。
- [workbuddy2api](https://github.com/240xu/workbuddy2api)、[workbuddy-cli-proxy](https://github.com/p2109220548-ctrl/workbuddy-cli-proxy)、[hy3-proxy](https://github.com/zhangjianqiang123/hy3-proxy) —— 先行项目。
- [Ollama × ChatGPT](https://docs.ollama.com/integrations/chatgpt) —— 选择器机制与回退思路。
- 腾讯云文档：[Codex 接入](https://cloud.tencent.com/document/product/1823/133532)、[协议矩阵](https://cloud.tencent.com/document/product/1823/130079)。
