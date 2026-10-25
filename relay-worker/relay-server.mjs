/* 本地或自建服务器零依赖 Node.js 指纹上传中转端 (配合 cloudflared 或 Nginx 使用) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import worker from './worker.js';

const PORT = Number(process.env.PORT || 18765);
const tokenFile = process.env.GITHUB_TOKEN_FILE || path.join(os.tmpdir(), 'yf_token.txt');
const getToken = () => process.env.GITHUB_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = `http://127.0.0.1:${PORT}${req.url || '/'}`;
    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const webRes = await worker.fetch(webReq, {
      GITHUB_REPO: process.env.GITHUB_REPO || 'lishuai835/yf-probe-bank',
      GITHUB_TOKEN: getToken(),
    });
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    res.end(Buffer.from(await webRes.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, {'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*'});
    res.end(JSON.stringify({ok: false, error: err?.message || 'Internal Error'}));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[YF指纹云端中转] 已启动: http://127.0.0.1:${PORT}/api/v1/fingerprints`);
});
