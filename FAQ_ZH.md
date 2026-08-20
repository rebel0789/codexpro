# CodexPro 中文 FAQ

## 我应该用什么 ChatGPT 账号？

使用当前能创建自定义 MCP 插件的 ChatGPT 账号和 Web 界面。OpenAI 2026 年 7 月的文档说明：包含写入和修改操作的完整 MCP 目前面向 Business、Enterprise 和 Edu；Pro 目前只能连接 read/fetch 权限的 MCP App。该文档没有把 Plus 列为支持自定义 MCP 的账号层级。

CodexPro 不解锁 Plugins，不解锁模型，不绕过账号限制，也不提供账号访问。它只连接你自己的 ChatGPT Plugins 界面和你自己的本地仓库。

## 推荐安装方式是什么？

注意：这个 FAQ 跟随 GitHub `main`。假设某个 `main` 功能已经进入 `codexpro@latest` 前，请先看 npm badge/version。

全局安装一次：

```bash
npm install -g codexpro
```

然后进入目标仓库运行：

```bash
codexpro setup
```

以后每天从同一个仓库启动：

```bash
codexpro start
```

`npx codexpro@latest start` 仍然可用，但普通用户更容易理解全局安装。

## 怎么更新 CodexPro？

没有 `codexpro update` 命令。重新安装最新包并重启连接即可：

```bash
npm install -g codexpro@latest
codexpro --version
```

然后停掉旧进程，在启动仓库里重新运行 `codexpro start`。`~/.codexpro` 下的已保存配置会保留。

如果文档写了某个功能，但 `codexpro --version` 还没有，说明 GitHub `main` 比 npm `latest` 新。等下一版发布，或从带 tag 的 GitHub release 安装。

## CodexPro 和网页版自带 Agent 有什么区别？

用途不同。

ChatGPT 网页版 Agent 适合浏览、网页研究和通用网页任务。默认情况下，它不能打开你电脑上的本地 Git 仓库，不能读 `AGENTS.md`，不能看当前分支/`git diff`，也不能在你批准的本地工作区内做受控编辑或跑本地验证命令。

CodexPro 是本地 MCP bridge：用你自己的 ChatGPT 会话，通过 Plugins 连接你电脑上明确允许的仓库。Developer mode 只是创建自定义插件所需的设置开关。它不是网页 Agent 的替代品，也不绕过账号限制，更不是远程 shell 服务。

网页工作用网页 Agent；本地仓库是事实来源时用 CodexPro。

## 怎么把 ChatGPT 附件导入仓库？

在 workspace write 模式下，CodexPro 会暴露 `import_file`。ChatGPT 需要传入 Apps SDK 文件对象：

```json
{
  "download_url": "https://...",
  "file_id": "file_...",
  "mime_type": "image/png",
  "file_name": "screenshot.png"
}
```

该参数通过 `_meta["openai/fileParams"]` 声明。CodexPro 只会从已批准的 ChatGPT/OpenAI 文件域名下载临时 HTTPS URL，遵守 `CODEXPRO_MAX_IMPORT_BYTES`，拒绝私网/回环重定向，并且只写入已允许的工作区。默认不允许覆盖。任意用户或模型自行提供的下载 URL 会被拒绝。

如果客户端没有同时提供 `download_url` 和 `file_id`，工具会返回 unsupported-reference 错误，并且不会创建任何文件。

## ChatGPT 里要打开什么设置？

在 ChatGPT 中打开：

```text
Settings
-> Security and login
-> Developer mode: on
-> Enforce CSP in developer mode: on

Settings
-> Plugins
-> Create
```

创建 Plugin 时填写：

```text
Name: CodexPro
Description: Local workspace bridge for ChatGPT coding
Connection: Server URL
Server URL: 粘贴 CodexPro 复制的 URL
Authentication: No Authentication / None
```

复制的 Server URL 已经包含私有 CodexPro token。

## CSP 要保持开启吗？

