// Servidor de Comisiones RRPP (Cloudflare Worker + D1)
//   /lector?url=…        lee un evento público de Bombo (lo usa la app)
//   /api/…               cuentas con Google, nombre público y lista de eventos de cada RRPP
//   /<nombre-del-rrpp>   página pública con los próximos eventos de ese RRPP, para sus clientes
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const RESERVADOS = new Set(["api", "lector", "favicon.ico", "robots.txt", "admin", "www", "app", "login"]);
const VIEJO_MS = 15 * 60 * 1000;          // public page refreshes prices older than this
const SESION_MS = 180 * 24 * 3600 * 1000; // app sessions last 6 months
const MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const DIAS = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];

// ---------- helpers ----------
function corsHeaders(env, extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": env.APP_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  }, extra || {});
}
function json(env, body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: corsHeaders(env, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }) });
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function esBombo(u) { return /(^|\.)wearebombo\.com$/.test(u.hostname) || u.hostname === "wearebombo.app.link"; }
function linkBombo(t) { try { const u = new URL(t); return (u.protocol === "https:" || u.protocol === "http:") && esBombo(u); } catch (e) { return false; } }
function imagenBombo(t) { try { const u = new URL(t); return u.protocol === "https:" && (u.hostname === "files.wearebombo.com" || u.hostname === "storage.googleapis.com"); } catch (e) { return false; } }
function slugDe(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
}
function hoyAR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
async function sha256(t) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function tokenNuevo() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Bombo reader ----------
async function traer(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" }, redirect: "follow" });
  return { status: r.status, url: r.url, html: await r.text() };
}
function leerEvento(html) {
  for (const b of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(b[1]); } catch (e) { continue; }
    for (const ev of (Array.isArray(j) ? j : [j])) {
      if (!ev || !/Event$/.test(String(ev["@type"] || ""))) continue;
      const imagen = Array.isArray(ev.image) ? ev.image[0] : ev.image;
      return {
        nombre: ev.name || "",
        inicio: ev.startDate || "",
        flyer: typeof imagen === "string" ? imagen : (imagen && imagen.url) || "",
        lugar: (ev.location && (ev.location.name || (ev.location.address && ev.location.address.streetAddress))) || "",
        ofertas: (Array.isArray(ev.offers) ? ev.offers : ev.offers ? [ev.offers] : []).map(o => ({
          nombre: o.name || "", precio: Number(o.price) || 0,
          disponible: !/SoldOut|OutOfStock|Discontinued/i.test(String(o.availability || ""))
        }))
      };
    }
  }
  return null;
}
async function leerLink(link) {
  let pagina = await traer(link);
  if (new URL(link).hostname === "wearebombo.app.link") {
    const m = pagina.html.match(/https:\/\/wearebombo\.com\/event[o]?\/[A-Za-z0-9-]+/);
    if (!m) throw { code: "evento" };
    pagina = await traer(m[0]);
  }
  if (pagina.status >= 400) throw { code: "bombo" };
  const ev = leerEvento(pagina.html);
  if (!ev) throw { code: "evento" };
  return Object.assign({ url: pagina.url.split("?")[0] }, ev);
}
// Current price = cheapest ticket on sale; if all sold out, the last tier marked agotado (same rule as the app)
function elegirPrecios(ofertas) {
  function actual(lista) {
    if (!lista.length) return null;
    const disp = lista.filter(o => o.disponible);
    const o = disp.length ? disp.reduce((a, b) => (b.precio < a.precio ? b : a)) : lista.reduce((a, b) => (b.precio > a.precio ? b : a));
    return { nombre: o.nombre, precio: o.precio, agotado: !disp.length };
  }
  return { general: actual(ofertas.filter(o => !/vip/i.test(o.nombre))), vip: actual(ofertas.filter(o => /vip/i.test(o.nombre))) };
}

