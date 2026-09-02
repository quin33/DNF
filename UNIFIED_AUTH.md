# 统一登录配置指南

本文档说明如何配置和使用站点网关的统一登录功能。

## 功能说明

用户在 `https://xiuxiangame.dpdns.org/` 首页登录一次后，可以直接进入所有游戏（DNF、问道仙坊），无需在每个游戏中单独登录。

### 工作原理

1. **统一账号系统**：利用现有的 `ACCOUNT_MIRROR_DB` 机制，两个游戏共享账号数据
2. **网关认证**：首页提供登录/注册表单，验证成功后签发 JWT token
3. **Token 传递**：点击游戏卡片时，URL 携带一次性 token（`?auth_token=xxx`）
4. **游戏端验证**：游戏前端检测到 token 后，调用验证端点换取游戏专属 session token
5. **自动登录**：验证成功后清除 URL 参数，用户直接进入游戏

## 配置步骤

### 1. 生成共享密钥

在终端运行以下命令生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

输出示例：`a3f8c9d2e1b4567890abcdef1234567890abcdef1234567890abcdef12345678`

### 2. 配置环境变量

编辑 `.env` 文件，添加以下配置（三个进程都需要）：

#### 网关进程（`site-gateway.js`）

```bash
# 共享密钥（必须与游戏端一致）
GATEWAY_AUTH_SECRET=你的64字符随机密钥

# Token 有效期（可选，默认 3600 秒 = 1 小时）
GATEWAY_SESSION_EXPIRE=3600

# 数据库路径（网关读取用户信息。统一控制台只把 GATEWAY_ 开头的变量
# 转发给网关进程，所以用 GATEWAY_ 前缀的这两个；DNF 库可不设，默认 ./dnf.db）
GATEWAY_DNF_DB=./dnf.db
GATEWAY_XIUXIAN_DB=I:/DEEPSEEK/DNF/xiuxian/tavern.db
```

#### DNF 游戏进程（`server.js` - DNF）

```bash
# 共享密钥（必须与网关一致）
GATEWAY_AUTH_SECRET=你的64字符随机密钥

# 账号镜像（必须配置，用于共享账号）
ACCOUNT_MIRROR_DB=I:/DEEPSEEK/DNF/xiuxian/tavern.db
```

#### 问道仙坊游戏进程（`server.js` - 问道仙坊）

```bash
# 共享密钥（必须与网关一致）
GATEWAY_AUTH_SECRET=你的64字符随机密钥

# 账号镜像（必须配置，用于共享账号）
ACCOUNT_MIRROR_DB=I:/DEEPSEEK/DNF/dnf.db
```

### 3. 重启所有进程

配置完成后，重启统一控制台（会自动重启网关和所有游戏进程）：

```bash
# 停止现有进程
# （在统一控制台中点击"停止所有"）

# 重启
npm run unified
```

## 使用流程

### 用户视角

1. 访问 `https://xiuxiangame.dpdns.org/`
2. 在首页输入用户名和密码登录（或注册新账号）
3. 登录成功后，点击任意游戏卡片（"问道仙坊" 或 "DNF"）
4. 自动进入游戏，无需再次登录

### 技术流程

```
用户访问首页
  ↓
输入账号密码 → POST /api/gateway/auth/login
  ↓
网关验证（查询 dnf.db 或 tavern.db）→ 签发 JWT token
  ↓
前端保存 token 到 sessionStorage
  ↓
点击游戏卡片 → 跳转 /dnf/?auth_token=<JWT>
  ↓
DNF 前端检测到 auth_token → POST /api/auth/verify-gateway-token
  ↓
DNF 后端验证 JWT 签名和过期时间 → 查询账号 → 签发游戏 session token
  ↓
前端保存到 localStorage（dnf_online_token）→ 清除 URL 参数
  ↓
自动加载角色数据，进入游戏
```

## 安全特性

1. **JWT 签名验证**：使用 HMAC-SHA256 签名，防止 token 伪造
2. **常量时间比较**：密码和签名验证使用 `crypto.timingSafeEqual`，防止时序攻击
3. **短期有效**：token 默认 1 小时过期，降低泄露风险
4. **一次性使用**：URL 参数中的 token 使用后立即清除
5. **账号隔离**：游戏内角色数据仍各自独立，只共享账号认证

## 故障排查

### 1. 登录后点击游戏卡片无反应

**原因**：`GATEWAY_AUTH_SECRET` 未配置或三个进程的密钥不一致

**解决**：
- 检查三个 `.env` 文件中的 `GATEWAY_AUTH_SECRET` 是否完全相同
- 确保密钥长度至少 32 字符
- 重启所有进程

### 2. 提示"token 签名无效"

**原因**：游戏端的 `GATEWAY_AUTH_SECRET` 与网关不一致

**解决**：统一三个进程的密钥配置，重启

### 3. 提示"账号不存在"

**原因**：
- `ACCOUNT_MIRROR_DB` 未配置
- 数据库路径错误
- 账号只在一个数据库中存在，另一个数据库无法访问

**解决**：
- 检查两个游戏的 `ACCOUNT_MIRROR_DB` 配置
- 确认数据库文件路径正确且可读
- 检查网关的 `DNF_DB_PATH` 和 `XIUXIAN_DB_PATH` 配置

### 4. 网关首页无法加载

**原因**：网关进程未启动或数据库路径配置错误

**解决**：
- 查看统一控制台日志，检查网关进程是否启动
- 检查 `gateway-auth.js` 的错误日志
- 确认两个数据库路径都正确

### 5. 调试模式

在浏览器控制台查看详细日志：

```javascript
// 查看当前 token
sessionStorage.getItem('gateway_token')

// 查看用户信息
sessionStorage.getItem('gateway_user')

// 清除登录状态（重新登录）
sessionStorage.clear()
```

## 注意事项

1. **密钥保密**：`GATEWAY_AUTH_SECRET` 是核心密钥，不要提交到版本控制系统
2. **定期更换**：建议每 3-6 个月更换一次密钥（需要同时更新三个进程并重启）
3. **HTTPS 必须**：生产环境必须使用 HTTPS，防止 token 在传输中泄露
4. **账号镜像必配**：统一登录功能依赖 `ACCOUNT_MIRROR_DB`，必须正确配置
5. **数据库备份**：两个数据库都包含用户账号信息，务必定期备份

## 扩展到第三个游戏

如果要添加第三个游戏到统一登录系统：

1. 在新游戏的 `server.js` 中添加 `/api/auth/verify-gateway-token` 端点（参考 DNF 实现）
2. 前端添加 `handleGatewayToken()` 检测逻辑（参考 `online.js`）
3. 配置 `GATEWAY_AUTH_SECRET` 和 `ACCOUNT_MIRROR_DB`
4. 在网关的 `GATEWAY_SITES` 中添加新游戏的入口
5. 重启所有进程

## 相关文件

- `gateway-auth.js`：网关认证模块（登录/注册/JWT 签发）
- `site-gateway.js`：站点网关主文件（API 路由）
- `server.js`：游戏后端（验证网关 token 端点）
- `online.js`：游戏前端（检测和处理 auth_token）
- `.env.example`：配置模板
