<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro</h1>

<p align="center">
  让 ChatGPT Web 看见你的本地仓库，并像本地代码代理一样工作。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codexpro"><img alt="npm" src="https://img.shields.io/npm/v/codexpro?style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/rebel0789/codexpro/ci.yml?branch=main&style=flat-square"></a>
  <a href="https://github.com/rebel0789/codexpro/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/rebel0789/codexpro?style=flat-square"></a>
  <a href="https://rebel0789.github.io/codexpro/zh.html"><img alt="中文站点" src="https://img.shields.io/badge/site-%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-67e8f9?style=flat-square"></a>
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="https://rebel0789.github.io/codexpro/zh.html">中文网站</a>
  ·
  <a href="https://github.com/rebel0789/codexpro">GitHub 点星</a>
  ·
  <a href="https://www.npmjs.com/package/codexpro">npm</a>
  ·
  <a href="DOMAIN_SETUP.md">稳定 URL 指南</a>
  ·
  <a href="FAQ_ZH.md">中文 FAQ</a>
  ·
  <a href="SECURITY.md">安全说明</a>
</p>

CodexPro 把 ChatGPT Developer Mode 变成本地仓库的 MCP 代码代理。你在目标仓库里运行 `codexpro setup`，把复制好的 Server URL 粘贴到 ChatGPT 的 Create app 页面，ChatGPT 就能读取文件、搜索代码、查看 git 状态、写入或精确编辑文件，并运行安全范围内的验证命令。

CodexPro 不是速率限制绕过工具。它不会绕过、提升、合并、转售或修改 ChatGPT、Codex、OpenAI 或第三方模型的限制。它只是通过官方 Developer Mode / MCP App 路径，把你自己的 ChatGPT 会话连接到你自己的本地仓库。

如果 Codex 当前工作流暂时不可用，而你的 ChatGPT 页面仍然可用，CodexPro 可以让你继续在同一个本地仓库上工作。反过来也一样：ChatGPT 负责高上下文规划，Codex、OpenCode、Pi 或其他本地执行器负责终端里的实际执行。

```bash
npm install -g codexpro
codexpro setup
```

## 适合谁

CodexPro 适合已经使用 ChatGPT Plus 或 Pro 做开发的人：

- 想让 ChatGPT Web 直接读取本地代码，而不是反复复制文件片段。
- 想把 `AGENTS.md`、`.ai-bridge`、git diff、源码文件这些 Codex 风格上下文给 ChatGPT。
- 想在 ChatGPT 里完成规划、审查、改小文件、跑安全验证。
- 想在某些模型不能调用工具时，导出一个持久上下文包给它做规划。
- 想把 ChatGPT 的计划交给 Codex、OpenCode、Pi 或自定义本地代理执行。

当前测试显示，ChatGPT Free / Go 账号不暴露 CodexPro 需要的 Apps / Developer Mode 创建流程。推荐使用 ChatGPT Plus 或 Pro。

## 它能做什么

```text
ChatGPT Web 可以看到：
  AGENTS.md
  .ai-bridge 计划、状态和执行记录
  git status
  show_changes 审查摘要和可选 diff
  文件树、搜索结果、指定源码文件

ChatGPT Web 可以操作：
  read    读取文件
  search  搜索代码
  write   在工作区内写文件
  edit    精确替换文本
  bash    运行安全验证命令
  show_changes 查看当前改动摘要

本地执行器仍然有价值：
  Codex / OpenCode / Pi 执行计划
  终端重任务留在本地
  ChatGPT 回看执行结果和 diff
```

默认 `CODEXPRO_TOOL_MODE=standard`，只暴露常用编码循环、`codexpro_self_test`、`show_changes`、上下文导出和 handoff。演示时可以用 `--tool-mode minimal`，需要完整兼容工具时用 `--tool-mode full`。

默认工具数量较少是故意的：ChatGPT 面对少量高信号工具时更稳定。workspace open 仍会发现已安装的 user/plugin skills，并可用 `load_skill` 按名称、source 和显示出的 path 加载需要的 `SKILL.md`；如果仍有重名匹配，CodexPro 会报歧义错误，不会随便选一个，也不会把几十个 skill 变成单独 action。

ChatGPT 里每个 CodexPro 工具都可以显示紧凑 v9 卡片：server config、自测、workspace 摘要、读写 diff、bash 验证、git/tree/search/context 和 handoff/export 都有结构化视图。git、skills、tree、terminal 输出、context 和 raw diff 默认折叠或截断，避免在聊天里刷出大段原始数据。`CODEXPRO_WIDGET_DOMAIN` 用于设置 ChatGPT widget iframe 的专用 HTTPS origin，正式提交 app 前应换成你控制的独立域名。

