'use strict';

const MAX_BODY_BYTES = 100 * 1024;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function writeJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  writeJson(res, 404, { error: 'Not found' });
}

function badRequest(res, message) {
  writeJson(res, 400, { error: message });
}

function internalError(res, error, prefix, message) {
  console.error(prefix, error?.message || error);
  writeJson(res, 500, { error: message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });

    req.on('error', reject);
  });
}

function getRequestUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

module.exports = {
  setCorsHeaders,
  writeJson,
  notFound,
  badRequest,
  internalError,
  readJsonBody,
  getRequestUrl,
};
