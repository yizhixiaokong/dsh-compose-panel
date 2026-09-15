# dsh-compose-panel

[English](README.md) | 中文

[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![CI](https://github.com/yizhixiaokong/dsh-compose-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/yizhixiaokong/dsh-compose-panel/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-installable-2ea44f)](https://github.com/topics/dsh-plugin)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 Docker
Compose 项目放进**原生右侧栏**——每个项目目录一组、每个容器实时状态、悬停即可
启停或重启、每个服务一个流式日志标签页。

它针对的正是单文件容器面板会做错的那种工作区布局：一个仓库里的多个子目录各自
拥有自己的 `compose.yaml`。

```
工作区 ~/work/shop
├── compose.yaml            → 分组 “shop”           2/2 运行中
├── services/api/compose.yaml  → 分组 “services/api” 1/3 运行中
└── tools/mail/compose.yaml    → 分组 “tools/mail”  未启动
```

## 功能

- **每个项目目录一组。** 项目以目录为键，绝不用 compose 项目名，因此 `-p`、
  `COMPOSE_PROJECT_NAME` 和 `.env` 都无法把两套不同的栈合并成一行。
- **三种发现来源。** 运行中与已停止的容器、Docker 已知但当前没有容器的项目、
  以及从未启动过的 compose 文件——三者都会出现，所以一个没动过的
  `compose.yaml` 也会显示为“未启动”的项目，而不是消失。
- **限定在工作区内。** 只列出 DSH 工作区内的项目；目录归属按最长匹配确定，工作区
  之外的容器会被统计出来而不是被悄悄丢弃。
- **可折叠分组**、状态右对齐、行高固定（指针划过时页面不会跳动）。
- **悬停操作。** 鼠标停在某行时，状态单元格会换成该行适用的操作：项目级的
  `up -d` / `restart` / `stop`，或单个服务的同样三项。任何命令都不会在未点击时执行。
- **实时日志流。** 点击服务行即为该服务打开日志标签页；点击项目标题则为整个项目
  打开。每个目标保留自己的标签页。
- **静默刷新。** 空闲时每 45 秒、仍有服务在启动时每 8 秒重新读取一次，且不会丢失
  滚动位置、已展开的分组或当前选择。
- 与产品一致的样式：只用 Harness 自己的主题变量，因此自动跟随浅色/深色模式与强调色，
  不需要额外设置页。

## 环境要求

| 要求 | 说明 |
| --- | --- |
| 带 web profile 的 DSH | 插件注册一个右侧栏标签类型和一条 HTTP 路由，二者都由 `webServer` 提供。 |
| **宿主进程** 的 `PATH` 中有 Docker CLI | `docker ps`、`docker compose ls` 以子进程方式执行；需要 compose v2 插件（`docker compose`，不是 `docker-compose`）。 |
| POSIX 系统 | 路径按 POSIX 处理；Windows 未经验证。 |
| 至少一个 DSH 工作区 | 只列出已注册工作区之内的目录。 |

## 安装

从克隆（迭代期推荐）：

```sh
git clone https://github.com/yizhixiaokong/dsh-compose-panel.git
cd dsh-compose-panel
dsh plugin --profile web add "$PWD"
```

从 npm：

```sh
dsh plugin --profile web add dsh-compose-panel
```

两种方式都会把包装进 profile，它的 [`cordis.patch.yml`](cordis.patch.yml)
贡献它所需要的那一行宿主配置。随后重启 Harness 以加载客户端产物：

```sh
dsh web
```

卸载：

```sh
dsh plugin --profile web remove dsh-compose-panel
```

> 客户端部分在宿主启动时完成基线化。在运行中的实例里修改 `lib/client.js`
> 不会生效，直到 `dsh web` 重启——刷新浏览器不够。

## 使用

1. 打开右侧栏，在引导页选择 **🐳 容器** 胶囊。
2. 每个工作区是一个区块，每个项目目录是一个可折叠分组，标题为目录路径，右侧是
   容器状态的汇总。
3. 悬停在项目标题上可对整个项目操作；悬停在容器行上只对该服务操作。指针在行上时，
   操作按钮会替代状态单元格，结果通过一条短横幅提示。
4. 点击容器行（不是按钮）为该服务打开**日志**标签页；点击分组标题打开整个项目的日志。

日志标签页有自己的控件：回放行数（`tail`）、重新打开流、时间戳开关、自动换行，以及
（整项目标签页的）服务名列。

## 项目如何被发现

一次 `list` 调用执行三条命令并按目录合并结果：

| 来源 | 命令 | 贡献 |
| --- | --- | --- |
| 容器 | `docker ps -a --format '{{json .}}'` | 所有容器，按 `com.docker.compose.project.working_dir` 标签分组。 |
| 已知项目 | `docker compose ls --all --format json` | 已存在但当前没有容器的项目（其 `ConfigFiles` 为绝对路径）。 |
| 未动过的文件 | 每个工作区一次有界的 `find` | 从未启动过的 compose 文件：深度 4，并剪掉 `node_modules`、`.git`、`vendor`、`dist`、`build`、`target`、`.venv`、`venv`、`__pycache__`、`.next`、`.cache`、`.tox`。 |

项目目录就是连接键。扫描识别的 compose 文件名包括 `compose.yml`、
`compose.yaml`、`docker-compose.yml`、`docker-compose.yaml`，以及
`compose.<name>.y*ml` / `docker-compose.<name>.y*ml` 变体。

## HTTP 接口

宿主部分注册一条前缀路由 `/compose/api`。所有响应使用同一信封：
成功为 `{"ok":true,"value":…}`，失败为
`{"ok":false,"error":{"code","message"}}`。

任何命令执行之前，请求先经过围栏校验。两个 POST 方法要求 `Host` 为 loopback
地址（`localhost`、`127.0.0.1`、`::1`、`*.localhost`，可带端口）或位于 web
runtime 的信任列表中；被浏览器标记为 `Sec-Fetch-Site: cross-site` 的请求会被拒绝；
如果带 `Origin`，其 host 必须等于 `Host`。日志流使用读侧变体：socket 对端必须是
loopback（或 `Host` 受信任）、不得携带转发头（`forwarded`、`x-forwarded-for`、
`x-real-ip`），且允许缺少 `Origin`——浏览器在同源 `EventSource` 上不会发送它。

### `POST /compose/api/list`

```jsonc
// 请求——root 可选，不传即列出所有工作区
{ "root": "/home/me/work/shop" }
```

```jsonc
// 响应 value
{
  "workspaces": [{ "path": "/home/me/work/shop", "title": "shop" }],
  "groups": [{
    "root": "/home/me/work/shop",
    "title": "shop",
    "scanError": "",
    "projects": [/* … */]
  }],
  "total": 7,       // 所选工作区内的容器数
  "outside": 2,     // 找到但在任何工作区之外的容器数
  "standalone": 1,  // 没有 compose 项目标签的容器数
  "notices": []
}
```

### `POST /compose/api/action`

```jsonc
{
  "action": "restart",          // "up" | "stop" | "restart"，封闭集合
  "dir": "/home/me/work/shop",  // 项目目录，必须在某个工作区内
  "service": "api",             // 可选；省略表示整个项目
  "files": ["/home/me/work/shop/compose.yaml"]  // 可选，传给 -f 的 compose 文件
}
```

```jsonc
// 响应 value；code 是 docker 的退出码，output 是其合并输出
{ "action": "restart", "dir": "…", "service": "api", "code": 0, "output": "" }
```

这里刻意没有 `down`：删除容器与数据卷不属于一次侧栏点击该做的事。`service` 必须匹配
`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`，每个 `-f` 路径都必须位于 `dir` 之内。argv
直接交给 `spawn`，从不经过 shell。

### `GET /compose/api/logs`（Server-Sent Events）

| 参数 | 含义 |
| --- | --- |
| `dir` | 项目目录（必填，必须在工作区内）。 |
| `service` | 单个服务；省略即整个项目。 |
| `tail` | 首次回放行数：默认 `200`，限制在 `1…5000`。 |
| `timestamps` | 为 `1` 时加上 `--timestamps`；默认关闭。 |
| `file` | compose 文件（`-f`），可重复。不传时宿主从 `docker compose ls` 推导，再退化为浅层 `find`。 |

帧为 `data:` JSON 对象：

```jsonc
{ "open": true, "command": "docker compose -f … logs -f --tail 200 api" }
{ "out": "api-1  | listening on :3000\n" }   // stdout 分片，已按 UTF-8 安全切分
{ "err": "…" }                               // stderr 分片，结构相同
{ "eof": true, "code": 0 }                   // docker 退出
{ "error": "spawn failed: …" }
```

日志流带 `NO_COLOR=1`，每 15 秒发送一次注释 ping 以便发现断开的对端，累计 4MB 后停止；
标签页关闭、刷新或跳转时立即结束 docker 进程——`logs -f` 自己永远不会退出。

## 限制与已知行为

- **其余操作只读。** 只有 `up -d`、`stop`、`restart` 可达，侧栏不会以其他方式改变状态。
- **标签解析。** `docker ps` 把 compose 项目标签作为逗号分隔字符串返回；compose 标签
  从不包含逗号，因此按 `,` 切分在此是安全的。
- **日志前缀。** Docker 自带的 `<service> | ` 前缀在整项目标签页中保留；在单服务
  标签页中默认隐藏，因为它只是在重复标签页标题。
- **首次加载。** 首次 `list` 会为每个工作区执行一次 `find`；目录树极大时面板需要一点
  时间才填满，之后的刷新会复用上次结果。
- **不依赖 shell 插件。** 容器状态来自 Docker CLI，因此 Docker 守护进程停止时会显示
  错误提示，而不是一个空面板。

## 开发

```
lib/index.js        宿主部分——路由、发现、docker 调用
lib/client.js       客户端产物——侧栏标签页、列表、日志查看器
cordis.patch.yml    本包贡献的那一行宿主配置
scripts/smoke.mjs   离线检查（不需要 Docker、Harness 或网络）
```

```sh
npm test          # node scripts/smoke.mjs
```

冒烟测试会用桩全局变量物化客户端产物，并把宿主部分应用到桩上下文。它锁定两类在线
排查代价很高的故障：工厂内绑定在声明之前被读取（会在 profile 启动时抛错并连带卸载
其后的每个插件行），以及侧栏座位或路由集合发生变化。

修改 `lib/client.js` 或 `lib/index.js` 之后需要重启 `dsh web`——客户端产物在启动时
完成基线化。

## 仓库说明

版本 tag 与 `package.json` 保持一致——当前这棵树是 `v0.1.1`。

`package.json`、`CHANGELOG.md`、徽章以及上文安装命令中的 `yizhixiaokong` 占位符代表本仓库
将要推送到的 GitHub 账号，发布前请替换。本仓库的提交使用中性的
`dsh-plugins <noreply@example.com>` 身份，以免把个人邮箱带进公开历史；若希望署自己
的名字，可设置 `git config user.name` / `user.email` 后在推送前执行
`git commit --amend --reset-author`。

### 进入插件市场

[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
的插件列表由「一个插件一个 YAML 文件」生成，其 CI 会拿本仓库核对提交的形式。机械
层面的要求本仓库已经满足：`package.json` 中与 `cordis.patch.yml` 并列声明了
`dsh.bundle`；官方的 `@deepseek-ai/*` 包按规范声明为 `peerDependencies`（本包并未
导入它们，但本包是一个 Cordis 插件）；没有任何需要安装的依赖，也没有构建步骤。剩下
的属于仓库所有者的操作：

1. 加上 `dsh-plugin` topic——
   `gh repo edit yizhixiaokong/dsh-compose-panel --add-topic dsh-plugin`；
2. 让仓库创建满 1 天（列表的 CI 会拒绝更年轻的仓库）；
3. 提一个 PR，只新增 `data/plugins/yizhixiaokong__dsh-compose-panel.yml`：

   ```yaml
   url: https://github.com/yizhixiaokong/dsh-compose-panel
   name: yizhixiaokong/dsh-compose-panel
   category: dev
   description:
     en: 'Lists the Docker Compose projects of your DSH workspaces in the right sidebar, one group per project directory, with container status, project- and service-level up/stop/restart, and streamed per-service logs.'
     zh: '在右侧栏列出各 DSH 工作区中的 Docker Compose 项目，按项目目录分组，显示容器状态，支持项目级与服务级 up/stop/restart 以及单服务日志流。'
   ```

市场详情页的截图条读取与 `package.json` 并列的 `screenshots.json`（1–8 张图）。本仓库
没有声明，因此市场会退回到从本 README 中自动抽取图片。

## 许可证

[MIT](LICENSE)
