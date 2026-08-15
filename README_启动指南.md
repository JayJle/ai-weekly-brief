# AI Weekly Brief 启动指南

这份指南按“不会写代码也能操作”的方式编写。项目可放在任意磁盘和任意目录，不依赖 C 盘或固定用户名。

## 1. 第一次安装

先安装 Node.js 22.19 或更高版本，然后在项目文件夹空白处打开 PowerShell 或 Windows Terminal。

```powershell
npm.cmd ci
npm.cmd run setup
```

配置向导会逐项询问：

1. 模型提供商与 API Key；
2. Main Agent 和 Research Agent 的模型 ID；
3. 搜索服务（Tavily、Brave 或 Mock）与 API Key；
4. 飞书群自定义机器人 Webhook URL；
5. DRY_RUN、APPROVAL 或 AUTO 模式；
6. 时区、每周预算、每天唤醒时间和周报发送时间。

模型提供商可选择 DeepSeek、OpenAI、Anthropic Claude、Google Gemini、OpenRouter、xAI、Groq、Mistral、Moonshot/Kimi、智谱、NVIDIA、Cerebras、Fireworks 或 Together。查看当前内置模型：

```powershell
npm.cmd run models:list
npm.cmd run models:list -- deepseek
npm.cmd run models:list -- openrouter deepseek
```

先试运行时可以全部选择 Mock，并选择 `DRY_RUN`。密钥只写入项目根目录的 `.env`；该文件、数据库、日志和备份均已被 Git 忽略。

## 2. 连接真实服务

重新运行配置向导并填写真实信息：

```powershell
npm.cmd run setup
```

然后逐项测试：

```powershell
npm.cmd run config:check
npm.cmd run search:smoke
npm.cmd run pi:smoke
npm.cmd run notify:test
```

- `pi:smoke` 会创建一次新的内存 Pi Session，调用一个受控测试工具并验证模型返回；
- `search:smoke` 会调用已配置的搜索服务；
- `notify:test` 会向你的飞书群发送测试卡片；
- 测试真实模型和搜索会产生对应服务商的 API 费用。

Tavily 使用 `basic` 搜索并关闭自动答案、原始正文和图片，降低 API credits 与上下文消耗。申请 Tavily Key 后，在向导中选择 `Tavily Search API`，将 Key 填入搜索 API Key 项即可。

飞书通知不需要安装 CLI，也不需要创建企业应用。配置方法：

1. 在飞书中新建一个用于接收周报的群聊（群里可以只有你自己）；
2. 打开群设置 → 群机器人 → 添加机器人 → 自定义机器人；
3. 机器人名称可以填写 `AI Weekly Brief`；
4. 建议在安全设置中选择“自定义关键词”，填写 `AI Weekly Brief`；
5. 复制形如 `https://open.feishu.cn/open-apis/bot/v2/hook/...` 的 Webhook URL；
6. 运行 `npm.cmd run setup`，将该地址粘贴到飞书 Webhook 配置项。

Webhook URL 等同于推送密钥，不要发到聊天、截图或提交到 GitHub。

任何一项失败时，先看终端最下方的中文错误，不要继续切换到 `AUTO`。

## 3. 先做一次完整演练

```powershell
npm.cmd run coverage:status
npm.cmd run heartbeat
npm.cmd run status
npm.cmd run history -- 5
npm.cmd run brief:preview
```

`heartbeat` 会让 Main Agent 检查长期状态和来源覆盖，自主选择搜索、研究、合并或停止。每个研究任务都会重新创建独立的 Research Agent Session，结束后销毁；长期结果保存在 SQLite，不依赖子 Agent 的聊天记忆。

### DeepSeek + Tavily 内容质量测试

当模型选择 DeepSeek、搜索选择 Tavily、并已配置飞书 Webhook 后，可以直接生成并推送一份 5 条测试报告：

```powershell
npm.cmd run quality:test
```

也可以指定 1–10 条，例如生成 3 条：

```powershell
npm.cmd run quality:test -- 3
```

该命令会产生真实 DeepSeek 与 Tavily 用量，并立即向飞书群发送卡片；消息会明确标记为“内容质量测试、不是正式周报”。合格结果会写入 `data/quality-test-latest.md`，但不会混入正式候选事件。

