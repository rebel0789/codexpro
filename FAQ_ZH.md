# CodexPro 中文 FAQ

## 我应该用什么 ChatGPT 账号？

使用 ChatGPT Plus 或 Pro，并确保账号能访问 Apps / Developer Mode。

当前测试显示，Free / Go 账号不暴露 CodexPro 需要的 App 创建流程。

CodexPro 不解锁 Developer Mode，不解锁模型，不绕过账号限制，也不提供账号访问。它只连接你自己的 ChatGPT App 界面和你自己的本地仓库。

## 推荐安装方式是什么？

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

## ChatGPT 里要打开什么设置？

在 ChatGPT 中打开：

```text
Settings
-> Apps
-> Advanced settings
-> Developer mode: on
-> Enforce CSP in developer mode: on
-> Create app
```

Create App 填：

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

前提是你的 ChatGPT 账号已经在 Web 产品里提供这个模型或同级更强模型，并且该模型界面可以调用 Developer Mode Apps。

CodexPro 不提供、不代理、不转售、也不解锁模型。它只给兼容的 ChatGPT 会话提供本地仓库工具。

如果某个模型不能直接调用工具，用上下文包回退：

```bash
codexpro pro-bundle --root /path/to/repo --copy
```

然后把生成的 `.ai-bridge/pro-context.md` 粘贴给该模型，让它做规划，再用本地执行器执行。

## 为什么 Pro 账号也可能连不上某个模型？

账号权限和模型工具能力是两回事。

Plus / Pro 可以暴露 Apps / Developer Mode，但某个具体模型界面仍然可能不能调用连接器或 MCP 工具。遇到这种情况时，用 `codexpro pro-bundle --copy` 导出上下文，再把计划交给本地代理执行。

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

## CodexPro 能把 bash 绑定到某个 Codex 会话 id 吗？

不能。CodexPro 不能附加到、读取或复用某一个 Codex App 聊天会话或终端会话。

MCP 的 `bash` 工具是在你启动的 CodexPro 本地服务器进程里，针对配置的 workspace root 执行。MCP session id 只是 ChatGPT 和 CodexPro HTTP 服务器之间的传输状态，不是 Codex 会话 id。

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
无公网 URL：          local-only，只适合能访问 localhost 的 MCP 客户端
```

Cloudflare quick tunnel 每次重启 URL 都变。把 quick URL 填到 ChatGPT 后，每次重启都要改 ChatGPT App 的 Server URL。

大多数用户建议用 ngrok free dev domain。创建免费 ngrok 账号，在 Universal Gateway -> Domains 找到分配给你的 dev domain，并在 `codexpro setup` 里保存。

如果你有自己的域名，用 Cloudflare named tunnel，把 DNS 路由到例如 `codexpro.example.com` 的主机名。

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

给每个仓库使用不同本地端口和不同 tunnel hostname。

示例：

```text
repo A: port 8787, hostname A
repo B: port 8788, hostname B
```

分别在两个仓库里运行 `codexpro setup` 并保存 profile。

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

CodexPro 使用 ChatGPT 的官方 Developer Mode / MCP App 接入路径，让你自己的 ChatGPT 会话连接到你自己的本地工具。

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