要保持开启。

CodexPro 的小组件按 CSP 开启的路径构建。它不需要远程脚本、外部字体、iframe、第三方图片或任意外部请求。

## CodexPro 会绕过速率限制吗？

不会。

CodexPro 不绕过、不提升、不合并、不转售、不修改 ChatGPT、Codex、OpenAI 或第三方模型限制。所有请求仍然通过你自己的 ChatGPT 会话，并受该账号当前限制约束。

它的价值在于 ChatGPT 和 Codex 是不同产品界面。某个工作流暂时不可用时，如果另一个你本来就有权限的界面仍可用，CodexPro 可以让它继续操作同一个本地仓库。

## CodexPro 可以使用 GPT-5.5 吗？

前提是你的 ChatGPT 账号已经在 Web 产品里提供这个模型或同级更强模型，并且该模型界面可以调用自定义 MCP 插件。

CodexPro 不提供、不代理、不转售、也不解锁模型。它只给兼容的 ChatGPT 会话提供本地仓库工具。

如果某个模型不能直接调用工具，用上下文包回退：

```bash
codexpro pro-bundle --root /path/to/repo --copy
```

然后把生成的 `.ai-bridge/pro-context.md` 粘贴给该模型，让它做规划，再用本地执行器执行。

## 为什么 Pro 账号也可能连不上某个模型？

账号权限和模型工具能力是两回事。

账号权限和具体模型界面的工具调用能力是两回事，而且可用范围可能变化。遇到不能调用 MCP 工具的界面时，用 `codexpro pro-bundle --copy` 导出上下文，再把计划交给本地代理执行。

## ChatGPT 能通过 CodexPro 看到什么？

ChatGPT 能看到工具显式暴露的工作区内容：

- `AGENTS.md`
- `.ai-bridge` 计划、状态、执行记录
- git status
- git diff
- 文件树和搜索结果
- 你让它读取的源码文件

它不能读取 Codex 的隐藏运行时记忆，也不能读取工作区外的文件，除非你明确允许额外 root。

## ChatGPT 可以编辑什么？

Normal coding 模式下，ChatGPT 可以在配置的工作区内写入和精确编辑文件。

默认会阻止：

- `.env`
- 私钥
- `.git`
- `node_modules`
- 生成目录和缓存目录
- symlink 逃逸
- 工作区外路径

如果你只想让 ChatGPT 规划，不想让它直接改源码，用 handoff 模式。

## CodexPro 能把 bash 绑定到某个会话 id 吗？

CodexPro 不能附加到、读取或复用某一个 Codex App 聊天会话或终端会话。

MCP 的 `bash` 工具是在你启动的 CodexPro 本地服务器进程里，针对配置的 workspace root 执行。MCP session id 只是 ChatGPT 和 CodexPro HTTP 服务器之间的传输状态，不是 Codex 会话 id。

但 CodexPro 可以要求 bash 调用带上匹配的本地 session 标签：

```bash
codexpro start --bash-session main --require-bash-session
```

之后 `bash` 调用必须包含 `session_id: "main"`。这能避免误触发到错误的 CodexPro 终端，但不是远程控制某个已有的 Codex App 聊天。

如果你显式开启，CodexPro 可以列出本地 Codex session id 和标题：

```bash
codexpro start --tool-mode full --codex-sessions metadata
```

它会读取 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 下的本地 Codex JSONL 历史，返回 metadata 和 `codex resume <session-id>` 命令。只有需要有限长度 transcript 读取时才使用 `--codex-sessions read`。它不会附加到正在运行的 Codex App 聊天。

如果你正在 Codex 里工作，不希望 ChatGPT 触发 shell 命令，可以关闭 bash：

```bash
codexpro start --no-bash
```

如果只想让 ChatGPT 写计划，由 Codex 或其他本地 agent 执行：

```bash
codexpro start --mode handoff --no-bash
```

## 选择哪种 tunnel？

按这个规则选：