// ---------- Google sign-in ----------
let jwks = null, jwksHora = 0;
async function clavesGoogle() {
  if (jwks && Date.now() - jwksHora < 3600 * 1000) return jwks;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  jwks = (await r.json()).keys; jwksHora = Date.now();
  return jwks;
}
function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function verificarGoogle(credencial, clientId) {
  const partes = String(credencial || "").split(".");
  if (partes.length !== 3 || !clientId) throw { code: "google" };
  const cab = JSON.parse(new TextDecoder().decode(b64url(partes[0])));
  const datos = JSON.parse(new TextDecoder().decode(b64url(partes[1])));
  const jwk = (await clavesGoogle()).find(k => k.kid === cab.kid);
  if (!jwk) throw { code: "google" };
  const clave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", clave, b64url(partes[2]), new TextEncoder().encode(partes[0] + "." + partes[1]));
  if (!ok || datos.aud !== clientId || !["accounts.google.com", "https://accounts.google.com"].includes(datos.iss) ||
      datos.exp * 1000 < Date.now() || !datos.email_verified) throw { code: "google" };
  return datos;
}
async function usuarioDe(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  return env.DB.prepare("SELECT u.sub, u.email, u.nombre, u.slug FROM sessions s JOIN users u ON u.sub = s.sub WHERE s.token_hash = ? AND s.expira > ?")
    .bind(await sha256(m[1]), Date.now()).first();
}
function usuarioPublico(u) { return { email: u.email, nombre: u.nombre || "", slug: u.slug || "" }; }

// ---------- event lists ----------
function precioLimpio(p) {
  if (!p || typeof p !== "object") return null;
  return { nombre: String(p.nombre || "").slice(0, 100), precio: Math.max(0, Number(p.precio) || 0), agotado: !!p.agotado };
}
function limpiarEventos(lista) {
  if (!Array.isArray(lista)) return null;
  return lista.slice(0, 150).map(c => ({
    id: String(c.id || "").slice(0, 40),
    link: linkBombo(c.link) ? String(c.link).slice(0, 600) : "",
    url: linkBombo(c.url) ? String(c.url).slice(0, 600) : "",
    nombre: String(c.nombre || "").slice(0, 200),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || "") ? c.fecha : "",
    hora: /^\d{2}:\d{2}$/.test(c.hora || "") ? c.hora : "",
    flyer: imagenBombo(c.flyer) ? String(c.flyer).slice(0, 600) : "",
    lugar: String(c.lugar || "").slice(0, 200),
    productoraId: c.productoraId ? String(c.productoraId).slice(0, 40) : null,
    general: precioLimpio(c.general),
    vip: precioLimpio(c.vip),
    actualizado: String(c.actualizado || "").slice(0, 40)
  })).filter(c => c.id && c.nombre);
}
async function leerLista(env, sub) {
  const fila = await env.DB.prepare("SELECT data FROM eventos WHERE sub = ?").bind(sub).first();
  if (!fila) return [];
  try { return JSON.parse(fila.data); } catch (e) { return []; }
}
async function guardarLista(env, sub, lista) {
  await env.DB.prepare("INSERT INTO eventos (sub, data, actualizado) VALUES (?, ?, ?) ON CONFLICT(sub) DO UPDATE SET data = excluded.data, actualizado = excluded.actualizado")
    .bind(sub, JSON.stringify(lista), new Date().toISOString()).run();
}
// Refresh stale prices of upcoming events (runs after the public page is served)
async function refrescar(env, sub) {
  const lista = await leerLista(env, sub);
  const hoy = hoyAR();
  const viejos = lista.filter(c => c.link && (!c.fecha || c.fecha >= hoy) && (!c.actualizado || Date.now() - Date.parse(c.actualizado) > VIEJO_MS)).slice(0, 20);
  if (!viejos.length) return;
  await Promise.all(viejos.map(async c => {
    try {
      const ev = await leerLink(c.link);
      const precios = elegirPrecios(ev.ofertas);
      c.general = precios.general; c.vip = precios.vip;
      if (imagenBombo(ev.flyer)) c.flyer = ev.flyer;
      if (ev.inicio) { c.fecha = ev.inicio.slice(0, 10); c.hora = ev.inicio.slice(11, 16); }
      c.actualizado = new Date().toISOString();
    } catch (e) { /* keep last known prices */ }
  }));
  // re-read so a save made by the app in the meantime is not lost; only prices/dates are merged in
  const actual = await leerLista(env, sub);
  const porId = new Map(viejos.map(c => [c.id, c]));
  await guardarLista(env, sub, actual.map(c => {
    const n = porId.get(c.id);
    return n && n.link === c.link ? Object.assign(c, { general: n.general, vip: n.vip, flyer: n.flyer, fecha: n.fecha, hora: n.hora, actualizado: n.actualizado }) : c;
  }));
}