不足 10 条合格事件时，周报会明确失败关闭，不会用低质量内容凑数。

## 4. 三种发送模式

- `DRY_RUN`：只研究和生成预览，绝不发周报；适合第一周影子运行。
- `APPROVAL`：到时间生成并检查，但需要你运行 `npm.cmd run brief:send -- 2026-W33` 才发送。
- `AUTO`：周一到达配置时间后，自动处理上一个完整自然周并发送。

建议先使用 `DRY_RUN` 一周，再用 `APPROVAL` 一周，确认内容和来源质量后再改为 `AUTO`。

## 5. 启动与停止

前台启动：

```powershell
npm.cmd start
```

启动后会立即补跑一次 Heartbeat，之后按照 `.env` 中的时间运行。窗口必须保持开启。停止时在该窗口按 `Ctrl+C`。

同一个数据目录只能启动一个实例；误开第二份时程序会提示“项目已经在运行”，防止重复研究或重复发送。

## 6. 电脑关机时继续运行

本地电脑关机后任何本地程序都无法运行。要持续工作，需要一台长期在线的 Linux 云服务器，安装 Git 和 Docker 后执行：

```bash
git clone <你的 GitHub 仓库地址>
cd ai-weekly-brief
cp .env.example .env
# 编辑 .env，填入真实密钥和配置
docker compose up -d --build
docker compose logs -f
```

停止云端服务：

```bash
docker compose down
```

数据库和日志通过挂载保存在服务器仓库目录的 `data/` 与 `logs/` 中，重建容器不会丢失。

## 7. 日常查看

```powershell
npm.cmd run status
npm.cmd run coverage:status
npm.cmd run history -- 20
npm.cmd run brief:preview
```

`status` 会显示：配置摘要、数据库版本、候选数量、连续失败、发送不确定状态、本周 token、美元费用与预算。结构化日志位于 `logs/app-YYYY-MM-DD.jsonl`，敏感字段会自动脱敏。

## 8. 备份与恢复

创建一致性备份：

```powershell
npm.cmd run backup
```

备份会写入 `data/backups/`，并自动执行 SQLite 完整性校验。恢复前先停止程序，把当前 `data/weekly.db` 另行保留，再将选定备份复制为 `data/weekly.db`。如果不确定，请不要覆盖文件，先寻求协助。

## 9. 从 GitHub 更新

先停止程序并备份：

```powershell
npm.cmd run backup
git pull
npm.cmd ci
npm.cmd run db:migrate
npm.cmd test
npm.cmd start
```

项目会从 `package.json` 自动定位根目录，因此移动文件夹、换磁盘或重新克隆后不需要修改源码。相对路径始终以项目根目录为基准。

## 10. Prompt 在哪里

- Main Agent：`prompts/main-agent.v0.1.md`
- Research Agent：`prompts/research-agent.v0.1.md`

修改 Prompt 后建议改版本号并先跑一周 `DRY_RUN`。Prompt 决定目标和判断边界；代码仍负责预算、权限、结构校验、事务、幂等和发布硬门槛。

## 11. 常见问题

### PowerShell 提示“禁止运行脚本”

使用 `npm.cmd`，不要修改系统执行策略：

```powershell
npm.cmd run status
```

### 为什么飞书没有收到周报

依次检查：

```powershell
npm.cmd run config:check
npm.cmd run notify:test
npm.cmd run status
npm.cmd run brief:preview -- 2026-W33
```

常见原因是仍处于 `DRY_RUN`、候选不足 10 条、来源门槛未通过、电脑在执行时间关机、Webhook URL 无效，或飞书机器人的关键词安全设置与消息标题不匹配。

### 发送超时后能否直接重试

不能盲目重试。系统会把结果记为 `UNKNOWN` 并阻止再次发送，以免飞书群收到两份。先查看飞书群和 `npm.cmd run status`，然后二选一：

```powershell
# 确认飞书群已经收到
npm.cmd run delivery:resolve -- 2026-W33 1 SENT

# 确认飞书群没有收到，清除保护后允许重新发送
npm.cmd run delivery:resolve -- 2026-W33 1 RETRY
```

只有在你确实检查过飞书群之后才能使用 `RETRY`。
