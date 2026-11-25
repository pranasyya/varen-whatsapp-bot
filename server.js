// Varen WhatsApp bot — web server.
//   /webhook  : SmartPing / Meta sends customer messages here
//   /agent    : password-protected inbox for the Varen team
//   /health   : shows "ok" (used to check the bot is running)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./src/config');
const store = require('./src/store');
const wa = require('./src/whatsapp');
const flow = require('./src/flow');
const content = require('./src/content');

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- small helpers

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validSignature(req, raw) {
  if (!config.appSecret || config.provider === 'smartping') return true; // only Meta signs webhooks
  const header = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', config.appSecret).update(raw).digest('hex');
  return safeEqual(header, expected);
}

function agentAuthorised(req) {
  if (!config.agentPassword) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return safeEqual(pass, config.agentPassword);
}

// Process one customer's messages one at a time, in order.
const queues = new Map();
function enqueue(phone, task) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.then(task).catch((err) => console.error(`Error handling message from ${phone}:`, err));
  queues.set(phone, next);
  next.finally(() => queues.get(phone) === next && queues.delete(phone));
  return next;
}

// ---------------------------------------------------------------- webhook

// Finds the WhatsApp "value" objects in a webhook payload. Meta and SmartPing both use
// Meta's format ({ entry: [{ changes: [{ value }] }] }); a few simpler shapes are accepted too.
function findValues(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload)) return payload.flatMap(findValues);
  if (Array.isArray(payload.entry)) return payload.entry.flatMap((e) => (e.changes || []).map((c) => c.value || {}));
  if (payload.value) return findValues(payload.value);
  if (payload.messages || payload.statuses) return [payload];
  if (payload.data) return findValues(payload.data);
  return [];
}

function handleWebhookPayload(payload, rawText) {
  const values = findValues(payload);
  let found = 0;
  for (const value of values) {
    for (const status of value.statuses || []) {
      found++;
      if (status.status === 'failed') console.error('Message failed to deliver:', JSON.stringify(status.errors || status));
    }
    const contacts = value.contacts || [];
    for (const msg of value.messages || []) {
      found++;
      if (!msg.from) continue;
      if (store.alreadyProcessed(msg.id)) continue;
      const name = contacts.find((c) => c.wa_id === msg.from)?.profile?.name || '';
      console.log(`Incoming ${msg.type} message from +${msg.from}`);
      enqueue(msg.from, async () => {
        await wa.markRead(msg.id);
        await flow.handleIncoming(msg, name);
      });
    }
  }
  if (!found) {
    console.warn('Webhook received something the bot does not understand. Send this to your developer/Claude:');
    console.warn(String(rawText).slice(0, 2000));
  }
}

async function checkSmartPing() {
  if (!config.smartpingApiKey) return { configured: false };
  try {
    const r = await fetch(`${config.smartpingBaseUrl}/getuserdetails`, { headers: { apikey: config.smartpingApiKey }, signal: AbortSignal.timeout(10000) });
    const data = await r.json().catch(() => ({}));
    const numbers = (data.data || []).map((d) => ({ number: d.wanumber, phone_number_id: d.phone_number_id }));
    return {
      configured: true,
      keyWorks: r.ok && numbers.length > 0,
      numbers,
      phoneNumberIdMatches: numbers.some((n) => String(n.phone_number_id) === String(config.phoneNumberId)),
      ...(r.ok ? {} : { error: data }),
    };
  } catch (err) {
    return { configured: true, keyWorks: false, error: err.message };
  }
}

// ---------------------------------------------------------------- agent inbox API

function summary(conv) {
  const last = conv.messages[conv.messages.length - 1];
  return {
    phone: conv.phone,
    name: conv.customer?.name || conv.profileName || '',
    mode: conv.mode,
    unread: conv.unread || 0,
    handoverReason: conv.handoverReason,
    lastActivityAt: conv.lastActivityAt,
    lastMessage: last ? `${last.from}: ${last.text}`.slice(0, 90) : '',
    windowOpen: !!conv.lastCustomerMsgAt && Date.now() - conv.lastCustomerMsgAt < DAY,
  };
}

