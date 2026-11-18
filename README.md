# alimail-admin-mcp

基于[阿里邮箱开放平台 API](https://mailhelp.aliyun.com/docs/api/alibaba-mail-api) 的 MCP（Model Context Protocol）服务。在 Claude、VS Code Copilot、Cursor 等 AI 客户端里，用自然语言管理企业邮箱的**用户**和**部门**。

> ⚠️ 本项目为**非官方**实现，与阿里云 / 阿里邮箱无隶属关系。它使用的应用凭证具有企业邮箱管理员级别的权限，请在充分理解风险后使用。

## 特性

- **27 个工具**，分为 `users`、`departments` 两个工具集：账号增删改查、别名、重置密码、邮箱设置、共享成员、安全手机、撤销登录态；部门增删改查、层级链，以及可递归获取整棵**部门树**的组合工具
- **默认只读**：`ALIMAIL_READ_ONLY=true` 时只注册 11 个查询工具
- **破坏性操作需两步确认**：先返回预览和一次性 `confirmToken`，确认后才执行
- **域名范围限制**：`ALIMAIL_ALLOWED_DOMAINS` 可限定只能操作指定域名下的账号
- **审计日志**：所有写操作都记录为 JSON 行，密码、token 等敏感字段自动脱敏
- **稳健的 API 客户端**：token 缓存并提前刷新；令牌桶限流；`429`/`5xx` 自动退避重试，非幂等写操作不盲目重试；错误统一格式化并附带修复提示
- **两种传输方式**：stdio（默认）与 Streamable HTTP（`--http`）
- Resources：`alimail://departments/tree`、`alimail://users/{email}`；Prompts：`onboard_employee`（入职）、`offboard_employee`（离职）

## 准备工作：创建阿里邮箱应用

1. 以管理员身份登录阿里邮箱域管后台，进入 **高级应用 → API 开放平台**（或“应用管理”），创建应用。
2. 按最小权限原则授予用户、部门相关的 API 权限。只读场景只授读权限；需要写操作再授读写权限。权限名称以后台实际列出的为准。
3. 记录应用的 `client_id` 与 `client_secret`。
4. 确认企业所在集群的 API 地址（默认 `https://alimail-cn.aliyuncs.com`）。

> 免费版阿里邮箱不支持 API 开放平台。单个域内所有应用的 API 调用合计不能超过 40 次/秒。

## 配置

所有配置都通过环境变量提供（可参考 [.env.example](./.env.example)）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ALIMAIL_CLIENT_ID` | — | **必填**，应用 ID |
| `ALIMAIL_CLIENT_SECRET` | — | **必填**，应用 Secret |
| `ALIMAIL_API_BASE` | `https://alimail-cn.aliyuncs.com` | API 地址，不同集群不能混用 |
| `ALIMAIL_READ_ONLY` | `true` | 设为 `false` 才会注册写操作和破坏性工具 |
| `ALIMAIL_TOOLSETS` | `users,departments` | 启用的工具集 |
| `ALIMAIL_ALLOWED_DOMAINS` | 空（不限制） | 限定可操作的邮箱域名，逗号分隔，子域名同样适用 |
| `ALIMAIL_MAX_QPS` | `20` | 本服务的请求速率上限（最大 40），需要给同域的其他应用留出余量 |
| `ALIMAIL_TIMEOUT_MS` | `15000` | 单次请求超时 |
| `ALIMAIL_AUDIT_LOG` | 空（输出到 stderr） | 审计日志文件路径 |
| `MCP_HTTP_HOST` | `127.0.0.1`（Docker 镜像内为 `0.0.0.0`） | HTTP 监听地址 |
| `MCP_HTTP_PORT` | `3000` | HTTP 端口 |
| `MCP_AUTH_TOKEN` | 空 | HTTP 模式下可选：设置后请求必须带 `Authorization: Bearer <token>` |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | 允许的 Host 头，用于防御 DNS rebinding |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 运行

### 方式一：npx（推荐）

已发布到 npm：[`@mfc-open/alimail-admin-mcp`](https://www.npmjs.com/package/@mfc-open/alimail-admin-mcp)，需要 Node.js 20 或更高版本。

```bash
ALIMAIL_CLIENT_ID=xxx ALIMAIL_CLIENT_SECRET=yyy npx -y @mfc-open/alimail-admin-mcp --check   # 验证凭证（只换取 token，不调用业务接口）
ALIMAIL_CLIENT_ID=xxx ALIMAIL_CLIENT_SECRET=yyy npx -y @mfc-open/alimail-admin-mcp --list-tools
```

也可以全局安装：`npm i -g @mfc-open/alimail-admin-mcp`，之后直接运行 `alimail-admin-mcp`。

命令行参数：`--http`、`--host`、`--port`、`--check`、`--list-tools`、`--version`、`--help`。

### 方式二：从源码运行

```bash
npm ci
npm run build
ALIMAIL_CLIENT_ID=xxx ALIMAIL_CLIENT_SECRET=yyy node dist/index.js --check
```

### 方式三：Docker

镜像由 GitHub Actions 自动构建并发布到 GitHub Container Registry，支持 `linux/amd64` 和 `linux/arm64`：

```bash
docker pull ghcr.io/mfc-open/alimail-admin-mcp:latest
```

| 标签 | 含义 |
|---|---|
| `latest`、`X.Y.Z`、`X.Y`（`X` 从 1.0 开始） | 正式版本，在推送 `vX.Y.Z` 标签时发布 |
| `main` | `main` 分支的最新构建 |
| `sha-<短提交号>` | 对应某次提交的构建 |

也可以在本地构建：

```bash
docker build -t alimail-admin-mcp:local .
```

下文示例使用 GHCR 镜像。如果是本地构建，把镜像名换成 `alimail-admin-mcp:local` 即可。

```bash
# 验证凭证
docker run --rm -e ALIMAIL_CLIENT_ID=xxx -e ALIMAIL_CLIENT_SECRET=yyy ghcr.io/mfc-open/alimail-admin-mcp:latest --check
```

**stdio 模式**：由 MCP 客户端负责拉起容器，必须带 `-i`：

```bash
docker run -i --rm -e ALIMAIL_CLIENT_ID -e ALIMAIL_CLIENT_SECRET ghcr.io/mfc-open/alimail-admin-mcp:latest
```

**HTTP 模式**：作为常驻服务运行：

```bash
cp .env.example .env    # 填入凭证
docker compose up -d --build
curl http://localhost:3000/healthz
```

`docker-compose.yml` 默认只把端口发布在 `127.0.0.1` 上，MCP 地址为 `http://localhost:3000/mcp`。

## 客户端配置

### VS Code（`.vscode/mcp.json`）

使用 `inputs` 在运行时输入密钥，避免把密钥写进配置文件：

```json
{
  "inputs": [
    { "id": "alimail-id", "type": "promptString", "description": "AliMail Client ID" },
    { "id": "alimail-secret", "type": "promptString", "description": "AliMail Client Secret", "password": true }
  ],
  "servers": {
    "alimail-admin": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mfc-open/alimail-admin-mcp"],
      "env": {
        "ALIMAIL_CLIENT_ID": "${input:alimail-id}",
        "ALIMAIL_CLIENT_SECRET": "${input:alimail-secret}",
        "ALIMAIL_READ_ONLY": "true"
      }
    }
  }
}
```

使用 Docker 时，把 `command`/`args` 换成 `"command": "docker", "args": ["run", "-i", "--rm", "-e", "ALIMAIL_CLIENT_ID", "-e", "ALIMAIL_CLIENT_SECRET", "-e", "ALIMAIL_READ_ONLY", "ghcr.io/mfc-open/alimail-admin-mcp:latest"]`；从源码运行时，换成 `"command": "node", "args": ["/绝对路径/alimail-admin-mcp/dist/index.js"]`。

连接 HTTP 模式的服务：

```json
{
  "servers": {
    "alimail-admin": { "type": "http", "url": "http://localhost:3000/mcp" }
  }
}
```

### Claude Desktop / Cursor / Cline

```json
{
  "mcpServers": {
    "alimail-admin": {
      "command": "npx",
      "args": ["-y", "@mfc-open/alimail-admin-mcp"],
      "env": {
        "ALIMAIL_CLIENT_ID": "xxx",
        "ALIMAIL_CLIENT_SECRET": "yyy",
        "ALIMAIL_READ_ONLY": "true"
      }
    }
  }
}
```

## 工具一览

✏️ 表示写操作（仅在 `ALIMAIL_READ_ONLY=false` 时注册），🔥 表示破坏性操作（同样需要关闭只读模式，并且需要两步确认）。

### users

| 工具 | 说明 |
|---|---|
| `list_users` | 按 filter 查询用户，游标分页。filter 示例：`(departmentId=xxx*)`、`(\|(name=Jack)(email=*jack*))` |
| `get_user` / `get_users_by_ids` | 获取单个用户 / 批量获取（最多 100 个） |
| `get_mailbox_settings` | 获取邮箱设置（外发限制、转发、附件大小等） |
| `list_shared_members` | 查询共享 / 委托成员 |
| ✏️ `create_user` | 创建账号；不传密码时自动生成，并强制下次登录修改 |
| ✏️ `update_user` | 更新资料、部门、状态（`FREEZE` 为冻结） |
| ✏️ `add_email_alias` | 添加别名 |
| ✏️ `update_mailbox_settings` | 修改邮箱设置 |
| ✏️ `add_shared_members` / `update_shared_members` | 添加 / 更新共享成员权限（LOGIN、SEND_AS、SEND_ON_BEHALF） |
| ✏️ `bind_security_phone` | 绑定安全手机 |
| 🔥 `delete_user` | 删除账号（不可逆） |
| 🔥 `reset_password` | 重置密码（可自动生成） |
| 🔥 `remove_email_alias` | 删除别名 |
| 🔥 `remove_shared_members` | 移除共享成员 |
| 🔥 `unbind_security_phone` | 解绑安全手机 |
| 🔥 `revoke_user_sessions` | 撤销全部登录态 |

### departments

| 工具 | 说明 |
|---|---|
| `get_department` | 获取部门信息，`$root` 表示根部门 |
| `get_departments_by_ids` | 批量获取（最多 100 个） |
| `list_sub_departments` / `list_department_users` | 直属子部门 / 直属成员（offset 分页） |
| `get_department_chain` | 层级链（支持单个或批量） |
| `get_department_tree` | 递归获取整棵部门树，自动分页；可设置深度、节点上限，可附带成员 |
| ✏️ `create_department` / `update_department` | 创建 / 更新（修改 `parentId` 即为移动部门） |
| 🔥 `delete_department` | 删除部门；非空部门会删除失败，预览中会提示 |

## 安全机制

### 两步确认

调用破坏性工具时：

1. **第一次调用**（不带 `confirm`）不会执行操作。它返回 `status: "confirmation_required"`，同时附带目标对象的预览（例如被删除用户的姓名、邮箱、状态）和一个 `confirmToken`。
2. AI 必须把预览展示给用户，并取得明确同意。
3. **第二次调用**使用**完全相同的参数**，并带上 `confirm: true` 和 `confirmToken`，这时才真正执行。

`confirmToken` 只能使用一次，5 分钟后过期，并与工具名和参数绑定：换了目标或修改了参数，token 即失效。

### 其他

- 自动生成的密码只在执行结果中出现一次，不会写入日志或审计记录。
- 设置 `ALIMAIL_ALLOWED_DOMAINS` 后，所有针对单个用户的操作都会检查目标所在域名。用 ID 定位用户时，服务会先查询出邮箱再做检查。创建用户、添加别名、共享成员中的地址也会检查。**列表类查询（`list_users` 等）不受此限制。**
- HTTP 模式：
  - 默认只监听 `127.0.0.1`，并校验 Host 头以防御 DNS rebinding。
  - 如果监听在非回环地址上又没有设置 `MCP_AUTH_TOKEN`，启动时会输出警告。
  - **不要把未加认证的端口暴露到局域网或公网**：能访问这个端口的人，就能以邮箱管理员身份执行操作。
- HTTP 模式是无状态的：每个请求都会新建 MCP 会话。token 缓存、限流、确认令牌和审计日志在进程内共享。

## 开发

```bash
npm ci
npm run typecheck
npm test          # vitest；所有 HTTP 请求均为模拟，不访问真实环境
npm run build
npm run inspect   # 使用 MCP Inspector 调试（需先设置凭证环境变量）
```

目录结构：

```
src/
  index.ts            CLI 入口
  config.ts           环境变量校验
  server.ts           组装 McpServer
  client/             token、限流、HTTP、分页、错误
  guard/              两步确认、域名范围、脱敏、审计
  tools/              registry + users + departments
  resources/ prompts/
  transports/         stdio、Streamable HTTP
test/                 单元测试与端到端测试（InMemory 及 HTTP）
```

新增工具集（例如邮件组、公共联系人、隔离区）的步骤：

1. 在 `src/config.ts` 的 `TOOLSETS` 中登记名称。
2. 新建 `src/tools/<name>.ts`，用 `defineTool` 定义工具。
3. 在 `src/server.ts` 的 `ALL_TOOLS` 中注册。

接口的字段、分页方式和所需权限，请以[官方文档](https://mailhelp.aliyun.com/docs/api/alibaba-mail-api)为准。

### 发布

[`.github/workflows/docker.yml`](./.github/workflows/docker.yml) 的行为：

- **Pull Request**：运行测试，并构建镜像，但不推送。
- **推送到 `main`**：测试通过后推送 `main` 和 `sha-*` 标签。
- **推送 `v*` 标签**：推送版本号标签和 `latest`，同时附带构建来源证明（build provenance attestation）。

[`.github/workflows/npm.yml`](./.github/workflows/npm.yml) 在推送 `v*` 标签时发布 npm 包：先校验标签与 `package.json` 版本一致，再通过 [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)（OIDC，无需 `NPM_TOKEN`）发布，并附带 provenance。预发布版本（如 `0.2.0-beta.1`）使用 `next` 标签，不影响 `latest`。

发布新版本的步骤：

```bash
npm version 0.2.0 --no-git-tag-version   # 同步修改 package.json 和 CHANGELOG.md
git commit -am "chore: release v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

> 首次推送后，GHCR 上的包默认是**私有**的。如果要让别人免登录拉取，需要在仓库的 Packages → 包设置 → Change visibility 中改为 Public。

## 许可

[MIT](./LICENSE)