// ---------- public page ----------
const money = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
function fechaLarga(fecha, hora) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha || "");
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return DIAS[d.getUTCDay()] + " " + (+m[3]) + " " + MESES[+m[2] - 1] + (hora ? " · " + hora : "");
}
function filaPrecio(tipo, p) {
  if (!p) return "";
  return '<div class="precio' + (p.agotado ? " agotado" : "") + '"><span>' + tipo + (p.nombre ? " <small>" + esc(p.nombre) + "</small>" : "") +
    "</span><b>" + (p.agotado ? "Agotado" : esc(money.format(p.precio))) + "</b></div>";
}
function paginaHTML(lista, slug) {
  const primero = lista.find(c => c.flyer);
  const tarjetas = lista.map(c => {
    const agotado = (!c.general || c.general.agotado) && (!c.vip || c.vip.agotado) && (c.general || c.vip);
    return '<article class="ev">' +
      (c.flyer ? '<img src="' + esc(c.flyer) + '" alt="Flyer de ' + esc(c.nombre) + '" loading="lazy">' : "") +
      '<div class="info"><div class="fecha">' + esc(fechaLarga(c.fecha, c.hora)) + "</div><h2>" + esc(c.nombre) + "</h2>" +
      '<div class="precios">' + filaPrecio("General", c.general) + filaPrecio("VIP", c.vip) + "</div>" +
      (c.link ? '<a class="comprar' + (agotado ? " off" : "") + '" href="' + esc(c.link) + '" rel="noopener">' + (agotado ? "Ver evento" : "Comprar entradas") + "</a>" : "") +
      "</div></article>";
  }).join("");
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Próximos eventos</title>
<meta name="description" content="${esc(lista.map(c => c.nombre).slice(0, 5).join(" · ") || "Entradas para los próximos eventos")}">
<meta property="og:title" content="Próximos eventos">
<meta property="og:description" content="${esc(lista.map(c => c.nombre).slice(0, 5).join(" · ") || "Entradas para los próximos eventos")}">
${primero ? `<meta property="og:image" content="${esc(primero.flyer)}">` : ""}
<meta name="theme-color" content="#100e15">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Big+Shoulders+Display:wght@800&display=swap">
<style>
:root { --bg:#100e15; --surface:#1b1823; --line:#363042; --fg:#f3f0f7; --muted:#a7a0b4; --accent:#39ff7f; --ink:#04210f; --danger:#ff6b6b; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: Archivo, system-ui, -apple-system, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: calc(20px + env(safe-area-inset-top, 0px)) 16px calc(32px + env(safe-area-inset-bottom, 0px)); display: flex; flex-direction: column; gap: 18px; }
h1 { margin: 0; font-family: "Big Shoulders Display", "Arial Narrow", sans-serif; font-weight: 800; font-size: 34px; text-transform: uppercase; letter-spacing: .02em; line-height: 1; }
h1 span { color: var(--accent); }
.ev { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; }
.ev img { display: block; width: 100%; height: auto; background: #26222f; }
.info { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 6px; }
.fecha { color: var(--accent); font-size: 13px; font-weight: 700; letter-spacing: .08em; }
h2 { margin: 0; font-size: 19px; line-height: 1.25; overflow-wrap: anywhere; }
.precios { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.precio { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; border-top: 1px dashed var(--line); padding-top: 7px; font-size: 15px; }
.precio span { font-weight: 600; } .precio small { color: var(--muted); font-weight: 500; font-size: 12px; margin-left: 4px; }
.precio b { font-variant-numeric: tabular-nums; white-space: nowrap; } .precio.agotado b { color: var(--danger); }
.comprar { margin-top: 10px; display: block; text-align: center; text-decoration: none; background: var(--accent); color: var(--ink); font-weight: 700; font-size: 16px; padding: 14px; border-radius: 12px; }
.comprar.off { background: transparent; color: var(--fg); border: 1px solid var(--line); }
.vacio { color: var(--muted); text-align: center; padding: 40px 16px; border: 1px dashed var(--line); border-radius: 16px; }
</style></head>
<body><main>
<h1>Próximos <span>eventos</span></h1>
${tarjetas || '<div class="vacio">No hay eventos publicados por ahora.</div>'}
</main></body></html>`;
}
function pagina404() {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No encontrado</title>' +
    '<body style="margin:0;background:#100e15;color:#f3f0f7;font-family:system-ui;display:grid;place-items:center;min-height:100vh;text-align:center;padding:16px">' +
    "<div><h1 style=\"margin:0 0 8px\">Página no encontrada</h1><p style=\"color:#a7a0b4\">Revisá que el link esté bien escrito.</p></div></body>",
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const ruta = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    try {
      if (ruta === "/lector" && req.method === "GET") {
        const link = url.searchParams.get("url") || "";
        if (!linkBombo(link)) return json(env, { ok: false, error: "link" }, 400);
        try { return json(env, Object.assign({ ok: true }, await leerLink(link))); }
        catch (e) { return json(env, { ok: false, error: (e && e.code) || "red" }, 502); }
      }

      if (ruta === "/api/login" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        let g;
        try { g = await verificarGoogle(cuerpo.credential, env.GOOGLE_CLIENT_ID); }
        catch (e) { return json(env, { ok: false, error: "google" }, 401); }
        await env.DB.prepare("INSERT INTO users (sub, email, nombre, creado) VALUES (?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email")
          .bind(g.sub, g.email, null, new Date().toISOString()).run();
        const token = tokenNuevo();
        await env.DB.prepare("INSERT INTO sessions (token_hash, sub, expira) VALUES (?, ?, ?)").bind(await sha256(token), g.sub, Date.now() + SESION_MS).run();
        const u = await env.DB.prepare("SELECT sub, email, nombre, slug FROM users WHERE sub = ?").bind(g.sub).first();
        return json(env, { ok: true, token, usuario: usuarioPublico(u), sugerido: slugDe(g.name || g.email.split("@")[0]) });
      }

      if (ruta.startsWith("/api/")) {
        const u = await usuarioDe(req, env);
        if (!u) return json(env, { ok: false, error: "sesion" }, 401);

        if (ruta === "/api/yo" && req.method === "GET") {
          return json(env, { ok: true, usuario: usuarioPublico(u), eventos: await leerLista(env, u.sub) });
        }
        if (ruta === "/api/perfil" && req.method === "PUT") {
          const cuerpo = await req.json().catch(() => ({}));
          const slug = slugDe(cuerpo.slug || cuerpo.nombre);
          const nombre = String(cuerpo.nombre || "").trim().slice(0, 60);
          if (slug.length < 3) return json(env, { ok: false, error: "slug-corto" }, 400);
          if (RESERVADOS.has(slug)) return json(env, { ok: false, error: "slug-ocupado" }, 409);
          const otro = await env.DB.prepare("SELECT sub FROM users WHERE slug = ? AND sub != ?").bind(slug, u.sub).first();
          if (otro) return json(env, { ok: false, error: "slug-ocupado" }, 409);
          await env.DB.prepare("UPDATE users SET nombre = ?, slug = ? WHERE sub = ?").bind(nombre || null, slug, u.sub).run();
          return json(env, { ok: true, usuario: { email: u.email, nombre, slug } });
        }
        if (ruta === "/api/eventos" && req.method === "PUT") {
          const cuerpo = await req.json().catch(() => ({}));
          const lista = limpiarEventos(cuerpo.eventos);
          if (!lista) return json(env, { ok: false, error: "datos" }, 400);
          await guardarLista(env, u.sub, lista);
          return json(env, { ok: true, cantidad: lista.length });
        }
        if (ruta === "/api/logout" && req.method === "POST") {
          const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
          if (m) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(m[1])).run();
          return json(env, { ok: true });
        }
        return json(env, { ok: false, error: "ruta" }, 404);
      }

      const m = ruta.match(/^\/([a-z0-9-]{3,30})\/?$/);
      if (m && req.method === "GET" && !RESERVADOS.has(m[1])) {
        const u = await env.DB.prepare("SELECT sub FROM users WHERE slug = ?").bind(m[1]).first();
        if (!u) return pagina404();
        const hoy = hoyAR();
        const lista = (await leerLista(env, u.sub))
          .filter(c => !c.fecha || c.fecha >= hoy)
          .sort((a, b) => (a.fecha || "9999").localeCompare(b.fecha || "9999"));
        if (lista.some(c => c.link && (!c.actualizado || Date.now() - Date.parse(c.actualizado) > VIEJO_MS))) ctx.waitUntil(refrescar(env, u.sub));
        return new Response(paginaHTML(lista, m[1]), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (ruta === "/robots.txt") return new Response("User-agent: *\nDisallow: /api/\n", { headers: { "Content-Type": "text/plain" } });
      return pagina404();
    } catch (e) {
      return json(env, { ok: false, error: "servidor" }, 500);
    }
  }
};
