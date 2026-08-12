# CodexPro 中文 FAQ

## 我应该用什么 ChatGPT 账号？

使用当前能访问自定义 MCP App 的 ChatGPT 账号和 Web 界面。OpenAI 2026 年 7 月的文档说明：包含写入和修改操作的完整 MCP 目前面向 Business、Enterprise 和 Edu；Pro 目前只能连接 read/fetch 权限的 MCP App。该文档没有把 Plus 列为支持自定义 MCP 的账号层级。

CodexPro 不解锁 Developer Mode，不解锁模型，不绕过账号限制，也不提供账号访问。它只连接你自己的 ChatGPT App 界面和你自己的本地仓库。

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

前提是你的 ChatGPT 账号已经在 Web 产品里提供这个模型或同级更强模型，并且该模型界面可以调用 Developer Mode Apps。

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

## 如何在直接编码和 Codex 协作之间切换？

受信任的仓库必须同时显式启用 workspace write 和 full bash：

```bash
codexpro start --root /path/to/repo --write workspace --bash full
```

安全默认值不会改变。创建 CodingTask、运行、follow-up 和 Direct → Codex 切换同时要求 `writeMode=workspace` 与 `bashMode=full`，因为 Codex App Server 可以执行超出 safe shell allowlist 的项目命令。状态、列表、审查、取消以及 Codex → Direct 切换无需 full bash，仍可用于检查和恢复。

以 direct owner 创建一个 CodingTask，并用返回的 `workspace_id` 调用普通编码工具。直接操作空闲后，使用 `transition_coding_task` 把独占写入权交给 Codex，再调用 `run_coding_task`；后续请求用 `followup_coding_task`，会复用同一任务、thread 和 worktree。Codex 空闲后可切回 direct，并通过 `review_coding_task` 或 `show_changes` 审查。

任务在断线和服务重启后仍可恢复。CodexPro 会拒绝并发写入，也暂时拒绝 CodingTask worktree 中的普通后台任务。它不会自动 commit、merge、push、创建 PR 或删除 worktree。Codex 默认使用 `gpt-5.6-sol` / `high`，禁用网络且 approval policy 为 `never`；可通过 `--task-dir`、`--codex-model` 和 `--codex-reasoning-effort` 配置。自定义 `--codex-dir` 会作为 `CODEX_HOME` 传给独立 Codex 进程。

旧 `.ai-bridge` handoff 仍保留作兼容和规划用途，但不是持久 CodingTask 协作流程。

## Pro 如何编排多个 Codex worker？

在普通 Chat 中提出较大的结果目标。Pro 可以先保存不执行的 `propose_goal` 契约并展示带指纹的 Goal 卡片；只有你接受该精确范围后才调用 `approve_goal`，而批准本身仍不会启动工作。`start_goal` 会并行启动依赖已满足的隔离 CodingTask，随后 Pro 刷新持久状态、审查证据、按依赖顺序集成结果，并根据每一条批准的标准判断是否完成。

`workspace_policy=isolated` 会让所有集成 checkpoint 保持私有，直到单独确认 `apply_goal`。`workspace_policy=live` 下 worker 和 Pro integration 仍然隔离；`review_goal` 之后，只有单独确认的 `project_goal` 才能把返回的精确 integration HEAD/review fingerprint 投影到源工作区。批准、集成、审查、完成或取消都不会隐式投影。

Live 会保留既有且不相关的 tracked、staged、untracked 修改。每次 source effect 都检查批准的 HEAD 和目标路径 CAS，使用 per-repository lock，并先写 durable journal；相同 key 可恢复重试。若用户修改了同一路径，系统不会覆盖而进入 `recovery_required`。symlink、submodule、冲突 index 和非普通文件失败关闭。

`cancel_goal` 不会回滚源码。回滚需单独确认 `revert_goal_projection`，且只允许 latest-applied-first（LIFO）。最终 checkpoint 已经投影时，`apply_goal` 会 zero-write 地采用并封存它。不会 stage、commit、merge、push 或创建 PR。supervised worker 每次只有一个 turn，没有自动重试和 worker 网络；worker 执行需要 workspace write + full bash，而 project/revert/apply 只需要 workspace write，不需要 bash 或 Codex。

## 离开 Chat 后，Persistent Goal 会继续吗？

在受支持的 POSIX 主机上可以，但只能执行已批准 envelope 内的机械工作。Persistent Goal 必须使用 Isolated、空 Goal `commands` 列表、network=false、关闭全部 source effect。每个 worker 可批准 1–4 个 semantic turn，并在全部 turn 间共享总计 0–2 次 fresh retry；默认 retry 为 0。超过一个 turn 时，提案必须精确包含少一个、有序且批准后不可修改的 `continuation_intents`，最多三个。经过独立的 propose → approve → start 后，本地独立 scheduler 会并行启动依赖已满足的 worker。中间 turn 成功后仍保持私有，不能集成或解锁依赖，只会在同一 CodingTask、worktree、Codex thread 和 session 上执行下一个已批准 intent。只有最终批准 turn 可以产生一次 cumulative private integration。你可以离开页面，之后用被动的 `get_goal` / `review_goal` 重新连接；scheduler 会停在 `waiting_review`，stop reason 为 `semantic_review`，因为只有 Pro 能判断完成，任何后续源码操作都必须在这个 Persistent 契约之外获得用户单独授权。

