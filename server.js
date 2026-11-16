'use strict';
const runtime = require('./lib/runtime');
const ctx = runtime.init();
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

// No order engine may be armed in the default preview deployment.
app.use('/api/spot-dca', (req, res, next) => {
  // Token verification has no trading side effects and is available in preview mode.
  if (req.method === 'GET' || (req.method === 'POST' && req.path === '/auth')) return next();
  return runtime.requireLive(req, res, next);
});
const engine = require('./spotDcaEngine');
app.use('/api/spot-dca', engine.router);
app.get(['/', '/SpotDCA', '/SmartDCA'], (req, res) => res.sendFile(path.join(ctx.root, 'public/SpotDCA.html')));
app.use(express.static(path.join(ctx.root, 'public')));
runtime.serve(app, ctx, (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/api/ws-dca') return false;
  engine.handleUpgrade(req, socket, head);
  return true;
});
