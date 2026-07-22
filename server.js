/**
 * server.js
 * Na Brasa — Calculadora de Churrasco (METADAX) — Backend Express
 *
 * Este servidor tem dois papéis:
 *
 * 1) Servir os arquivos estáticos do app (public/index.html e afins).
 *
 * 2) Fazer o PROXY server-side dos fragmentos HTML publicados pela CDN da
 *    METADAX (header.html, footer.html, new-info.html, back-to-top.html,
 *    privacy-banner.html).
 *
 *    Por quê: o component-loader.js (hospedado em cdn.metadax.com.br) busca
 *    esses fragmentos diretamente do navegador via fetch(). No momento, a
 *    CDN responde a essas requisições cross-origin com um header
 *    `Access-Control-Allow-Origin` malformado (contém o literal
 *    `http.request.headers["origin"][0]` em vez do origin real refletido),
 *    então o navegador BLOQUEIA a resposta por política de CORS antes que
 *    o component-loader.js consiga lê-la — é exatamente o que aparece no
 *    console: "has been blocked by CORS policy ... Access-Control-Allow-
 *    Origin header contains the invalid value ...".
 *
 *    Isso é um bug do lado da CDN (fora deste repositório) e não pode ser
 *    corrigido só editando o front-end. A correção possível aqui é evitar
 *    que o navegador precise fazer essa chamada cross-origin: o servidor
 *    Node busca o fragmento (chamada server-to-server, onde CORS não se
 *    aplica) e devolve para o front-end pela MESMA origem do app. Um
 *    pequeno shim no <head> do index.html (ver comentário lá) intercepta as
 *    chamadas que o component-loader.js faz para cdn.metadax.com.br/
 *    components/html/* e as redireciona para este proxy.
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const METADAX_CDN_BASE = process.env.METADAX_CDN_BASE || 'https://cdn.metadax.com.br';

// ─── Security Middleware ────────────────────────────────────
// CSP alinhada ao "Kit de Integração" oficial da METADAX
// (https://design.metadax.com.br/usage/): CDN de assets/CSS/scripts,
// Google Tag Manager + gtag, Meta Pixel (connect.facebook.net) e Google
// Fonts. Sem isso, o app fica sujeito à política padrão do navegador (ou a
// uma CSP genérica injetada por um proxy/CDN na frente do Vercel), que
// bloqueia esses domínios — origem dos avisos "violates ... script-src" e
// "connect-src" vistos no console.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                    METADAX_CDN_BASE,
                    'https://www.googletagmanager.com',
                    'https://www.google-analytics.com',
                    'https://connect.facebook.net'],
      styleSrc:    ["'self'", "'unsafe-inline'",
                    METADAX_CDN_BASE,
                    'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com', METADAX_CDN_BASE],
      imgSrc:      ["'self'", 'data:', 'https:', METADAX_CDN_BASE,
                    'https://www.facebook.com', 'https://www.google-analytics.com'],
      connectSrc:  ["'self'", METADAX_CDN_BASE,
                    'https://www.google-analytics.com',
                    'https://www.googletagmanager.com'],
      frameSrc:    ["'self'", 'https://www.googletagmanager.com'],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// CORS da própria API — só relevante se o front-end for consumido de outra
// origem (ex.: preview deploys). Same-origin (navegador ↔ este servidor)
// sempre funciona independentemente disso.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / server-to-server
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET'],
  allowedHeaders: ['Content-Type']
}));

// ─── Rate limiting nas rotas /api ───────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '300',    10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use('/api', limiter);

app.use(express.json());

// ─── Arquivos estáticos ─────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  index: 'index.html'
}));

// ─── Proxy dos componentes HTML da CDN da METADAX ───────────
//
// Whitelist explícita: nunca repassamos um :name arbitrário para a CDN.
// Os cinco nomes abaixo são os fragmentos que o component-loader.js
// oficial busca (confirmado pelo console log fornecido: header, footer,
// new-info, back-to-top, privacy-banner).
const ALLOWED_COMPONENTS = new Set([
  'header',
  'footer',
  'new-info',
  'back-to-top',
  'privacy-banner'
]);

// Cache em memória simples — evita bater na CDN a cada carregamento de
// página e dá uma resposta ainda que a CDN esteja momentaneamente fora do
// ar (serve o último HTML bom conhecido).
const componentCache = new Map(); // name -> { html, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

app.get('/api/metadax/component/:name', async (req, res) => {
  const name = String(req.params.name || '').toLowerCase();

  if (!ALLOWED_COMPONENTS.has(name)) {
    return res.status(404).json({ error: 'Componente desconhecido.' });
  }

  const cached = componentCache.get(name);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Metadax-Proxy-Cache', 'hit');
    return res.send(cached.html);
  }

  try {
    const upstream = await fetch(`${METADAX_CDN_BASE}/components/html/${name}.html`, {
      headers: { 'Accept': 'text/html' }
    });

    if (!upstream.ok) {
      throw new Error(`CDN respondeu ${upstream.status}`);
    }

    const html = await upstream.text();
    componentCache.set(name, { html, fetchedAt: Date.now() });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=60');
    res.set('X-Metadax-Proxy-Cache', 'miss');
    res.send(html);

  } catch (err) {
    console.error(`[CDN Proxy Error] ${name}:`, err.message);

    // Se existir uma cópia em cache (mesmo expirada), ainda vale mais do
    // que quebrar a página — devolve ela como fallback.
    if (cached) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('X-Metadax-Proxy-Cache', 'stale-fallback');
      return res.send(cached.html);
    }

    // Sem nada em cache: devolve HTML vazio (200) em vez de erro. O
    // component-loader.js só faz insertAdjacentHTML com o resultado — uma
    // string vazia é inofensiva, enquanto um 5xx apareceria como erro no
    // console outra vez.
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Metadax-Proxy-Cache', 'error-empty');
    res.status(200).send('');
  }
});

// ─── Health check ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status:  'ok',
    service: 'Na Brasa (METADAX)',
    version: require('./package.json').version,
    uptime:  Math.floor(process.uptime()),
    ts:      new Date().toISOString()
  });
});

// ─── SPA fallback ────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ─── Handler global de erros ─────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err.message);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ─── Start (execução local / servidor persistente) ───────────
// Em Vercel (serverless), este `app.listen` não é usado para atender
// requisições — a plataforma importa `module.exports` e invoca o app
// diretamente a cada request. Mantido aqui para permitir `node server.js`
// localmente sem nenhuma configuração extra.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║        Na Brasa — Calculadora de Churrasco            ║
║        Porta: ${String(PORT).padEnd(6)}                                ║
║        Ambiente: ${(process.env.NODE_ENV || 'development').padEnd(12)}                  ║
║        CDN METADAX: ${METADAX_CDN_BASE.padEnd(30)} ║
╚══════════════════════════════════════════════════════╝
    `);
  });
}

module.exports = app;
