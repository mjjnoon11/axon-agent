// AXON AGENT server: serves the page and relays API calls so the browser
// never calls OpenAI/Anthropic directly (OpenAI blocks browser calls from many sites).
// Keys still come from the user's browser on every request; nothing is stored or logged here.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const PORT = process.env.PORT || 10000;
const UPSTREAM = {
  openai: process.env.UPSTREAM_OPENAI || 'https://api.openai.com',
  anthropic: process.env.UPSTREAM_ANTHROPIC || 'https://api.anthropic.com',
};
// only these API paths may be relayed
const ALLOWED = {
  openai: /^\/v1\/(chat\/completions|models|audio\/speech|audio\/transcriptions)$/,
  anthropic: /^\/v1\/(messages|messages\/count_tokens)$/,
};
const PASS_REQ = ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'accept'];
const PASS_RES = ['content-type', 'cache-control', 'request-id', 'x-request-id'];
const MAX_BODY = 25 * 1024 * 1024;

const PAGE = path.join(__dirname, 'index.html');

function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if(size > MAX_BODY){ reject(Object.assign(new Error('too large'), {code: 413})); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj){
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(obj));
}

async function relay(req, res, provider, apiPath){
  if(!ALLOWED[provider].test(apiPath)) return sendJson(res, 404, {error: {message: 'Unknown API path'}});
  const headers = {};
  for(const h of PASS_REQ) if(req.headers[h]) headers[h] = req.headers[h];
  let body;
  if(req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
  const ctrl = new AbortController();
  res.on('close', () => { if(!res.writableEnded) ctrl.abort(); });
  let up;
  try{
    up = await fetch(UPSTREAM[provider] + apiPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), {method: req.method, headers, body, signal: ctrl.signal});
  }catch(e){
    if(ctrl.signal.aborted) return;
    return sendJson(res, 502, {error: {message: 'Upstream unreachable'}});
  }
  const out = {'cache-control': 'no-store', 'x-accel-buffering': 'no'};
  for(const h of PASS_RES){ const v = up.headers.get(h); if(v) out[h] = v; }
  res.writeHead(up.status, out);
  if(!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if(p === '/api/health') return sendJson(res, 200, {ok: true, relay: true});
    const m = p.match(/^\/api\/(openai|anthropic)(\/.*)$/);
    if(m){
      if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
      return await relay(req, res, m[1], m[2]);
    }
    if(req.method === 'GET' && (p === '/' || p === '/index.html')){
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache'});
      return fs.createReadStream(PAGE).pipe(res);
    }
    sendJson(res, 404, {error: {message: 'Not found'}});
  }catch(e){
    if(!res.headersSent) sendJson(res, e.code === 413 ? 413 : 500, {error: {message: e.code === 413 ? 'Request too large' : 'Server error'}});
    else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.listen(PORT, () => console.log(`AXON AGENT listening on ${PORT}`));
module.exports = server;
