# workbuddy-codex-bridge

把**国内版 WorkBuddy 桌面端订阅**里的内置模型，直接注入到**官方 ChatGPT 桌面 App 的 Codex 模式模型选择器**里点选使用；想回到官方订阅时，**点回原生 GPT 是 0 步，彻底回退是 1 条命令**。

零第三方依赖（只用 Node.js 内置模块，Node ≥ 22）、单进程、跨平台（Windows / macOS / Linux），不需要安装或运行 opencodex。

> [!WARNING]
> **非官方集成，违反上游服务条款。** 腾讯云明确「订阅限定为交互式编程工具使用，禁止通用 API 自动化、自定义应用后端和非交互式批量调用」，把订阅经第三方代理喂给 ChatGPT 正是该模式 —— **账号或套餐可能被限流、限制或停用**。动手前请先读[合规与风险](#合规与风险)。

[English](README.md) · [简体中文](README.zh-CN.md)

---

## 目录

- [要解决的问题](#要解决的问题)
- [它做了什么](#它做了什么)
- [链路](#链路)
- [前置条件](#前置条件)
- [快速开始](#快速开始)
- [命令](#命令)
- [配置](#配置)
- [工作原理](#工作原理)
- [回退到官方订阅](#回退到官方订阅)
- [实测记录](#实测记录)
- [已知限制](#已知限制)
- [安全](#安全)
- [合规与风险](#合规与风险)
- [参与贡献](#参与贡献)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 要解决的问题

WorkBuddy 桌面客户端订阅解锁了一整套模型 —— Hy4、GLM-5.3、Kimi-K3、DeepSeek-V4、MiniMax-M3.1 等等。你可以在 WorkBuddy 里跟它们对话，却无法在 ChatGPT 桌面 App 里选中它们，因为：

1. **Codex 只说 OpenAI Responses API。** WorkBuddy 后端说 Chat Completions，还带一整套专有身份头，两者在协议层不兼容。
2. **桌面登录态是加密的。** WorkBuddy 5.6 起本地凭据文件被 AES-256-GCM 封存，只有 App 能解。
3. **没有一等 provider。** 像 [opencodex](https://opencodex.me/) 这样的社区网关只为*国际版*订阅暴露 `workbuddy-ai`；国内版没有对应 OAuth provider，而 opencodex 的 `headers` 字段明确拒绝 `Authorization` / cookie / API-key 头，无法注入 WorkBuddy 身份头。

常见绕法是手改 `~/.codex/config.toml` 指向第三方代理 —— 能用，但**回到**官方订阅要手动还原文件、撤销目录覆盖、再重启，两三步且容易出错。

本项目同时补上这两个缺口：模型出现在选择器里，回退只要 **0 次点击**（重新选原生 GPT）或 **1 条命令**。

---

## 它做了什么

吸收了两个现成项目的能力，但把它们合成一个自包含的网关：

| 来源 | 吸收了什么 |
| --- | --- |
| [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | **订阅线协议**：读取/刷新客户端登录凭据、构造 WorkBuddy 全套请求头、会话身份三连、请求体改写、渠道指纹脱敏、`/v3/config` 动态模型目录、`/v2/chat/completions` 流式上游、错误码分类。 |
| [opencodex](https://opencodex.me/) | **loopback 注入策略**：保留内置 `openai` provider，只注入两个根级键（`openai_base_url` + `model_catalog_json`），并写出共享模型目录；完全可逆，不碰 `~/.codex/auth.json`。 |

直接装 opencodex 在这里行不通：它在 Windows 上禁用本地插件自动加载（`"On Windows automatic plugin loading is disabled until an ACL trust check is available."`），`headers` 字段拒绝凭据头，且国内版订阅没有一等 provider。直接说 Responses API 就完全省掉了额外进程。

---

## 链路

```
ChatGPT 桌面 App · Codex 模式
  │  POST /v1/responses   (模型 = wb/glm-5.2)
  ▼
~/.codex/config.toml  openai_base_url = http://127.0.0.1:10100/v1
  ▼
workbuddy-codex-bridge (本机 127.0.0.1:10100，单进程)
  │  Responses → Chat Completions 翻译 + 注入 OAuth token / 全套头 / 正文改写
  ▼
https://copilot.tencent.com/v2/chat/completions   → 你的订阅额度
```

**0 步回退**：在选择器里点回任意原生 GPT —— 网关把非 `wb/` 前缀的请求原样转发到 `https://chatgpt.com/backend-api/codex`（转发传入的 `Authorization`），官方订阅照常工作，无需停服务。

本机实测：从 CN 订阅 `/v3/config` 动态发现 **16 个内置模型**（hy4free / hy4std / hy3 / hy3-x / deepseek-v4.1-flash / glm-5.3 / glm-5.3-flash / glm-5.2 / space-bunny / minimax-m3.1-flash / kimi-k3.1-pro / kimi-k3-1 / kimi-k2.8-preview / deepseek-v4-pro / step-5-preview / mimo-v2.6-pro），上下文 192k–1M，全部以 `WB · <名字>` 出现在选择器里。

---

## 前置条件

- **Node.js ≥ 22**（用到原生 `fetch` / `AbortSignal.timeout` / `node:crypto`）。本机验证环境 v25.8.1。
- 已安装并**登录** WorkBuddy 桌面客户端（国内版），或可用浏览器完成设备 OAuth。
- 已安装带 **Codex 模式**的新版 ChatGPT 桌面 App（macOS / Windows）。
- 用户级 `~/.codex/config.toml` 存在（Codex 至少启动过一次）。`~/.codex/auth.json` 绝不改动。

无 npm 依赖，无构建步骤。

---

## 快速开始

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge

cp config.example.json config.json     # 可选：按需改端口/区域/凭据
node bin/wb-bridge.js start            # 发现模型 → 写目录 → 注入 → 起服务
```

输出示例：

```
  credential : vault (.../.dsh/workbuddy-vault/cn/c4957....json)  region=www.workbuddy.cn
  models     : 16 WorkBuddy + 1 native
  catalog    : .../.codex/workbuddy-catalog.json
  config.toml: injected at line 2

  workbuddy-codex-bridge listening on http://127.0.0.1:10100/v1
  Native GPT       : forwarded to https://chatgpt.com/backend-api/codex (0-step rollback)
  Rollback         : wb-bridge restore
```

> [!IMPORTANT]
> **必须完全退出 ChatGPT 桌面 App —— 不是关窗口。** 用托盘/菜单栏的 Quit，或 `Cmd+Q` / 右键退出。`model_catalog_json` 只在启动时读取。

重开 App 并切到 **Codex 模式**，选择器里就会出现 `WB · Hy4`、`WB · GLM-5.3` 等条目，点选即可对话。

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `wb-bridge start` | 发现模型 + 写目录 + 注入 config.toml + 前台运行网关（**首次用这个**） |
| `wb-bridge setup` | 只做注入、不起服务 |
| `wb-bridge models` | 列出账号里的 WorkBuddy 内置模型 |
| `wb-bridge status` | 查看注入状态 / 网关是否在跑 |
| `wb-bridge login` | 设备 OAuth 浏览器登录（没有桌面登录态时） |
| `wb-bridge restore` | **一条命令彻底回退**到官方订阅 |

选项：`--port <n>`（默认 `10100`）、`--region cn|global`（默认 `cn`）。环境变量 `WB_BRIDGE_CONFIG` 指向替代配置文件。

---

## 配置

```jsonc
{
  "region": "cn",              // 或 "global"（国际版 workbuddy.ai 订阅）
  "host": "127.0.0.1",
  "port": 10100,
  "credentialFile": "",        // 显式指定凭据文件（优先级最高）
  "cnBase": "",                // 可选 CN 网关子域覆盖
  "apiKey": "",                // 非空时网关要求 Authorization: Bearer <apiKey>
  "deviceToken": "",           // 可选的真实 X-Device-Token
  "deviceFile": "",            // 可选的设备盐文件路径
  "timeoutMs": 120000,
  "emitReasoning": true,
  "keepModelIds": [],          // 强制保留实时目录里缺失的模型 id
  "extraModelIds": []          // 追加你确认已开通但目录未列出的模型 id
}
```

默认只监听回环地址。如需把端口暴露到本机之外，请设 `apiKey`。

---

## 工作原理

### 凭据发现

WorkBuddy 5.6 起桌面登录态被加密，因此按以下顺序查找，命中即停：

1. `config.credentialFile` —— 显式指定；
2. `$DSH_HOME/workbuddy-vault/<region>/*.json` —— 由 dsh-connect-workbuddy 落盘的**明文已解密**凭据（最省事，完全绕开解密）；
3. `$DSH_HOME/.workbuddy-auth.<region>.json`，或旧版 `.workbuddy-auth.json`；
4. `workbuddy-desktop.info` / `workbuddy-desktop-ai.info` + **AES-256-GCM** 字段解密：从 App 可执行文件的 Electron linked binding 取 `atRestSecretKey`，AAD 布局（`fieldAad`）、密钥派生（对 base64 **字符串**做 `sha256`，不是解码后的字节）与 GCM tag 校验均与参考实现一致 —— tag 不符绝不降级为截断 token；
5. `wb-bridge login` —— 浏览器设备 OAuth（`/v2/plugin/auth/state` → 授权 → 轮询 `/v2/plugin/auth/token` → `/v2/plugin/login/account` → 每日签到）。

token 过期前自动刷新（`POST /v2/plugin/auth/token/refresh`，带 `X-Refresh-Token` 与 `X-Auth-Refresh-Source: workbuddy`，**刻意不带** `Authorization`），成功后以 `mode 0600` 原子写回。企业账号通过 `X-Enterprise-Id` / `X-Tenant-Id` 支持。

### 请求头构造

每个上游请求都带完整身份集：`X-Product`、`X-IDE-Name`、`X-IDE-Type`、`X-IDE-Version`、`X-Agent-Purpose`、`X-Domain`、`X-User-Id`、`X-Enterprise-Id`、`X-CodeBuddy-Request`、`Accept-Language`、派生的设备对（`X-Machine-ID` / `X-Session-ID`，由本地盐派生）、以及**每请求新生成**的会话身份三连（`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`）。三连缺任一部分都会触发上游渠道校验（`11128`），所以标识绝不复用。

### 请求体改写

分发前统一规范化：强制 `stream: true`，`developer` 角色转 `system`，保证存在 system 头，`tool_choice` 对象收敛成后端接受的字符串形式，`max_completion_tokens` 转 `max_tokens`，删除 `reasoning_effort: "off"`（会触发 `11133`）。被上游观察为拒绝的**渠道指纹**（以产品名开头的提示句）通过在其已有空白中插入 U+200B 零宽空格来打断字节级精确匹配 —— 模型读到的文本不变。

### 目录注入

`~/.codex/config.toml` 只接收两个根级键，且**必须位于第一个 `[table]` 之前**（TOML 结构要求 —— 插在后面会被解析进上一个表）：

```toml
# >>> workbuddy-codex-bridge (undo: wb-bridge restore) >>>
model_catalog_json = "/abs/path/.codex/workbuddy-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
disable_response_storage = true
# <<< workbuddy-codex-bridge <<<
```

目录会从 `~/.codex/models_cache.json` 克隆**全部**原生行（保证官方模型照常可用），再为每个 WorkBuddy 模型追加一行，写入真实上下文窗口、`visibility: "list"`，并把 `instructions_template` 换成中性句，避免把原生 GPT 身份文案发给 WorkBuddy 网关。注入是幂等的 —— 重复 `start` 不会产生重复块。

---

## 回退到官方订阅

| 场景 | 步骤 |
| --- | --- |
| 临时切回官方模型 | **0 步** —— 选择器里点回任意原生 GPT，网关自动转发到官方后端 |
| 彻底移除注入 | **1 步** —— `wb-bridge restore`，然后完全退出并重开 App |

`restore` 只剥离本项目自己的标记块，用首次注入前的纯净备份还原 `config.toml`，删掉生成的目录，并把 `models_cache.json` 的 `fetched_at` 置 0 迫使下次启动重读。**绝不删除你的其它 Codex 配置，也不碰 `auth.json`。**

对比「手动改 config.toml 直连第三方」需要备份/改回/重启（2–3 步），本项目把回退压到 0–1 步。

---

## 实测记录

以下结果全部用**真实 WorkBuddy 国内版订阅凭据**跑通，且全程使用临时 `CODEX_HOME`，作者真实 `~/.codex/config.toml` 未被改动（字节数始终为 4989）。

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | 动态模型发现 | `/v3/config` 解析出 **16 个** CN 模型，上下文 192k–1M |
| 2 | 网关直连 `/v1/responses` | `wb/glm-5.2`、`wb/hy3`、`wb/deepseek-v4.1-flash`、`wb/minimax-m3.1-flash` 均 HTTP 200、`status=completed` |
| 3 | 流式 SSE 事件序列 | 10 帧：`response.created` → `in_progress` → `output_item.added` → `content_part.added` → `output_text.delta` → `output_text.done` → `content_part.done` → `output_item.done` → `response.completed` → `[DONE]` |
| 4 | 工具调用 | `tools` + `tool_choice:auto` 返回 `function_call`，增量拼接出 `{"city": "北京"}`，`call_id`/`arguments` 完整 |
| 5 | OpenAI Chat Completions | `POST /v1/chat/completions` 返回 `object: chat.completion`、`finish_reason: stop` |
| 6 | **Codex 实际加载目录** | `codex debug models` 看到 **26 个模型（16 个 `wb/` + 10 个原生）**，`wb/` 行全部 `visibility=list` |
| 7 | **官方 Codex CLI 端到端** | `codex exec -m "wb/glm-5.2"` → 输出 `桥接成功`，`tokens used 1,539` |
| 8 | 错误分类 | `hy4free` 配额耗尽返回 `code 6004 / 429` → 正确归类 `soft_rate` |
| 9 | 自检回归 | `npm test` → 24 checks passed |

**没能验证的部分（诚实说明）**：作者机器未安装 ChatGPT 桌面 App，因此**无法截图 Codex 模式图形选择器**。第 6、7 条是最接近的可得证据 —— Codex 报告它加载了 16 个 `visibility=list` 的 `wb/` 模型，且同一个 Codex 二进制成功用 `wb/glm-5.2` 完成了真实对话。桌面 App 与 CLI 共用同一套 `config.toml` + 目录读取逻辑，但 renderer 的第二层白名单（[openai/codex#19694](https://github.com/openai/codex/issues/19694)）只能在装好 App 的机器上确认。

### 自检

```bash
npm test     # 24 passed —— 凭据/协议/正文改写/请求头/SSE/config 可逆性
```

一半是纯函数，另一半在一次性 `CODEX_HOME` 里跑完整的 注入 → 重复注入（幂等）→ 还原 循环，并断言字节级可逆。

---

## 已知限制

- **只有 Codex 模式能点选。** 普通 Chat / Work 界面没有公开的第三方模型注入方案 —— 连 Ollama 官方集成都写明 "only available in Codex mode"；opencodex 的桌面 shim 是 macOS-only、默认关闭、只过滤配额 JSON-RPC 而不路由模型调用，且因 renderer 独立 transport 失效（#6196）。
- **选择器白名单。** 部分桌面版本有第二层远程 allowlist 会删掉本地目录里的模型（[#19694](https://github.com/openai/codex/issues/19694)、[#29156](https://github.com/openai/codex/issues/29156)）。CLI/TUI 不受影响；绕法是在 `config.toml` 直接写 `model = "wb/glm-5.2"`，UI 显示 *Custom* 但路由正确。
- **官方 5 小时配额。** 原生配额耗尽后桌面端会把其它行置灰并强制 `gpt-reserve`（[#2813](https://github.com/openai/codex/issues/2813)）；等窗口重置，或改用 CLI。
- **`model_catalog_json` 只在启动时加载，且覆盖（不是合并）内置目录。** 本项目克隆全部原生行来补偿，但每次改配置都必须完全退出并重开 App。
- **上游只支持流式。** 非流式请求会被拒（`code 11101`）；网关始终流式上游，需要缓冲响应时本地聚合。
- **Codex 会先探测 WebSocket。** 它先连 `ws://127.0.0.1:<port>/v1/responses`，重试 5 次后才回退 HTTPS —— 每次约 5 秒，并刷出一串 `failed to connect to Responses WebSocket` 日志。**属观感问题，不影响结果。** 本项目已在 upgrade 握手时立刻回 405 让回退尽早发生，但重试次数是 Codex 内部策略：`codex features list` 显示 `responses_websockets` 与 `responses_websockets_v2` 均已被标记为 `removed`，开关已不存在。
- **协议会漂移。** 上游限流、请求头要求、内容审核变动频繁，本仓库的适配可能随时失效。

---

## 安全

- 凭据只从磁盘读入内存。明文副本以 `0600` 写入；Windows 上 POSIX 权限位无效，请把 vault 放在有 ACL 限制的目录下。
- 网关默认只绑定 `127.0.0.1`。若绑定到其它地址，请设 `apiKey` —— 届时缺少 `Authorization: Bearer <apiKey>` 的请求会被 `401` 拒绝。
- `X-Refresh-Token` **只**发给刷新端点，绝不出现在对话请求里。
- 本项目对 `~/.codex/auth.json` 只读：注入与还原都不触碰它。
- 不要把 `config.json`、凭据文件或日志提交到仓库 —— 仓库自带的 `.gitignore` 已覆盖。
- 注入自定义目录意味着**你**要为它暴露的模型条目负责；不要把本仓库生成的目录带到你不控制的机器上。

---

## 合规与风险

> [!CAUTION]
> 本项目仅供**研究与互操作性学习**。风险自负。

- **上游条款。** 腾讯云将订阅限定为**交互式编程工具**使用，禁止通用 API 自动化、自定义应用后端和非交互式批量调用；违规可能导致套餐密钥被停用。把订阅喂给 ChatGPT 属于典型的第三方代理用法，确有账号被限制、套餐被终止的风险。同类项目（[workbuddy2api](https://github.com/240xu/workbuddy2api)、[workbuddy-cli-proxy](https://github.com/p2109220548-ctrl/workbuddy-cli-proxy)、[hy3-proxy](https://github.com/zhangjianqiang123/hy3-proxy)）均声明「仅供学习研究、自担风险」。
- **无关联。** 本项目与 OpenAI、腾讯云、WorkBuddy、CodeBuddy 均无关系。所有商标归其各自所有者。
- **已观测的风控码。** `11128` 渠道/身份拒绝、`11133` 参数非法、`11140` unusual-activity（须向上游提交反馈，重登与换模型无效）、`11101` 非流式被拒、`11102` 模型 id 未改写、`12153` session 失效、`402` 积分不足、`429` / `14018` 额度已用尽并带约 30 分钟 `Retry-After`。本项目做了规避，但规避不等于免疫。
- **无担保。** 若账号被限制、额度被耗尽或套餐被终止，后果由使用者承担。

如果无法接受这些条款，请改用官方 [TokenHub 按量 API](https://cloud.tencent.com/document/product/1823/133532) —— 那是受支持、有文档的 Codex 一等接入路径，没有上述风险。本项目之所以存在，是因为订阅本身没有受支持的编程接口。

---

## 参与贡献

欢迎贡献，请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge
npm test
```

- 保持**零运行时依赖** —— 只用 Node 内置模块。
- 每个行为变更都要在 `test/selftest.js` 加用例，测试必须保持全绿。
- 提交 PR 前对每个改动文件跑 `node --check`。
- 绝不提交凭据、token、个人标识符或含上述内容的抓包。

安全问题请见 [SECURITY.md](SECURITY.md)，凭据处理相关的缺陷请不要开公开 issue。

---

## 许可证

[MIT](LICENSE) © contributors

---

## 致谢

- [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) —— 订阅线协议的参考实现，凭据 vault 与指纹脱敏技术的来源。
- [opencodex](https://opencodex.me/) —— loopback 注入策略、Responses SSE 事件契约、以及模型目录克隆方法。
- [workbuddy2api](https://github.com/240xu/workbuddy2api)、[workbuddy-cli-proxy](https://github.com/p2109220548-ctrl/workbuddy-cli-proxy)、[hy3-proxy](https://github.com/zhangjianqiang123/hy3-proxy) —— 把订阅暴露成 OpenAI 兼容端点的先行项目。
- [Ollama × ChatGPT 集成](https://docs.ollama.com/integrations/chatgpt) —— 模型选择器机制与「自动恢复连接设置」的回退范式。
- 腾讯云 TokenHub 文档：[Codex 接入](https://cloud.tencent.com/document/product/1823/133532)、[模型与协议矩阵](https://cloud.tencent.com/document/product/1823/130079)。
