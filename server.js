require('dotenv').config();

if (!process.env.SOCIALAPIS_TOKEN) throw new Error('CRITICAL: SOCIALAPIS_TOKEN is not set');
if (!process.env.GROQ_API_KEY) throw new Error('CRITICAL: GROQ_API_KEY is not set');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('CRITICAL: Supabase credentials are not set');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { nanoid } = require('nanoid');
const buildAiPrompt = require('./prompts/ai-report');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://images.weserv.nl", "https://ui-avatars.com", "https://*.cdninstagram.com", "https://*.fbcdn.net"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const cache = new NodeCache({ stdTTL: 3600, maxKeys: 1000 });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const generalLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15, message: { error: 'Лимит запросов исчерпан' } });
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, skip: (req) => req.body?.username && cache.has(`ai:${req.body.username}`), message: { error: 'Лимит AI-запросов исчерпан' } });

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/terms', (req, res) => res.send('<div style="font-family:sans-serif;text-align:center;margin-top:20vh"><h1>Terms</h1><p>Не аффилировано с Meta.</p></div>'));
app.get('/privacy', (req, res) => res.send('<div style="font-family:sans-serif;text-align:center;margin-top:20vh"><h1>Privacy</h1><p>Данные из публичных источников.</p></div>'));

app.get('/api/analyze', generalLimiter, async (req, res) => {
  const { username } = req.query;
  if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) return res.status(400).json({ error: 'Некорректный username' });
  
  const cached = cache.get(`analyze:${username}`);
  if (cached) return res.json({ data: cached, cached: true, ts: Date.now() });

  try {
    // ПРАВИЛЬНЫЙ ЭНДПОИНТ ИЗ ДОКУМЕНТАЦИИ SOCIALAPIS
    const response = await axios.get(`https://api.socialapis.io/instagram/profile/details`, {
      params: { username: username },
      headers: { 'x-api-token': process.env.SOCIALAPIS_TOKEN },
      timeout: 10000
    });

    const data = response.data?.data || response.data;

    if (data.is_private === true) return res.status(403).json({ error: 'Приватный аккаунт' });
    
    cache.set(`analyze:${username}`, data);
    res.json({ data, cached: false, ts: Date.now() });
    
  } catch (error) {
    console.error('SOCIALAPIS ERROR:', error.response?.data || error.message);
    if (error.response?.status === 404) return res.status(404).json({ error: 'Аккаунт не найден' });
    res.status(502).json({ error: 'Ошибка провайдера данных' });
  }
});

app.post('/api/ai', aiLimiter, async (req, res) => {
  const { username, metrics } = req.body;
  if (!username || !metrics || !metrics.posts || !metrics.flw) return res.status(400).json({ error: 'Мало данных' });
  const cached = cache.get(`ai:${username}`);
  if (cached) return res.json({ report: cached, cached: true });

  try {
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: buildAiPrompt({ username, ...metrics }) }],
      temperature: 0.7
    }, {
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    const report = response.data.choices[0].message.content;
    cache.set(`ai:${username}`, report, 1800);
    res.json({ report, cached: false });
  } catch (error) {
    res.status(502).json({ error: 'AI недоступен' });
  }
});

app.post('/api/share', generalLimiter, async (req, res) => {
  const { username, report_md, metrics } = req.body;
  if (!username || !report_md) return res.status(400).json({ error: 'Нет данных' });

  const id = nanoid(12);
  const { error } = await supabase.from('reports').insert({
    id, username, report_md, metrics, expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
  });

  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json({ url: `${process.env.BASE_URL || 'http://localhost:3000'}/r/${id}` });
});

app.get('/r/:id', async (req, res) => {
  const { data, error } = await supabase.from('reports').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).send('<h1 style="text-align:center;margin-top:20vh">Не найден</h1>');
  if (new Date(data.expires_at) < new Date()) return res.status(410).send('<h1 style="text-align:center;margin-top:20vh">Истек</h1>');

  await supabase.rpc('increment_views', { report_id: req.params.id });

  const htmlTemplate = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Аудит</title>
    <style>:root{--bg:#000;--surface:rgba(28,28,32,0.6);--border:rgba(255,255,255,0.1);--text:#f5f5f7;--muted:#86868b;--gradient:linear-gradient(135deg,#0a84ff,#5e5ce6,#bf5af2)}*{box-sizing:border-box;font-family:-apple-system,sans-serif}body{background:var(--bg);color:var(--text);padding:40px 20px;line-height:1.6}.container{max-width:800px;margin:0 auto}.header{text-align:center;margin-bottom:40px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:32px}.metric-card{background:var(--surface);border:1px solid var(--border);padding:20px;border-radius:16px;text-align:center}.metric-val{font-size:1.8rem;font-weight:bold}.metric-label{font-size:0.8rem;color:var(--muted);text-transform:uppercase}.report-content{background:var(--surface);border:1px solid var(--border);padding:32px;border-radius:20px}.report-content h2{color:#5ac8fa;border-bottom:1px solid var(--border);padding-bottom:8px;margin:24px 0 16px}.report-content ul{padding-left:20px;margin-bottom:16px;color:var(--muted)}.cta-box{margin-top:40px;text-align:center;padding:32px;background:rgba(10,132,255,0.1);border:1px solid rgba(10,132,255,0.3);border-radius:20px}.btn-primary{display:inline-block;background:var(--gradient);color:white;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:bold;margin-top:16px}</style></head>
    <body><div class="container"><div class="header"><h1>Стратегический Аудит</h1><p style="color:var(--muted)">Подготовлено в Insta Check AI</p></div>
    <div class="metrics"><div class="metric-card"><div class="metric-val">@${data.username}</div><div class="metric-label">Профиль</div></div><div class="metric-card"><div class="metric-val">${Number(data.metrics.f||0).toLocaleString('ru-RU')}</div><div class="metric-label">Аудитория</div></div><div class="metric-card"><div class="metric-val" style="color:#5ac8fa">${data.metrics.e}%</div><div class="metric-label">ER</div></div><div class="metric-card"><div class="metric-val">${Math.round(data.metrics.a||0)}/100</div><div class="metric-label">AQS</div></div></div>
    <div class="report-content" id="md-render"></div><div class="cta-box"><h3>Хотите такой же разбор?</h3><a href="/" class="btn-primary">Проанализировать профиль ↗</a></div></div>
    <script>
      const rawMd = ${JSON.stringify(data.report_md).replace(/</g, '\\u003c')};
      function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
      let html=esc(rawMd);html=html.replace(/^### (.*$)/gim,'<h3>$1</h3>').replace(/^## (.*$)/gim,'<h2>$1</h2>').replace(/^# (.*$)/gim,'<h2>$1</h2>').replace(/\\*\\*(.*?)\\*\\*/gim,'<strong>$1</strong>').replace(/(?:^\\- .*$\\n?)+/gim,m=>'<ul>'+m.replace(/^\\- (.*$)/gim,'<li>$1</li>')+'</ul>').replace(/\\n/g,'<br>');
      document.getElementById('md-render').innerHTML = html;
    </script></body></html>
  `;
  res.send(htmlTemplate);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