工作进行时电脑与独立 scheduler 进程必须保持运行；启动、控制或重新连接时需要 CodexPro server 可用。这不是 ChatGPT 内置 Scheduled Tasks，也不会在断线时让 Pro 继续推理。Persistent start/resume 仍明确要求 workspace write + full bash，因为本地 Codex App Server 可以执行项目命令。Continuation 是事先批准的全新 semantic turn；fresh retry 使用新 operation 重复该 turn 的精确批准 prompt，但不消耗 turn；同一 operation 的 crash/reconnect recovery 保留原 operation，也不消耗 retry。同一 thread 表示向一个持久 Codex thread 追加 turn，不保证 context compaction 后所有早期 token 仍逐字存在。

这个两 turn 流程已在[真实 ordinary Chat](https://chatgpt.com/c/6a7cab4a-fa74-83ee-bb1c-5040c68524c0)通过。Goal `goal_d96c4d1de3d6382cc4ebcc86` 复用了 CodingTask `task_f1c84e9b39654c8aaebb2e6b` 和同一个 thread/session `019ff70a-ea6f-7a83-94d6-f81fe92527a2`；turn 2 运行时 turn 1 仍未集成，最终只有一个私有 integration commit，scheduler 随后停在 `waiting_review` / `semantic_review`。v16 卡片显示 2/2 turn 与 final-only integration。离开再重连没有改变 source 状态，Chat host 重复的被动 status/review 调用也没有修改或重新启动工作。

Pause、resume、cancel 都是显式持久控制。Pause 生效后不会开始新的 worker launch、integration 或依赖推进；重新连接或读取状态不会 resume。Resume 针对同一批准指纹幂等执行，不会重跑已完成工作。Cancel 会 fence 活跃工作并进入 terminal，但不会回滚源码或删除保留的 worktree。

## Persistent Goal 何时会自动 retry？

只有批准的 Persistent 契约在公开字段 `limits.max_retries_per_worker` 中仍有总预算，且 runner positive proof 明确命中 `infra-pre-turn-v1` 两种 failure 之一时：`app_server_startup / infrastructure / runner_start` 或 `app_server_initialize_transport / infrastructure / app_server_initialize`。Outcome 必须已知，该失败 attempt 不得返回新的 thread/session/turn identity，也不得写出 thread-establish 或 turn-start 请求；HEAD、status、diff/stat、changed paths、mode 与 index-visible Git state 必须和 attempt 前观察精确相同。若更早的 semantic turn 已建立 thread/session，它继续作为新 attempt 的 resume 目标。第一次 retry 等待 1 秒，第二次等待 5 秒；schedule 与 allowlist 都带指纹且不可自适应修改。

Timeout；model、tool、input、approval failure；policy/path/content/provenance/validation/identity conflict；cancel；任何部分 Git 改动；ambiguous response loss；unknown outcome 都不会 retry。Pause/cancel 优先于等待中的 backoff，被动 get/list/review 永远不会启动它。系统持久保留每个 attempt，但公开状态只显示有上限的安全 summary/hash，不返回 raw prompt、error、log 或私有路径。[Phase 10 的真实 ordinary-Chat 流程](https://chatgpt.com/c/6a7cc1a8-bd5c-83ee-9779-7e032776dadd)经历一次 initialize-transport failure、1 秒 backoff，再由第二个 attempt 的真实 Codex 成功；最终 v17 卡片显示一个 semantic turn、两个 attempt、retry 1/1 和一个私有 changed file。

## Windows 支持 Goal 编排吗？

本版本不支持。整个 Goal 功能面（不只是 Live 投影）都依赖由 POSIX advisory lock 支撑的 crash-safe GoalStore lock。因此 CodexPro 会在 Windows 上隐藏全部 Goal 工具，并返回 `server_config.goalOrchestration.supported=false`。Direct coding 和独立 CodingTask（包括 Direct↔Codex 切换）仍可使用。

## CodexPro 能运行超过 180 秒的 benchmark 吗？

可以。前台 `bash` 继续用于短命令；长 benchmark 或测试套件用 `start_background_job`。它会快速返回持久 job id，ChatGPT/MCP 断线或 CodexPro 重启后仍可用 `wait_for_background_job`、`get_background_job`、`list_background_jobs` 恢复状态。只有明确要停止时才调用 `cancel_background_job`。

每次启动都必须提供稳定 `job_key`。相同 key 和相同命令只会返回现有任务，不会重复运行。CodexPro 不会自动重试失败或推进 benchmark 阶段，命令仍受 safe/full bash 和 bash session guard 约束。

对 identity 敏感的工作还应传入完整 `expected_git_head` 并设置 `require_clean_worktree: true`；两项会被检查两次，并成为幂等执行契约的一部分。如果服务环境解析到的 Codex 与终端不同，请用 `--codex-bin /absolute/path/to/codex` 重启，并通过 `server_config` 检查 `codexBin`。

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

如果只是希望通过同一个 connector 切换项目，可以先在主项目保存额外项目：

```bash
codexpro settings set --project ~/code/repo-b --project ~/code/repo-c
codexpro start
```

`open_workspace` 会把已允许的项目设为当前 MCP session 的选择。之后其他工具可以省略 `workspace_id`。`open_current_workspace` 会切回启动时的主项目。

项目选择按 MCP session 隔离，但 ChatGPT conversation 不保证和 MCP session 一一对应。需要严格隔离时，请为每个仓库使用不同本地端口和不同 tunnel hostname。

示例：

```text
repo A: port 8787, hostname A
repo B: port 8788, hostname B
```

分别在两个仓库里运行 `codexpro setup` 并保存 profile。

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