## 快速开始

先全局安装一次：

```bash
npm install -g codexpro
```

进入你想让 ChatGPT 工作的仓库：

```bash
cd /path/to/your/repo
codexpro setup
```

`setup` 会引导你选择端口、模式和公网 URL 方式，并保存当前仓库的配置。它会启动本地 MCP HTTP 服务、生成私有 CodexPro token、启动隧道，并把完整 Server URL 复制到剪贴板。

以后同一个仓库的日常启动只需要：

```bash
codexpro start
```

不想全局安装时，也可以用：

```bash
npx codexpro@latest start --root /absolute/path/to/your/repo
```

但普通用户更推荐全局安装，这样命令就是固定的 `codexpro setup` 和 `codexpro start`。

## ChatGPT 中的 App 设置

先在 ChatGPT 打开 Developer Mode：

```text
ChatGPT Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Enforce CSP in developer mode: on
-> Create app
```

保留 CSP 开启。CodexPro 的卡片和小组件就是按 CSP 开启的路径设计的，不需要远程脚本、外部字体、iframe 或第三方图片。

在 Create App 页面填写：

```text
Name: CodexPro
Description: Local workspace bridge for ChatGPT coding
Connection: Server URL
Server URL: 粘贴 CodexPro 自动复制的 URL
Authentication: No Authentication / None
```

复制的 Server URL 已经包含私有 `codexpro_token`。不要单独粘贴 token，除非你的 ChatGPT UI 明确支持自定义 header。

保持终端里的 CodexPro 进程运行。你停止它之后，ChatGPT 就无法继续连接本地仓库。Cloudflare quick tunnel 的 URL 也会失效。

## 三种主要模式

### 1. Normal coding

默认模式。ChatGPT 可以在工作区内读取、搜索、写入、精确编辑文件，并运行安全验证命令。

```bash
codexpro start
```

适合小改动、文档更新、定位 bug、查看 diff、跑 lint/test/build。

### 2. Handoff

规划模式。ChatGPT 不直接写源码，只写入：

```text
.ai-bridge/current-plan.md
```

然后你在本地终端决定是否执行：

```bash
codexpro execute-handoff --agent opencode --model provider/model --dry-run
codexpro execute-handoff --agent opencode --model provider/model
```

也可以启动监听器，让本地终端在计划变更后执行：

```bash
codexpro start --mode handoff
codexpro watch-handoff --agent opencode --model provider/model --yes
```

执行结果会写回：

```text
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/execution-log.jsonl
```

然后让 ChatGPT 通过 `read_handoff` 或 `codex_context` 审查结果。

### 3. Pro context fallback

有些 ChatGPT 模型或产品界面不能直接调用 Developer Mode Apps、连接器或 MCP 工具。即使同一个 Plus/Pro 账号可以创建 CodexPro app，某个具体模型界面仍然可能没有工具调用能力。

这时不要强行让它调用工具。先导出一个持久上下文包：

```bash
codexpro pro-bundle --root /absolute/path/to/your/repo --copy
```

它会写入：

```text
.ai-bridge/pro-context.md
```

把这个上下文粘贴给不能调用工具的模型，让它产出窄范围实现计划。然后保存计划并应用：

```bash
codexpro pro-apply --root /absolute/path/to/your/repo --file plan.md
```

这会写入 `.ai-bridge/current-plan.md`，再交给 Codex、OpenCode、Pi 或自定义本地代理执行。

如果你的 ChatGPT 账号已经在 Web 产品里提供 GPT-5.5 或更强模型，并且该模型界面可以调用 Developer Mode Apps，CodexPro 可以让它通过 MCP 使用本地仓库工具。CodexPro 不提供、不代理、不转售、也不解锁模型。

## 稳定 URL 怎么选

ChatGPT App 需要一个可访问的 Server URL。你有三个常用选择：

```text
Cloudflare quick tunnel   最快演示路径。每次重启 URL 都变。
ngrok free dev domain     推荐给大多数用户。免费账号给一个稳定 dev domain。
Cloudflare named tunnel   适合已有自定义域名的用户。
```

### Cloudflare quick tunnel

最适合录 demo 或临时试用：

```bash
codexpro start
```

缺点很明确：quick tunnel 的 URL 每次重启都会变。如果你把 quick URL 放进 ChatGPT App，下一次启动时需要重新编辑 ChatGPT App 的 Server URL。

### ngrok free dev domain

