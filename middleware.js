// middleware.js
// Vercel Edge Middleware — CORS dinâmico para o CDN da METADAX
// (https://cdn.metadax.com.br)
//
// CONTEXTO DO BUG:
// O header "Access-Control-Allow-Origin" estava vindo com o valor literal
//   http.request.headers["origin"][0]
// Isso é sintaxe de expressão dinâmica do Cloudflare Rules Engine — mas o
// domínio é servido pela Vercel (ver headers x-vercel-id / x-vercel-cache
// na resposta), e o `vercel.json` só aceita valores ESTÁTICOS em `headers`.
// Ou seja: alguém colou uma expressão pensada para o Cloudflare num campo
// que a Vercel nunca avalia — o resultado é essa string sendo devolvida ao
// pé da letra, o que o navegador corretamente rejeita como Origin inválida.
//
// A correção é mover essa lógica para um Edge Middleware, que roda por
// requisição e pode ler o header Origin de verdade e decidir o que
// devolver — com um allowlist, em vez de refletir qualquer Origin (o que
// seria inseguro).

import { NextResponse } from 'next/server';

// Domínios (e subdomínios) autorizados a consumir os componentes deste CDN.
// Adicione aqui qualquer novo site/produto METADAX que precise buscar
// header.html, footer.html, back-to-top.html, privacy-banner.html,
// new-info.html, scripts, css etc.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)?metadax\.com\.br$/i,
  /^https:\/\/([a-z0-9-]+\.)?metadax\.co$/i,
  /^https:\/\/([a-z0-9-]+\.)?metadax\.cloud$/i,
  // Preview deployments da própria Vercel, úteis em desenvolvimento/QA
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
  // Ambiente local de desenvolvimento
  /^https?:\/\/localhost(:\d+)?$/i,
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

// Só precisamos aplicar CORS nas rotas que outros domínios de fato buscam
// via fetch()/XHR: os componentes HTML, CSS e scripts públicos do CDN.
// Ajuste os prefixos conforme a estrutura real de pastas do projeto.
const CORS_PATH_PREFIXES = ['/components/', '/assets/', '/favicon.ico'];

function shouldApplyCors(pathname) {
  return CORS_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(request) {
  const { pathname } = request.nextUrl;

  if (!shouldApplyCors(pathname)) {
    return NextResponse.next();
  }

  const origin = request.headers.get('origin');
  const allowed = isAllowedOrigin(origin);
  const isPreflight = request.method === 'OPTIONS';

  // Requisição de preflight (o navegador manda antes de métodos/headers
  // "não simples"). Nossos fetch()s hoje são GET simples, mas manter o
  // suporte a OPTIONS evita quebrar se algum consumidor futuro mandar
  // headers custom.
  if (isPreflight) {
    const preflightHeaders = new Headers({
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
    if (allowed) {
      preflightHeaders.set('Access-Control-Allow-Origin', origin);
    }
    return new NextResponse(null, {
      status: allowed ? 204 : 403,
      headers: preflightHeaders,
    });
  }

  const response = NextResponse.next();

  // NUNCA um valor estático nem string de expressão — sempre o Origin real
  // da requisição atual, só quando ele está na allowlist.
  if (allowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Vary', 'Origin');

  return response;
}

export const config = {
  matcher: ['/components/:path*', '/assets/:path*', '/favicon.ico'],
};