```text
快速 demo：          Cloudflare quick tunnel
推荐稳定 URL：       ngrok free dev domain
自定义域名：          Cloudflare named tunnel
Tailnet 用户：        Tailscale Funnel
无公网 URL：          local-only，只适合能访问 localhost 的 MCP 客户端
```

Cloudflare quick tunnel 每次重启 URL 都变。把 quick URL 填到 ChatGPT 后，每次重启都要改 ChatGPT App 的 Server URL。

大多数用户建议用 ngrok free dev domain。创建免费 ngrok 账号，在 Universal Gateway -> Domains 找到分配给你的 dev domain，并在 `codexpro setup` 里保存。

如果你有自己的域名，用 Cloudflare named tunnel，把 DNS 路由到例如 `codexpro.example.com` 的主机名。

## ChatGPT 创建 connector 时显示 “Something went wrong” 怎么办？

通常是 ChatGPT 无法访问公网 MCP URL。生成 `trycloudflare.com` URL 不代表 `cloudflared` 一直连通。

运行连接测试：

```bash
codexpro connection-test --root /path/to/repo
```

这个模式保留 `read`、`tree`、`search` 和 `load_skill`，关闭文件写入、bash
和 tool cards，并记录请求是否到达本地 MCP endpoint。在 ChatGPT 的
`Settings -> Plugins` 创建 development plugin，粘贴完整 Server URL，
Authentication 选择 `No Authentication`。

- 没有 `POST /mcp received`：请求没有到达 CodexPro，检查 ChatGPT Plugins 页面和 tunnel。
- `POST /mcp -> 401`：请粘贴包含 `codexpro_token` 的完整 URL。
- `POST /mcp -> 2xx`：ChatGPT 已到达 CodexPro，MCP endpoint 也已响应。

URL token 只适合作为个人 connector 的兼容方式。共享或多用户生产部署必须使用 OAuth 或
`Authorization: Bearer <token>`。CodexPro 要求 token 至少 24 个字节，本地引导页加载后
会从浏览器地址中移除 token 参数，并限制重复失败的认证尝试。

测试期间保持 CodexPro 运行。Cloudflare quick tunnel 每次重启都会更换 URL。
如果 Cloudflare 返回 `530` / `Error 1033`，检查运行 `cloudflared` 的机器上的
DNS 或代理客户端 DNS 设置。

ChatGPT 现在在 Plugins 中管理 development app。浏览器错误
`Failed to execute 'removeChild' on 'Node'` 发生在 ChatGPT 页面中，早于任何
CodexPro MCP 请求。请在 Plugins 页面删除或重建旧条目，再使用当前 URL 重试；
CodexPro 无法修复浏览器端的旧条目。

## 能每天使用同一个 ChatGPT App URL 吗？

可以，前提是使用稳定 hostname。

推荐简单路径：

```bash
codexpro setup
# 选择 ngrok
# 输入你的 ngrok free dev domain
```

之后：

```bash
codexpro start
```

同一个 hostname 和 CodexPro token 会被当前工作区复用。

## quick mode 为什么每次都要改 URL？

Cloudflare quick tunnel 是一次性的临时地址。每次重新启动 tunnel，Cloudflare 会分配一个新的 `trycloudflare.com` URL。

如果你不想改 ChatGPT 设置，用 ngrok free dev domain 或 Cloudflare named tunnel。

## 同时跑两个仓库怎么办？

如果只是希望通过同一个 connector 切换项目，先在启动仓库保存额外项目：

```bash
cd ~/code/app
codexpro settings set --project ~/code/web --project ~/code/api
codexpro settings show
codexpro start
```

确认输出里的 `Projects` 列出了额外根目录，然后重启 connector，管理页 Allowed Roots 才会刷新。让 ChatGPT 打开已允许的项目。`open_workspace` 返回的 `workspace_id` 在整个 CodexPro 进程内保持有效，即使客户端随后开启新的 MCP session。当前 MCP session 会把该项目设为选择，因此同一 session 里后续工具可以省略 `workspace_id`。`open_current_workspace` 只把 session 选择切回启动项目，不会让其他 id 失效。未知 `workspace_id` 会失败，绝不会静默回退到启动仓库。