推荐给大多数用户。创建一个免费 ngrok 账号，在 ngrok Dashboard 的 Universal Gateway -> Domains 找到你的 dev domain，比如：

```text
your-name.ngrok-free.dev
```

一次性认证 ngrok：

```bash
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

保存到 CodexPro：

```bash
codexpro settings set --tunnel ngrok --hostname your-name.ngrok-free.dev
```

以后启动：

```bash
codexpro start
```

ChatGPT 里的 Server URL 可以保持不变。

### Cloudflare named tunnel

如果你有自己的域名，可以用 Cloudflare named tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create codexpro
cloudflared tunnel route dns codexpro codexpro.example.com
```

之后日常启动：

```bash
codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
```

更多域名细节见 [DOMAIN_SETUP.md](DOMAIN_SETUP.md)。

## Codex 风格上下文

CodexPro 不读取 Codex 的隐藏运行时记忆。它给 ChatGPT 的是显式工作区上下文：

```text
open_current_workspace  当前 root、安全模式、AGENTS 状态、git 状态
codex_context           AGENTS 链、.ai-bridge 文件、可选 git status/diff
read_handoff            只读 .ai-bridge 文件
workspace_snapshot      更大的项目快照和 handoff 上下文
```

`codex_context` 会读取从仓库根目录到目标路径上的指令文件：

```text
AGENTS.override.md
AGENTS.md
agents.md
.agents.md
```

并加入：

```text
.ai-bridge/current-plan.md
.ai-bridge/agent-status.md
.ai-bridge/implementation-diff.patch
.ai-bridge/codex-status.md
.ai-bridge/decisions.md
.ai-bridge/open-questions.md
.ai-bridge/execution-log.jsonl
git status
可选 git diff
```

推荐流程：

```text
先调用 server_config 和 codexpro_self_test
如果 self-test 失败，先停下来报告失败项
先调用 open_current_workspace，include_tree=false
再调用 codex_context，target_path 指向要改的文件，include_diff=false
然后只读取当前任务需要的文件
```

这样 ChatGPT 会更接近 Codex 的指令模型，同时不会依赖隐藏状态或大范围重复扫描。

## 安全边界

CodexPro 是本地开发桥，不是操作系统级沙箱。

默认安全行为：

- 公网 tunnel 默认需要私有 CodexPro token。
- 写入限制在配置的工作区 root 内。
- 常见敏感路径会被拒绝：`.env`、私钥、`.git`、`node_modules`、生成目录、缓存目录。
- symlink 逃逸会被阻止。
- safe bash 只允许常见检查、搜索、git、lint、test、typecheck、build 等命令。
- `execute-handoff` 和 `watch-handoff` 是本地 CLI 命令，不是远程 MCP 工具。

只有在你信任当前仓库和命令时，才考虑更宽的权限，例如 full bash、自定义执行器、额外 allow root。

## 常用命令

```bash
codexpro setup
codexpro start
codexpro doctor
codexpro settings
codexpro settings list
codexpro settings set --tunnel ngrok --hostname your-name.ngrok-free.dev
codexpro settings delete --yes
codexpro pro-bundle --copy
codexpro execute-handoff --agent opencode --model provider/model --dry-run
codexpro watch-handoff --agent opencode --model provider/model --yes
```

终端控制键：

```text
Enter  打开 ChatGPT connector 设置
c      再次复制 Server URL
o      打开本地 setup/status 页面
h      显示帮助
q      停止 CodexPro
```

## FAQ

中文常见问题见 [FAQ_ZH.md](FAQ_ZH.md)。

核心结论：

- 需要 ChatGPT Plus 或 Pro，并且账号要能访问 Apps / Developer Mode。
- Free / Go 在当前测试中不支持这个 App 创建流程。
- CodexPro 不绕过任何速率限制。
- 某些 Pro / planning 模型界面不能直接连接 MCP 工具，使用 `pro-bundle` 作为上下文回退。
- quick tunnel 每次重启 URL 会变。
- 想每天同一个 URL，用 ngrok free dev domain 或 Cloudflare named tunnel。

## 开源与贡献

项目地址：[github.com/rebel0789/codexpro](https://github.com/rebel0789/codexpro)

欢迎提 issue、补文档、补平台兼容性、补测试。提交 PR 前请至少运行：

```bash
npm run build
npm run smoke
npm audit --omit=dev
```

如果 CodexPro 对你有用，请在 GitHub 点星。这样其他使用 ChatGPT、Codex、OpenCode、Pi 和 MCP 的开发者更容易找到它。
