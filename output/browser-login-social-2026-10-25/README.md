# 社交平台快捷登录验收（2026-10-25）

现有 `BrowserView` 增加小红书、微博、Instagram、Facebook 四个入口及品牌图标，`browserLoginUrl` 固定地址白名单同步扩充。`browser_accounts` 增加对应名称和用途说明。复用原有用户接管、展开输出、持久浏览器 profile 与交还逻辑，无新增服务或面板。

## 自动检查

- `npm run build`：通过，保留原有大 chunk 提示。
- `npm test`：503 通过，0 失败、0 跳过。
- `npm run check:local`、`node scripts/cloud-preview.mjs --check`：通过。
- 本次修改文件 `git diff --check`：通过。全工作树仍有此前 `tmp/avatar-eye-study/` 的空白告警，本次未改这些文件。

## 页面检查

使用临时 `RAYTONEBOT_DATA_DIR` 启动本机应用；Agent 浏览器使用临时 profile，没有使用真实账号或模型。

- 现有分栏与展开输出均显示四个新增卡片，两个本地 SVG 加载成功。
- 登录列表 `scrollWidth=clientWidth=400`，`scrollHeight=1039`、`clientHeight=491`，可滚动访问全部入口。
- `?devtools=1` 的 19 个事件场景及欢迎页逐项切换，检查页无控制台 error。
- 390px 全页尝试点击原有“展开右侧面板”未显示输出；恢复尺寸后可见。没有扩大本次范围修改响应式面板，390px 视觉验收未完成。

| 入口 | 固定目标 | 本次实际结果 |
| --- | --- | --- |
| 小红书 | `https://www.xiaohongshu.com/explore` | 进入用户接管，先加载发现页，随后站点提示 IP 风险 / 安全限制 |
| 微博 | `https://weibo.com/login.php` | 进入用户接管，官方重定向到 `/newlogin?url=`，显示“登录/注册”入口 |
| Instagram | `https://www.instagram.com/accounts/login/` | 进入用户接管且 URL 正确，本次页面空白，未验证登录表单可用 |
| Facebook | `https://www.facebook.com/login/` | 进入用户接管，显示账号、密码和登录按钮 |

四次点击后均可通过原有关闭按钮返回快捷入口。没有填写凭据、解决验证码或绕过站点限制，未验证真实账号登录与后续 Agent 操作，未部署。

## 截图

- [快捷登录入口](shortcuts.png)
- [小红书限制页面](xiaohongshu.png)
- [微博登录入口](weibo.png)
- [Instagram 页面状态](instagram.png)
- [Facebook 登录页](facebook.png)