清除已保存的额外项目：

```bash
codexpro settings set --clear-projects
```

项目选择按 MCP session 隔离，但已打开的 `workspace_id` 属于进程级注册表。ChatGPT conversation 不保证和 MCP session 一一对应，因此后续工具调用应带上 `workspace_id`。需要独立 allowlist 或独立公网入口时，请跑两个 CodexPro 进程，并用不同本地端口和不同公网 hostname：

```text
repo A: port 8787, hostname A, ChatGPT plugin URL A
repo B: port 8788, hostname B, ChatGPT plugin URL B
```

分别在两个仓库里运行 `codexpro setup` 并保存 profile。不要把同一个 Server URL 给两个账号共用。

## 多个 ChatGPT session 怎么避免互相覆盖？

项目选择按 session 隔离。对于共享文件，先读取文件，再把返回的 SHA-256 作为 `expected_sha256` 传给 `write` 或 `edit`。如果读取之后文件已经变化，CodexPro 会拒绝操作。新文件采用原子替换；已有文件原位更新，以保留与 inode 绑定的元数据和硬链接。

这能防止旧内容静默覆盖新内容，但不会把 CodexPro 变成协同 merge server。大范围重叠修改仍建议使用独立 worktree。

后台运行或交给 service manager 时，使用 `codexpro start --headless`。它不会提问、访问剪贴板或打开浏览器；会用 `CODEXPRO_READY` 报告就绪，HTTP runtime 意外退出时 launcher 会以非零状态退出。

## 能不能用 codexpro.github.io？

GitHub Pages 的 `owner.github.io` 只能由名为 `owner` 的 GitHub 用户或组织使用。

`codexpro` 这个 GitHub 用户名已经存在，所以 `rebel0789` 账号下的项目不能使用 `codexpro.github.io`。

当前干净的 GitHub Pages 地址是：

```text
https://rebel0789.github.io/codexpro/
```

中文页面是：

```text
https://rebel0789.github.io/codexpro/zh.html
```

## CodexPro 是否违反服务条款？

CodexPro 使用 ChatGPT 的官方 Plugins + MCP 接入路径，让你自己的 ChatGPT 会话连接到你自己的本地工具。Developer mode 只是创建自定义插件所需的设置开关。

它不绕过限制，不抓取隐藏接口，不共享账号，不转售模型，不伪造请求来源，也不把第三方模型包装成别的模型。

用户仍然需要遵守 ChatGPT、Codex、OpenAI 和任何第三方服务的条款。

## CodexPro 生产环境安全吗？

CodexPro 是本地开发桥，不是操作系统级沙箱。

只在你信任的仓库里使用。公网 tunnel 保持 token auth 开启。保持 safe bash，除非你明确知道为什么需要 full bash。公网暴露前先读 [SECURITY.md](SECURITY.md)。

## 保存的设置在哪里？

工作区配置保存在：

```text
~/.codexpro/profiles/
```

管理命令：

```bash
codexpro settings
codexpro settings list
codexpro settings delete --yes
```

显示设置时，保存的 token 会被打码。

## CodexPro 能帮助 ChatGPT 维持上下文吗？

可以帮助，但方式是显式文件和上下文包，不是隐藏记忆。

推荐使用：

- `AGENTS.md` 写项目规则。
- `.ai-bridge/decisions.md` 写关键决策。
- `.ai-bridge/current-plan.md` 写当前计划。
- `.ai-bridge/agent-status.md` 写本地执行结果。
- `codexpro pro-bundle --copy` 给不能调用工具的模型生成上下文包。

这样 ChatGPT 断线、换模型或换会话后，仍然可以通过文件恢复上下文。
