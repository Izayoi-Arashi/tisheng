# Tisheng · 自托管通用刷题系统

Tisheng (Chinese: 题升) is a self-hosted quiz drilling system that runs on Cloudflare Workers. Question answers never leave the server: every attempt is graded server-side, and study progress syncs across devices. It ships with three generic sample questions so the engine runs out of the box, and you can import your own question sets at any time.

部署在 Cloudflare Workers 上的自托管通用刷题系统：云备份 + 本地题库、账号密码登录、云端进度同步、移动端适配。内置题库已剥离，仅附 3 道通用示例题保证引擎开箱可运行。

## 功能特性

- **云备份 + 本地题库模型**：每个账号有一个「云备份」槽位（题库 + 学习进度存服务端，跨设备同步）；导入的其他题库存于**本机**（含答案，本地判分，进度/错题本也仅存本机），数量不限
- **刷题模式（间隔重复确认）**：答对一次进入「待巩固」，**隔一段时间**（默认 4 小时，可用 `GAP_MS` 调整）再答对一次才算「已斩」；中途答错清零回错题本
- **章节巩固**：章节练习按比例混入「昨天刷过且当前未掌握」的题帮助巩固；这部分作答照常推进状态机与错题本，但不计入今日答题数、打卡、排行榜与成就计数（可关闭）
- **选项乱序**：每次展示题目时选项顺序随机打乱，判分前自动映射回原始选项，题库数据零改动
- **会话回看**：答题过程中可随时回看本次已答过的题（你的选择、正确答案与解析），只读不影响判分与进度
- **无尽模式**：全库或指定范围循环刷题，答完一题自动滚到队尾、永不结束，随时退出即结算
- **题集**：按题干/选项搜索，并按掌握状态与单选/多选筛选；保存为动态题集后可练习与云端同步（只保存筛选规则，不保存题目）
- **错题本**：答错自动收集，隔时再答对才彻底掌握；已斩的题在全量重刷中答错也会打回
- **刷题排行榜**：日榜（UTC+8）/ 周榜 / 月榜，仅上报答题数量（不含题目内容），登录时自动幂等校准，日榜数据 40 天自动过期
- **成就系统**：多枚成就（含三档进阶制），达成即横幅提示并点亮徽章墙，最多佩戴 3 枚徽章展示
- **进度云端同步 + 统计**：斩题记录、错题、每日打卡按账号存 KV；总进度环、章节进度条、近 7 天柱状图
- **移动端 + PC 端**：底部导航单列卡片 / 顶部导航双列章节自适应，支持键盘快捷键
- **PWA**：添加到主屏幕后可全屏运行

> 题目状态：`m` 已斩（掌握）/ `l` 待巩固 / `w` 错题。

## 安全模型

- 密码使用 PBKDF2-SHA256（10 万次迭代 + 随机盐）哈希后存 KV，明文不落库
- 登录态为 HMAC 签名的 HttpOnly Cookie（`Secure; SameSite=Strict`）；支持「7 天免密登录」
- **答案不下发**：前端日常拿到的是无答案题面（`GET /api/mybank` 已剔除答案字段），每次作答由服务端判分（`POST /api/grade`）；只有明确的备份/下载操作才取回完整数据
- 限速：判分 300 次/分钟/用户，注册/登录按 IP 限速（Worker 内存级、尽力而为，生产可叠加 Cloudflare WAF rate limiting）
- 非同站的写请求直接拒绝（`Sec-Fetch-Site` / `Origin` 校验）；静态页启用 CSP 与常见安全响应头
- **Cloudflare Turnstile 人机验证**（可选，推荐启用）：未配置密钥时自动关闭
- 全站 `noindex` + robots.txt 屏蔽搜索引擎
- 闲置账号清理：每日 03:00 UTC 定时任务删除连续 60 天无活动的账号（云端数据一并删除）
- 备份文件（`.tibk`）先用服务端密钥 AES-GCM 加密 + HMAC 指纹，客户端再叠加独立备份密码加密；导入时先校验指纹与完整性

## 部署

前置要求：Node.js ≥ 18、一个 Cloudflare 账号。

```bash
git clone <本仓库> tisheng && cd tisheng
npx wrangler login
```

1. **创建 KV 并回填 id**

   ```bash
   npx wrangler kv namespace create ACA_QUIZ_KV
   ```

   把命令输出的 `id` 填入 `wrangler.toml` 中 `kv_namespaces.id`（替换占位符 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`）。绑定名保持 `ACA_QUIZ_KV` 不改（`src/worker.js` 按该绑定名读取 KV）。

2. **配置 secrets / 变量**（以 `src/worker.js` 实际读取为准）

   ```bash
   npx wrangler secret put SESSION_SECRET        # 必填：会话令牌签名密钥（随机长字符串）
   npx wrangler secret put INVITE_CODE           # 注册邀请码；不设置则注册功能关闭
   npx wrangler secret put TURNSTILE_SITE_KEY    # 可选：Turnstile Site Key（启用人机验证）
   npx wrangler secret put TURNSTILE_SECRET_KEY  # 可选：Turnstile Secret Key
   npx wrangler secret put GAP_MS                # 可选：掌握确认间隔（毫秒），默认 4 小时
   ```

   `GAP_MS` 也可以写在 `wrangler.toml` 的 `[vars]` 里。启用 Turnstile：在 Cloudflare Dashboard → Turnstile → Add site，域名填你的 `*.workers.dev` 域名（及自定义域名），Widget Mode 选 Managed；本地开发可用官方测试密钥（`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`，恒通过），写在 `.dev.vars`。

3. **定时任务**：`wrangler.toml` 的 `[triggers]` 已配置每日 03:00 UTC 清理闲置账号，随部署自动生效。

4. **部署**

   ```bash
   npx wrangler deploy      # 部署；npx wrangler tail 可看线上实时日志
   ```

   部署完成后访问 `https://tisheng.<你的子域>.workers.dev`。

5. **本地开发**：`npm run dev`（即 `npx wrangler dev`，<http://127.0.0.1:8787>）。本地密钥写在 `.dev.vars`（已被 gitignore，与线上 secret 互不影响）。

> 头像违规审核使用 Workers AI（`wrangler.toml` 的 `[ai]` 绑定）。未绑定 AI 时仅头像上传不可用，其余功能不受影响。

## 题库格式与导入

内置 `src/bank.js` 只是 3 道通用示例题 + 1 个示例模块，用于保证引擎开箱可运行。字段格式、判分语义、纠错表以及云备份与本地导入的关系见 **[docs/bank-format.md](docs/bank-format.md)**。

## License

[MIT](./LICENSE)