async function handleAgentApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','conversations',phone,action]
  if (parts[1] !== 'conversations') return send(res, 404, { error: 'Not found' });

  if (!parts[2] && req.method === 'GET') {
    const list = store
      .listConversations()
      .map(summary)
      .sort((a, b) => (a.mode === 'agent') - (b.mode === 'agent') || a.lastActivityAt - b.lastActivityAt)
      .reverse();
    return send(res, 200, list);
  }

  const phone = (parts[2] || '').replace(/\D/g, '');
  const existing = store.listConversations().find((c) => c.phone === phone);
  if (!existing) return send(res, 404, { error: 'Conversation not found' });
  const conv = existing;

  if (!parts[3] && req.method === 'GET') {
    conv.unread = 0;
    store.save();
    return send(res, 200, { ...summary(conv), customer: conv.customer, messages: conv.messages });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const body = JSON.parse((await readBody(req)).toString() || '{}');

  if (parts[3] === 'reply') {
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { error: 'Empty message' });
    try {
      await wa.sendText(conv.phone, text, 'agent');
    } catch (err) {
      store.addMessage(conv.phone, 'system', `Reply NOT delivered: ${err.message}`);
      return send(res, 502, { error: err.message });
    }
    conv.mode = 'agent';
    conv.handoverAt = conv.handoverAt || Date.now();
    conv.lastAgentActivityAt = Date.now();
    conv.unread = 0;
    store.save();
    return send(res, 200, { ok: true });
  }

  if (parts[3] === 'takeover') {
    conv.mode = 'agent';
    conv.handoverAt = Date.now();
    conv.lastAgentActivityAt = Date.now();
    conv.handoverReason = conv.handoverReason || 'Taken over by team member';
    store.addMessage(conv.phone, 'system', 'Team member took over the chat');
    return send(res, 200, { ok: true });
  }

  if (parts[3] === 'release') {
    flow.releaseToBot(conv);
    store.addMessage(conv.phone, 'system', 'Chat handed back to the bot');
    if (body.notify !== false && summary(conv).windowOpen) {
      try {
        await wa.sendText(conv.phone, content.messages.backToBot);
      } catch (err) {
        console.error('Could not send back-to-bot message:', err.message);
      }
    }
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Unknown action' });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Optional secret word in the webhook address: /webhook?key=WEBHOOK_KEY
    if (url.pathname === '/webhook' && config.webhookKey && url.searchParams.get('key') !== config.webhookKey) {
      console.warn('Rejected a webhook call without the right ?key= (check WEBHOOK_KEY).');
      return send(res, 401, 'Wrong key', 'text/plain');
    }

    // Meta checks the webhook address once when you save it (SmartPing may just open it to test).
    if (url.pathname === '/webhook' && req.method === 'GET') {
      if (!url.searchParams.get('hub.mode')) return send(res, 200, 'Varen webhook is ready', 'text/plain');
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.verifyToken;
      if (ok) {
        console.log('Webhook verified by Meta ✔');
        return send(res, 200, url.searchParams.get('hub.challenge') || '', 'text/plain');
      }
      console.warn('Webhook verification failed: VERIFY_TOKEN does not match what you typed in Meta.');
      return send(res, 403, 'Verification failed', 'text/plain');
    }

    // Customer messages arrive here.
    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!validSignature(req, raw)) {
        console.warn('Rejected a webhook call with a bad signature (check APP_SECRET).');
        return send(res, 401, 'Bad signature', 'text/plain');
      }
      send(res, 200, 'EVENT_RECEIVED', 'text/plain'); // answer Meta fast, then work
      try {
        handleWebhookPayload(JSON.parse(raw.toString()), raw.toString());
      } catch (err) {
        console.error('Could not read webhook payload:', err.message);
      }
      return;
    }

    if (url.pathname === '/health') {
      const info = { ok: true, provider: config.provider, dryRun: config.dryRun, ai: !!config.anthropicApiKey };
      if (url.searchParams.get('check') === 'smartping') info.smartping = await checkSmartPing();
      return send(res, 200, info);
    }
    if (url.pathname === '/') return send(res, 200, 'Varen WhatsApp bot is running. Team inbox: /agent', 'text/plain');

    // Everything below needs the agent password.
    if (url.pathname === '/agent' || url.pathname.startsWith('/api/')) {
      if (!config.agentPassword) return send(res, 503, 'Set AGENT_PASSWORD to use the inbox.', 'text/plain');
      if (!agentAuthorised(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Varen inbox"', 'Content-Type': 'text/plain' });
        return res.end('Password required');
      }
      if (url.pathname === '/agent') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'agent.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      return await handleAgentApi(req, res, url);
    }

    send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

server.listen(config.port, () => {
  console.log(`Varen bot listening on port ${config.port}`);
  if (config.dryRun) console.log('⚠ DRY RUN: no WhatsApp token set, messages are printed instead of sent.');
  if (!config.anthropicApiKey) console.log('⚠ No ANTHROPIC_API_KEY: typed questions use simple FAQ matching only.');
  console.log(`WhatsApp provider: ${config.provider === 'smartping' ? 'SmartPing (Pinbot)' : 'Meta Cloud API'}`);
  if (config.provider === 'meta' && !config.appSecret) console.log('⚠ No APP_SECRET: webhook signatures are not being checked.');
  if (config.provider === 'smartping' && !config.webhookKey) console.log('⚠ No WEBHOOK_KEY: anyone who knows the webhook address could post fake messages.');
});

process.on('SIGTERM', () => {
  store.saveNow();
  process.exit(0);
});
