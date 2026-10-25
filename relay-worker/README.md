# YF专用检测工具 · 云端指纹库免登录中转部署说明

当用户在二次验证完成后点击 **「✅ 正确」**：
1. **本机立即生效**：插件会立即将该次 1–3 题指纹特征融合进本机指纹库（Hellinger 355维质心 + 有序分块 74维质心 + Ikale 共享检测器近邻参考集）。
2. **云端多人共享进化**：插件同时将样本免登录 POST 到云端中转接口 -> 自动触发 GitHub `lishuai835/yf-probe-bank` Actions 质心融合流水线 -> 自动更新 `data/unified_bank.json`、`data/shared_detector.json` 与 `data/bank-manifest.json`。其他用户点击 **「☁️ 更新数据」** 即可拉取融合后的最新指纹库。
3. **离线防丢队列**：若云端中转尚未部署或临时断网，已确认「正确」的样本会自动保存在插件本地待传队列，待中转恢复后自动补传。

## 方案 A：免费永久托管至 Cloudflare Workers（推荐，多人免登录 0 服务器成本）
1. 双击本目录下的 **`一键部署CloudflareWorker.bat`**。
2. 部署成功后获得地址（默认：`https://yf-probe-relay.<你的子域>.workers.dev/api/v1/fingerprints`）。
3. 打开插件弹窗或二次验证项中的 **云端上传接口** 填入该地址即可（插件内置任何密钥为 0，分发 `.zip` 给他人完全安全）。

## 方案 B：自建服务器 / 本机 + Cloudflared 隧道
```powershell
$env:NODE_USE_ENV_PROXY="1"
$env:HTTPS_PROXY="http://127.0.0.1:7892"
node relay-server.mjs
# 另开终端暴露公网 HTTPS：
cloudflared tunnel --url http://127.0.0.1:18765
```
将生成的 `https://xxxx.trycloudflare.com/api/v1/fingerprints` 填入云端上传接口即可。
