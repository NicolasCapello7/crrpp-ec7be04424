// Servidor de BPM Tickets (Cloudflare Worker + D1), en bpmtickets.com.ar
//   /                         la app de los RRPP (se sirve desde GitHub Pages)
//   /lector?url=…             lee un evento público de Bombo, Venti, Planout, Passline o Talk (lo usa la app)
//   /api/…                    cuentas (Google o mail y contraseña), nombre público y lista de eventos de cada RRPP
//   /eventos/<nombre>[?id=…]  página pública con los próximos eventos de ese RRPP, para sus clientes
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
// Shown when the link is shared (WhatsApp, Instagram…): the app logo, not an event flyer
const LOGO_URL = "https://bpmtickets.com.ar/og.png";
// App files served from GitHub Pages at the root of the site
const ARCHIVOS_APP = new Set(["/index.html", "/sw.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/og.png", "/privacidad.html"]);
const CODIGO_MS = 15 * 60 * 1000;         // mailed codes last 15 minutes
const HORA_MS = 3600 * 1000;
const RESERVADOS = new Set(["api", "lector", "favicon.ico", "robots.txt", "admin", "www", "app", "login", "eventos", "privacidad", "registro", "entrar"]);
const VIEJO_MS = 15 * 60 * 1000;          // public page refreshes prices older than this
const SESION_MS = 180 * 24 * 3600 * 1000; // app sessions last 6 months
const MESES_LARGO = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const DIAS = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];

// ---------- helpers ----------
const SEGURIDAD = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};
const MAX_CUERPO = 512 * 1024; // requests larger than this are rejected
function origenesApp(env) { return String(env.ORIGENES || env.APP_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean); }
function corsHeaders(env, extra) {
  return Object.assign({}, SEGURIDAD, {
    "Access-Control-Allow-Origin": env.ORIGEN || origenesApp(env)[0] || "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

// ---------- passwords, mailed codes and rate limits ----------
const ITERACIONES = 100000; // PBKDF2-SHA256 (the most Workers allow)
function aB64(u8) { let s = ""; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); }
function deB64(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function pbkdf2(clave, sal, iteraciones) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, k, 256));
}
async function crearClave(clave) {
  const sal = new Uint8Array(16); crypto.getRandomValues(sal);
  return "pbkdf2$" + ITERACIONES + "$" + aB64(sal) + "$" + aB64(await pbkdf2(clave, sal, ITERACIONES));
}
function igualesSeguro(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function claveCorrecta(clave, guardada) {
  const p = String(guardada || "").split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") { await pbkdf2(clave, new Uint8Array(16), ITERACIONES); return false; } // same time with or without account
  return igualesSeguro(await pbkdf2(clave, deB64(p[2]), Number(p[1])), deB64(p[3]));
}
function emailLimpio(t) {
  const e = String(t || "").trim().toLowerCase();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
}
function claveValida(t) { return typeof t === "string" && t.length >= 8 && t.length <= 128; }
// Fixed-window counter; returns how many times this key was used in the window (including this one)
async function sumarLimite(env, clave, ventana) {
  const ahora = Date.now();
  const f = await env.DB.prepare("INSERT INTO limites (clave, cuenta, desde) VALUES (?1, 1, ?2) ON CONFLICT(clave) DO UPDATE SET " +
    "cuenta = CASE WHEN ?2 - desde > ?3 THEN 1 ELSE cuenta + 1 END, desde = CASE WHEN ?2 - desde > ?3 THEN ?2 ELSE desde END RETURNING cuenta")
    .bind(clave, ahora, ventana).first();
  return f ? f.cuenta : 1;
}
async function leerLimite(env, clave, ventana) {
  const f = await env.DB.prepare("SELECT cuenta, desde FROM limites WHERE clave = ?").bind(clave).first();
  return f && Date.now() - f.desde <= ventana ? f.cuenta : 0;
}
// Mail sending allowed? 5 per address and 20 per connection each hour
async function puedeMandarMail(env, email, ip) {
  const a = await sumarLimite(env, "mail:" + email, HORA_MS);
  const b = await sumarLimite(env, "mail-ip:" + ip, HORA_MS);
  return a <= 5 && b <= 20;
}
function codigoNuevo() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, "0"); }
async function hashCodigo(email, tipo, codigo) { return sha256(email + "|" + tipo + "|" + codigo); }
async function guardarCodigo(env, email, tipo, datos) {
  const codigo = codigoNuevo();
  await env.DB.prepare("INSERT INTO codigos (email, tipo, hash, datos, expira, intentos, enviado) VALUES (?, ?, ?, ?, ?, 0, ?) " +
    "ON CONFLICT(email, tipo) DO UPDATE SET hash = excluded.hash, datos = excluded.datos, expira = excluded.expira, intentos = 0, enviado = excluded.enviado")
    .bind(email, tipo, await hashCodigo(email, tipo, codigo), datos ? JSON.stringify(datos) : null, Date.now() + CODIGO_MS, Date.now()).run();
  return codigo;
}
// Checks a mailed code; on success it is used up and its stored data returned
async function usarCodigo(env, email, tipo, codigo) {
  const f = await env.DB.prepare("SELECT hash, datos, expira, intentos FROM codigos WHERE email = ? AND tipo = ?").bind(email, tipo).first();
  if (!f || f.expira < Date.now()) throw { code: "codigo-vencido" };
  if (f.intentos >= 5) throw { code: "codigo-intentos" };
  if (!/^\d{6}$/.test(String(codigo || "")) || await hashCodigo(email, tipo, String(codigo)) !== f.hash) {
    await env.DB.prepare("UPDATE codigos SET intentos = intentos + 1 WHERE email = ? AND tipo = ?").bind(email, tipo).run();
    throw { code: f.intentos + 1 >= 5 ? "codigo-intentos" : "codigo" };
  }
  await env.DB.prepare("DELETE FROM codigos WHERE email = ? AND tipo = ?").bind(email, tipo).run();
  try { return f.datos ? JSON.parse(f.datos) : {}; } catch (e) { return {}; }
}
// Mails go out through Resend (key saved as the RESEND_API_KEY secret)
async function mandarCodigo(env, email, tipo, codigo) {
  if (!env.RESEND_API_KEY) throw { code: "mail-config" };
  const motivo = tipo === "registro" ? "Para terminar de crear tu cuenta, ingresá este código en la app:" : "Para elegir una contraseña nueva, ingresá este código en la app:";
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#17141d">' +
    '<p style="font-size:20px;font-weight:700;margin:0 0 16px">BPM <span style="color:#00b84f">TICKETS</span></p>' +
    '<p style="font-size:15px;line-height:1.5;margin:0 0 16px">' + motivo + "</p>" +
    '<p style="font-size:34px;font-weight:700;letter-spacing:8px;background:#ece9f1;border-radius:12px;padding:16px;text-align:center;margin:0 0 16px">' + codigo + "</p>" +
    '<p style="font-size:13px;color:#696374;line-height:1.5;margin:0">Vence en 15 minutos. Si no fuiste vos, ignorá este mail: nadie puede entrar a tu cuenta sin este código.</p></div>';
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_DESDE || "BPM Tickets <no-responder@bpmtickets.com.ar>",
      to: [email],
      subject: codigo + " es tu código de BPM Tickets",
      html,
      text: motivo + "\n\n" + codigo + "\n\nVence en 15 minutos. Si no fuiste vos, ignorá este mail."
    })
  });
  if (!r.ok) throw { code: "mail" };
}

// ---------- event readers: Bombo, Venti, Planout, Passline ----------
// Each reader returns { url, nombre, inicio (ISO with -03:00), flyer, lugar, ofertas: [{ nombre, precio, disponible, vip }] }
async function traer(url, opciones) {
  const r = await fetch(url, Object.assign({ headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" }, redirect: "follow" }, opciones || {}));
  return { status: r.status, url: r.url, html: await r.text() };
}
function entidades(t) {
  const mapa = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", mdash: "—", ndash: "–", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü" };
  return String(t || "")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in mapa ? mapa[n] : m));
}
function textoPlano(html) { return entidades(String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").trim(); }
function meta(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"', "i")) ||
            html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + prop + '"', "i"));
  return m ? entidades(m[1]).trim() : "";
}
// "2026-11-21T19:00:00.000Z" -> "2026-11-21T16:00:00-03:00" (Argentina)
function aHoraAR(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19) + "-03:00";
}
function plataformaDe(t) {
  let u;
  try { u = new URL(t); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.replace(/^www\./, "");
  if (/(^|\.)wearebombo\.com$/.test(h) || h === "wearebombo.app.link") return "bombo";
  if (h === "venti.live" || h === "venti.com.ar") return "venti";
  if (h === "planout.ar" || h === "planout.com.ar") return "planout";
  if (h === "passline.com" || h === "home.passline.com" || h === "passline.com.ar") return "passline";
  if (h === "talk-tickets.com") return "talk";
  return null;
}
function linkPermitido(t) { return !!plataformaDe(t); }
const HOSTS_IMAGEN = ["files.wearebombo.com", "storage.googleapis.com", "images.venti.live", "d26en73i7b5aju.cloudfront.net", "www.passline.com", "passline.com", "cdn.getcrowder.com"];
function imagenPermitida(t) { try { const u = new URL(t); return u.protocol === "https:" && HOSTS_IMAGEN.includes(u.hostname); } catch (e) { return false; } }

function leerEventoLD(html) {
  for (const b of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(b[1]); } catch (e) { continue; }
    for (const ev of (Array.isArray(j) ? j : [j])) {
      if (!ev || !/Event$/.test(String(ev["@type"] || ""))) continue;
      const imagen = Array.isArray(ev.image) ? ev.image[0] : ev.image;
      return {
        nombre: entidades(ev.name || ""),
        inicio: ev.startDate || "",
        flyer: typeof imagen === "string" ? imagen : (imagen && imagen.url) || "",
        lugar: entidades((ev.location && (ev.location.name || (ev.location.address && ev.location.address.streetAddress))) || ""),
        ofertas: (Array.isArray(ev.offers) ? ev.offers : ev.offers ? [ev.offers] : []).map(o => ({
          nombre: o.name || "", precio: Number(o.price) || 0,
          disponible: !/SoldOut|OutOfStock|Discontinued/i.test(String(o.availability || ""))
        }))
      };
    }
  }
  return null;
}

async function leerBombo(link) {
  let pagina = await traer(link);
  if (new URL(link).hostname === "wearebombo.app.link") {
    const m = pagina.html.match(/https:\/\/wearebombo\.com\/event[o]?\/[A-Za-z0-9-]+/);
    if (!m) throw { code: "evento" };
    pagina = await traer(m[0]);
  }
  if (pagina.status >= 400) throw { code: "plataforma" };
  const ev = leerEventoLD(pagina.html);
  if (!ev) throw { code: "evento" };
  return Object.assign({ url: pagina.url.split("?")[0] }, ev);
}

async function leerVenti(link) {
  const m = new URL(link).pathname.match(/\/evento\/([^/?#]+)/);
  if (!m) throw { code: "evento" };
  const r = await fetch("https://api.venti.live/api/event/urlName/" + encodeURIComponent(decodeURIComponent(m[1])), { headers: { "User-Agent": UA, "Origin": "https://venti.live", "Accept": "application/json" } });
  if (r.status >= 400) throw { code: r.status === 404 ? "evento" : "plataforma" };
  const ev = ((await r.json().catch(() => ({}))) || {}).event;
  if (!ev || !ev.name) throw { code: "evento" };
  return {
    url: "https://venti.live/evento/" + ev.urlName,
    nombre: ev.name,
    inicio: aHoraAR(ev.startDate),
    flyer: ev.bannerImg || ev.promoImg || "",
    lugar: ev.placeName || "",
    ofertas: (ev.TicketTypes || []).filter(t => t.visibilityMode !== "hidden").map(t => {
      const seccion = (t.ticketTypeSection || []).map(x => x.name).join(" ");
      return { nombre: String(t.name || "").replace(/^AGOTADO\s*-\s*/i, ""), precio: (Number(t.priceInCents) || 0) / 100, disponible: !!t.canBeSelled, vip: /vip/i.test(t.name + " " + seccion) };
    })
  };
}

// Planout: the event page links to comprarEvento?idEvento=N; that page has the session and channel ids,
// and a DWR call returns every ticket tier per zone (GENERAL / VIP) with its price and remaining stock.
async function leerPlanout(link) {
  const u = new URL(link);
  let idEvento = u.searchParams.get("idEvento");
  let nombre = "", flyer = "";
  if (!idEvento || !/comprarEvento/i.test(u.pathname)) {
    const p = await traer(link);
    if (p.status >= 400) throw { code: "plataforma" };
    nombre = meta(p.html, "og:title"); flyer = meta(p.html, "og:image");
    const m = p.html.match(/comprarEvento\?idEvento=(\d+)/);
    if (m) idEvento = m[1];
  }
  if (!idEvento) throw { code: "evento" };
  const compra = await traer("https://planout.ar/eventos/es/comprarEvento?idEvento=" + idEvento);
  if (compra.status >= 400) throw { code: "plataforma" };
  if (!nombre) nombre = meta(compra.html, "og:title") || textoPlano((compra.html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
  if (!flyer) flyer = meta(compra.html, "og:image");
  // the purchase page gives the poster as a relative path of Planout's image CDN
  if (flyer && !/^https?:/i.test(flyer)) flyer = "https://d26en73i7b5aju.cloudfront.net/eventos/" + flyer.replace(/^\/+/, "");
  const canal = (compra.html.match(/idCanal\s*=\s*'?(\d+)/) || [])[1];
  const sesiones = [...new Set([...compra.html.matchAll(/"idSesion":(\d+)/g)].map(x => x[1]))];
  const fecha = (compra.html.match(/"fechaCelebracionStr":"([\d-]+T[\d:]+)"/) || [])[1];
  // og:title is "Event name - Venue"
  const partes = nombre.split(" - ");
  const lugar = partes.length > 1 ? partes.pop().trim() : "";
  nombre = partes.join(" - ").trim();
  let ofertas = [];
  if (canal && sesiones.length) {
    const cuerpo = ["callCount=1", "nextReverseAjaxIndex=0", "c0-scriptName=CompraAjax", "c0-methodName=getAllProductosSesion", "c0-id=0"]
      .concat(sesiones.map((s, i) => "c0-e" + (i + 1) + "=number:" + s))
      .concat(["c0-param0=array:[" + sesiones.map((s, i) => "reference:c0-e" + (i + 1)).join(",") + "]", "c0-param1=number:" + canal,
        "batchId=0", "instanceId=0", "page=" + encodeURIComponent("/eventos/es/comprarEvento?idEvento=" + idEvento), "scriptSessionId="]).join("\n");
    const r = await fetch("https://planout.ar/eventos/dwr/call/plaincall/CompraAjax.getAllProductosSesion.dwr", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "text/plain" }, body: cuerpo });
    const txt = await r.text();
    const objetos = {};
    for (const a of txt.matchAll(/\b(s\d+)\.(\w+)=("(?:[^"\\]|\\.)*"|[^;]*);/g)) {
      (objetos[a[1]] = objetos[a[1]] || {})[a[2]] = a[3].startsWith('"') ? JSON.parse(a[3]) : a[3];
    }
    ofertas = Object.values(objetos).filter(o => o.litProducto && o.precio != null && o.esEntrada !== "false" && !(Number(o.minEntradasVenta) > 1))
      .map(o => ({ nombre: entidades(o.litProducto), precio: Number(o.precio) || 0, disponible: Number(o.maxCantidadSesion) > 0, vip: /vip/i.test(o.litProducto + " " + (o.litZona || "")) }));
  }
  return {
    url: "https://planout.ar/eventos/es/comprarEvento?idEvento=" + idEvento,
    nombre, inicio: fecha ? fecha.slice(0, 16) + ":00-03:00" : "", flyer, lugar, ofertas
  };
}

// Passline: schema.org Event plus the ticket table (#tabla_tickets_sin_codigo). Busy events sit behind a virtual queue.
async function leerPassline(link) {
  const r = await fetch(link, { headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" }, redirect: "manual" });
  const destino = r.headers.get("location") || "";
  if (r.status >= 300 && r.status < 400) {
    if (/queue-it/i.test(destino)) throw { code: "fila" };
    return leerPassline(new URL(destino, link).toString());
  }
  if (r.status === 403 || r.headers.get("cf-mitigated")) throw { code: "protegido" };
  if (r.status >= 400) throw { code: "plataforma" };
  const html = await r.text();
  const ev = leerEventoLD(html) || { nombre: meta(html, "og:title").replace(/^Passline\s*-\s*/i, ""), inicio: "", flyer: meta(html, "og:image"), lugar: "", ofertas: [] };
  const tabla = (html.match(/<table id="tabla_tickets_sin_codigo">([\s\S]*?)<\/table>/) || [])[1] || "";
  const ofertas = [];
  for (const fila of tabla.matchAll(/<tr[^>]*id="td_tck_\d+"[^>]*>([\s\S]*?)<\/tr/g)) {
    const celdas = [...fila[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
    if (celdas.length < 2) continue;
    const nombre = textoPlano(celdas[0]).split("\n")[0].trim();
    const precio = Number(((textoPlano(celdas[1]).match(/\$\s?([\d.]+)/) || [])[1] || "").replace(/\./g, "")) || 0;
    const disponible = /<select/i.test(celdas[2] || "") && !/agotad/i.test(fila[1]);
    if (nombre) ofertas.push({ nombre, precio, disponible });
  }
  return Object.assign({}, ev, { url: link.split("?")[0], nombre: ev.nombre, ofertas: ofertas.length ? ofertas : ev.ofertas });
}

// Talk Tickets: the public page has schema.org Event with prices but no ticket names (those need an account),
// so the card shows the lowest price as "Precio desde".
async function leerTalk(link) {
  const r = await fetch(link, { headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" }, redirect: "follow" });
  if (r.status === 403 || r.status === 405 || r.headers.get("x-amzn-waf-action")) throw { code: "protegido" };
  if (r.status >= 400) throw { code: "plataforma" };
  const html = await r.text();
  const ev = leerEventoLD(html);
  if (!ev) throw { code: "evento" };
  const precios = ev.ofertas.map(o => o.precio).filter(p => p > 0);
  return {
    url: meta(html, "og:url") || link,
    nombre: ev.nombre || meta(html, "og:title"),
    inicio: /Z$/.test(ev.inicio) ? aHoraAR(ev.inicio) : ev.inicio,
    flyer: ev.flyer || meta(html, "og:image"),
    lugar: ev.lugar,
    ofertas: precios.length ? [{ nombre: "Precio desde", precio: Math.min.apply(null, precios), disponible: true, vip: false }] : []
  };
}

async function leerLink(link) {
  const p = plataformaDe(link);
  if (p === "bombo") return leerBombo(link);
  if (p === "venti") return leerVenti(link);
  if (p === "planout") return leerPlanout(link);
  if (p === "passline") return leerPassline(link);
  if (p === "talk") return leerTalk(link);
  throw { code: "link" };
}
// Current price = cheapest ticket on sale; if all sold out, the last tier marked agotado (same rule as the app)
function esVip(o) { return typeof o.vip === "boolean" ? o.vip : /vip/i.test(o.nombre); }
function elegirPrecios(ofertas) {
  function actual(lista) {
    if (!lista.length) return null;
    const disp = lista.filter(o => o.disponible);
    const o = disp.length ? disp.reduce((a, b) => (b.precio < a.precio ? b : a)) : lista.reduce((a, b) => (b.precio > a.precio ? b : a));
    return { nombre: o.nombre, precio: o.precio, agotado: !disp.length };
  }
  return { general: actual(ofertas.filter(o => !esVip(o))), vip: actual(ofertas.filter(esVip)) };
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
  return env.DB.prepare("SELECT u.sub, u.email, u.nombre, u.slug, u.instagram, u.whatsapp FROM sessions s JOIN users u ON u.sub = s.sub WHERE s.token_hash = ? AND s.expira > ?")
    .bind(await sha256(m[1]), Date.now()).first();
}
// "nico-capello" -> …/eventos/nico-capello; a repeated name is stored as "nico-capello--3f9a" -> …/eventos/nico-capello?id=3f9a
function linkDe(env, slug) {
  if (!slug) return "";
  const i = slug.indexOf("--");
  return (env.SITIO || "https://bpmtickets.com.ar") + "/eventos/" + (i > 0 ? slug.slice(0, i) + "?id=" + slug.slice(i + 2) : slug);
}
function usuarioPublico(u, env) { return { email: u.email, nombre: u.nombre || "", slug: u.slug || "", link: linkDe(env, u.slug), instagram: u.instagram || "", whatsapp: u.whatsapp || "" }; }
async function abrirSesion(env, sub, sugerido) {
  const token = tokenNuevo();
  await env.DB.prepare("INSERT INTO sessions (token_hash, sub, expira) VALUES (?, ?, ?)").bind(await sha256(token), sub, Date.now() + SESION_MS).run();
  const u = await env.DB.prepare("SELECT sub, email, nombre, slug, instagram, whatsapp FROM users WHERE sub = ?").bind(sub).first();
  return json(env, { ok: true, token, usuario: usuarioPublico(u, env), sugerido: slugDe(u.nombre || sugerido || u.email.split("@")[0]) });
}
// Old sessions, codes and counters are cleared now and then
async function limpiarViejos(env) {
  const ahora = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expira < ?").bind(ahora),
    env.DB.prepare("DELETE FROM codigos WHERE expira < ?").bind(ahora),
    env.DB.prepare("DELETE FROM limites WHERE desde < ?").bind(ahora - 24 * HORA_MS),
    env.DB.prepare("DELETE FROM traspasos WHERE creado < ?").bind(ahora - 30 * 24 * HORA_MS)
  ]);
}
// "@nico.rrpp", "instagram.com/nico.rrpp/" -> "nico.rrpp"; null if it isn't a valid handle, "" if empty
function limpiarInstagram(t) {
  t = String(t || "").trim();
  if (!t) return "";
  const m = t.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) t = m[1];
  t = t.replace(/^@+/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(t) ? t : null;
}
// Argentine numbers like "11 2345-6789" or "+54 9 11 2345 6789" -> "5491123456789"; null if invalid, "" if empty
function limpiarWhatsapp(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (!d) return "";
  d = d.replace(/^00/, "");
  if (d.startsWith("54")) { if (d.length === 12) d = "549" + d.slice(2); }
  else { d = d.replace(/^0/, ""); if (d.length === 10) d = "549" + d; }
  return d.length >= 11 && d.length <= 15 ? d : null;
}
async function slugLibre(env, sub, base) {
  const ocupado = async s => RESERVADOS.has(s) || !!(await env.DB.prepare("SELECT 1 FROM users WHERE slug = ? AND sub != ?").bind(s, sub).first());
  if (!(await ocupado(base))) return base;
  // same public name as another RRPP: add a short id that is always the same for this account (shown as ?id=…)
  const corto = base.slice(0, 30).replace(/-+$/g, "");
  let slug = corto + "--" + (await sha256(sub)).slice(0, 4);
  for (let i = 0; i < 5 && (await ocupado(slug)); i++) slug = corto + "--" + tokenNuevo().slice(0, 5);
  return slug;
}

// ---------- event lists ----------
function precioLimpio(p) {
  if (!p || typeof p !== "object") return null;
  return { nombre: String(p.nombre || "").slice(0, 100), precio: Math.max(0, Number(p.precio) || 0), agotado: !!p.agotado };
}
function limpiarEventos(lista) {
  if (!Array.isArray(lista)) return null;
  return lista.slice(0, 150).map(c => ({
    id: String(c.id || "").slice(0, 40),
    link: linkPermitido(c.link) ? String(c.link).slice(0, 600) : "",
    url: linkPermitido(c.url) ? String(c.url).slice(0, 600) : "",
    nombre: String(c.nombre || "").slice(0, 200),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || "") ? c.fecha : "",
    hora: /^\d{2}:\d{2}$/.test(c.hora || "") ? c.hora : "",
    flyer: imagenPermitida(c.flyer) ? String(c.flyer).slice(0, 600) : "",
    lugar: String(c.lugar || "").slice(0, 200),
    productoraId: c.productoraId ? String(c.productoraId).slice(0, 40) : null,
    productoraNombre: String(c.productoraNombre || "").trim().slice(0, 80),
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
      if (imagenPermitida(ev.flyer)) c.flyer = ev.flyer;
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
function filtrosHTML(lista) {
  if (lista.length < 2) return "";
  const meses = [...new Set(lista.map(c => (c.fecha || "").slice(0, 7)).filter(Boolean))].sort();
  const prods = [...new Map(lista.filter(c => c.productoraNombre).map(c => [c.productoraNombre.toLowerCase(), c.productoraNombre])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "es"));
  const opcMes = meses.map(m => '<option value="mes:' + m + '">' + MESES_LARGO[+m.slice(5, 7) - 1] + " " + m.slice(0, 4) + "</option>").join("");
  // search by name + a filter icon on the same row; the icon opens date / productora options
  return '<div class="buscar-fila">' +
    '<label class="buscar"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
    '<input id="f-q" type="search" placeholder="Buscar evento" autocomplete="off" aria-label="Buscar evento por nombre"></label>' +
    '<button type="button" id="f-toggle" class="f-btn" aria-expanded="false" aria-controls="f-box" aria-label="Filtrar por fecha o productora">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M6.5 12h11M10 18h4"/></svg><span id="f-activo" hidden></span></button></div>' +
    '<div class="filtros-box" id="f-box" hidden>' +
    '<label>Fecha<select id="f-fecha"><option value="">Todas las fechas</option><option value="finde">Este fin de semana</option><option value="7d">Próximos 7 días</option>' + opcMes + "</select></label>" +
    (prods.length ? '<label>Productora<select id="f-prod"><option value="">Todas las productoras</option>' +
      prods.map(p => '<option value="' + esc(p[0]) + '">' + esc(p[1]) + "</option>").join("") + "</select></label>" : "") +
    '<button type="button" id="f-limpiar">Quitar filtros</button></div>' +
    '<div class="vacio" id="f-vacio" hidden>No hay eventos con esa búsqueda.</div>';
}
const SCRIPT_FILTROS = `<script>
(function () {
  var fQ = document.getElementById("f-q"), fF = document.getElementById("f-fecha"), fP = document.getElementById("f-prod");
  var act = document.getElementById("f-activo"), box = document.getElementById("f-box"), tog = document.getElementById("f-toggle");
  if (!fQ) return;
  function norm(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function rango(v) {
    var h = new Date(); h.setHours(0, 0, 0, 0);
    if (v === "7d") { var f = new Date(h); f.setDate(f.getDate() + 7); return [iso(h), iso(f)]; }
    if (v === "finde") {
      var dia = h.getDay(); // 0 domingo … 6 sábado
      var vie = new Date(h); vie.setDate(h.getDate() + (dia === 0 ? -2 : dia === 6 ? -1 : 5 - dia));
      var lun = new Date(vie); lun.setDate(vie.getDate() + 3); // events after midnight on Sunday still count
      return [iso(vie), iso(lun)];
    }
    if (v.indexOf("mes:") === 0) { var m = v.slice(4); return [m + "-01", m + "-31"]; }
    return null;
  }
  function aplicar() {
    var q = norm(fQ.value).trim(), r = rango(fF.value), p = fP ? fP.value : "", n = 0;
    document.querySelectorAll(".ev").forEach(function (ev) {
      var f = ev.getAttribute("data-fecha");
      var nombre = norm((ev.querySelector("h2") || {}).textContent);
      var ok = (!q || nombre.indexOf(q) >= 0) && (!r || (f >= r[0] && f <= r[1])) && (!p || ev.getAttribute("data-prod") === p);
      ev.hidden = !ok; if (ok) n++;
    });
    document.getElementById("f-vacio").hidden = n > 0;
    var cuantos = (fF.value ? 1 : 0) + (p ? 1 : 0);
    act.hidden = !cuantos; act.textContent = cuantos || "";
    tog.classList.toggle("activo", !!cuantos);
  }
  tog.addEventListener("click", function () {
    box.hidden = !box.hidden;
    tog.setAttribute("aria-expanded", String(!box.hidden));
  });
  fQ.addEventListener("input", aplicar);
  fF.addEventListener("change", aplicar);
  if (fP) fP.addEventListener("change", aplicar);
  document.getElementById("f-limpiar").addEventListener("click", function () { fF.value = ""; if (fP) fP.value = ""; aplicar(); });
})();
</script>`;
const ICONO_IG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.4" cy="6.6" r="1.1" class="lleno"/></svg>';
const ICONO_WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.8a8.6 8.6 0 0 1-12.8 7.5L3.5 20.5l1.2-4.1A8.6 8.6 0 1 1 20.5 11.8z"/><path class="lleno" d="M9.1 7.6c-.3 0-.7.1-1 .5-.3.4-.9 1-.9 2.3 0 1.4 1 2.7 1.1 2.9.2.2 2 3 4.8 4.1 2.3.9 2.8.7 3.3.7.5-.1 1.6-.7 1.9-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3l-2.1-1c-.3-.1-.5-.2-.7.1l-.9 1.1c-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.8-.8-1.4-1.7-1.6-2-.2-.3 0-.4.1-.6l.5-.6.3-.5c.1-.2 0-.4 0-.5l-1-2.3c-.2-.6-.5-.5-.7-.5z"/></svg>';
function redesHTML(u) {
  if (!u || (!u.instagram && !u.whatsapp)) return "";
  return '<div class="redes">' +
    (u.instagram ? '<a class="red" href="https://instagram.com/' + esc(u.instagram) + '" target="_blank" rel="noopener">' + ICONO_IG + "<span>@" + esc(u.instagram) + "</span></a>" : "") +
    (u.whatsapp ? '<a class="red" href="https://wa.me/' + esc(u.whatsapp) + '?text=' + encodeURIComponent("Hola! Vi tus eventos y quiero entradas") + '" target="_blank" rel="noopener">' + ICONO_WA + "<span>WhatsApp</span></a>" : "") +
    "</div>";
}
function paginaHTML(lista, u, nonce) {
  const tarjetas = lista.map(c => {
    const agotado = (!c.general || c.general.agotado) && (!c.vip || c.vip.agotado) && (c.general || c.vip);
    return '<article class="ev" data-fecha="' + esc(c.fecha) + '" data-prod="' + esc((c.productoraNombre || "").toLowerCase()) + '">' +
      (c.flyer ? '<img src="' + esc(c.flyer) + '" alt="Flyer de ' + esc(c.nombre) + '" loading="lazy">' : "") +
      '<div class="info"><div class="fecha">' + esc(fechaLarga(c.fecha, c.hora)) + "</div><h2>" + esc(c.nombre) + "</h2>" +
      '<div class="precios">' + filaPrecio("General", c.general) + filaPrecio("VIP", c.vip) + "</div>" +
      (c.link ? '<a class="comprar' + (agotado ? " off" : "") + '" href="' + esc(c.link) + '" rel="noopener">' + (agotado ? "Ver evento" : "Comprar entradas") + "</a>" : "") +
      "</div></article>";
  }).join("");
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Próximos eventos · BPM Tickets</title>
<meta name="description" content="${esc(lista.map(c => c.nombre).slice(0, 5).join(" · ") || "Entradas para los próximos eventos")}">
<meta property="og:title" content="Próximos eventos · BPM Tickets">
<meta property="og:site_name" content="BPM Tickets">
<meta property="og:description" content="${esc(lista.map(c => c.nombre).slice(0, 5).join(" · ") || "Entradas para los próximos eventos")}">
<meta property="og:image" content="${LOGO_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
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
.marca { display: flex; align-items: center; gap: 8px; font-family: "Big Shoulders Display", "Arial Narrow", sans-serif; font-weight: 800; font-size: 18px; letter-spacing: .04em; margin-bottom: -8px; }
.marca .logo { width: 30px; height: auto; } .marca b { color: var(--accent); font-weight: 800; }
.redes { display: flex; gap: 10px; flex-wrap: wrap; margin-top: -4px; }
.red { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 8px 14px 8px 10px; font-weight: 600; font-size: 14px; }
.red svg { width: 22px; height: 22px; fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linejoin: round; }
.red svg .lleno { fill: var(--accent); stroke: none; }
.buscar-fila { display: flex; gap: 8px; align-items: stretch; }
.buscar { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 0 12px; }
.buscar svg, .f-btn svg { width: 20px; height: 20px; fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; flex: 0 0 auto; }
.buscar input { flex: 1; min-width: 0; background: transparent; border: 0; outline: none; color: var(--fg); font: inherit; font-size: 16px; padding: 12px 0; }
.buscar input::placeholder { color: var(--muted); }
.buscar:focus-within { border-color: var(--accent); }
.f-btn { position: relative; flex: 0 0 auto; width: 48px; display: grid; place-items: center; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; cursor: pointer; padding: 0; }
.f-btn[aria-expanded="true"], .f-btn.activo { border-color: var(--accent); }
.f-btn span { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; border-radius: 9px; background: var(--accent); color: var(--ink); font-size: 11px; font-weight: 700; display: grid; place-items: center; padding: 0 4px; }
.filtros-box { display: flex; flex-direction: column; gap: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-top: -6px; }
.filtros-box label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
.filtros-box select { -webkit-appearance: none; appearance: none; width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font: inherit; font-size: 16px; }
#f-limpiar { align-self: flex-start; background: none; border: 0; color: var(--accent); font: inherit; font-weight: 600; padding: 4px 0; cursor: pointer; }
.filtros-box[hidden], .f-btn span[hidden] { display: none; }
.ev[hidden], .vacio[hidden] { display: none; }
.vacio { color: var(--muted); text-align: center; padding: 40px 16px; border: 1px dashed var(--line); border-radius: 16px; }
</style></head>
<body><main>
<div class="marca"><svg class="logo" viewBox="0 0 90 56" aria-hidden="true"><path d="M8 0h74a8 8 0 0 1 8 8v12.4a7.6 7.6 0 0 0 0 15.2V48a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8V35.6a7.6 7.6 0 0 0 0-15.2V8a8 8 0 0 1 8-8z" fill="#39ff7f"/><polyline points="17,28 24,28 31,10 41,46 49,17 55,28 73,28" fill="none" stroke="#100e15" stroke-width="6.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>BPM <b>TICKETS</b></span></div>
<h1>Próximos <span>eventos</span></h1>
${redesHTML(u)}
${tarjetas ? filtrosHTML(lista) + tarjetas : '<div class="vacio">No hay eventos publicados por ahora.</div>'}
</main>${tarjetas ? SCRIPT_FILTROS.replace("<script>", '<script nonce="' + nonce + '">') : ""}</body></html>`;
}
function pagina404() {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No encontrado</title>' +
    '<body style="margin:0;background:#100e15;color:#f3f0f7;font-family:system-ui;display:grid;place-items:center;min-height:100vh;text-align:center;padding:16px">' +
    "<div><h1 style=\"margin:0 0 8px\">Página no encontrada</h1><p style=\"color:#a7a0b4\">Revisá que el link esté bien escrito.</p></div></body>",
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// The old app's own data (sales, productoras, %), carried once to the new site and deleted when it arrives
function limpiarTraspaso(d) {
  if (!d || typeof d !== "object" || d.app !== "comisiones-rrpp" || !Array.isArray(d.eventos) || d.eventos.length > 3000) return null;
  const limpio = {
    app: "comisiones-rrpp", exportado: new Date().toISOString(),
    pct: typeof d.pct === "number" ? d.pct : null,
    eventos: d.eventos.filter(e => e && typeof e === "object"),
    productoras: Array.isArray(d.productoras) ? d.productoras.filter(p => p && typeof p === "object").slice(0, 200) : []
  };
  const texto = JSON.stringify(limpio);
  return texto.length <= 400 * 1024 ? texto : null;
}
async function servirApp(env, ruta) {
  const r = await fetch((env.APP_FUENTE || "https://nicolascapello7.github.io/crrpp-ec7be04424") + ruta, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!r.ok) return pagina404();
  const sinCache = ruta === "/index.html" || ruta === "/sw.js" || ruta === "/manifest.webmanifest";
  return new Response(r.body, { headers: Object.assign({}, SEGURIDAD, {
    "Content-Type": r.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": sinCache ? "no-cache" : "public, max-age=3600"
  }) });
}
function pidioLaApp(req, env) {
  const origen = req.headers.get("Origin");
  if (origen) return origenesApp(env).includes(origen);
  // same-site requests don't always carry Origin
  return req.headers.get("Sec-Fetch-Site") === "same-origin" || (req.headers.get("Referer") || "").startsWith((env.SITIO || "https://bpmtickets.com.ar") + "/");
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const ruta = url.pathname;
    const sitio = env.SITIO || "https://bpmtickets.com.ar";
    const host = new URL(sitio).hostname;
    // CORS answers only the app's own sites
    const origen = req.headers.get("Origin");
    env = Object.assign({}, env, { ORIGEN: origen && origenesApp(env).includes(origen) ? origen : origenesApp(env)[0] });
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    if (Number(req.headers.get("Content-Length") || 0) > MAX_CUERPO) return json(env, { ok: false, error: "grande" }, 413);
    if (url.hostname === "www." + host) return Response.redirect(sitio + ruta + url.search, 301);
    const ip = req.headers.get("CF-Connecting-IP") || "";

    try {
      if (ruta === "/lector" && req.method === "GET") {
        // only the app may use the reader (keeps it from being used as a public proxy)
        if (!pidioLaApp(req, env)) return json(env, { ok: false, error: "origen" }, 403);
        const link = url.searchParams.get("url") || "";
        if (!linkPermitido(link)) return json(env, { ok: false, error: "link" }, 400);
        try { return json(env, Object.assign({ ok: true }, await leerLink(link))); }
        catch (e) { return json(env, { ok: false, error: (e && e.code) || "red" }, 502); }
      }

      // ----- sign in with Google -----
      if (ruta === "/api/login" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        let g;
        try { g = await verificarGoogle(cuerpo.credential, env.GOOGLE_CLIENT_ID); }
        catch (e) { return json(env, { ok: false, error: "google" }, 401); }
        const email = String(g.email).toLowerCase();
        // same person = same Google account, or same mail already verified with a password
        let u = await env.DB.prepare("SELECT sub FROM users WHERE google_sub = ?").bind(g.sub).first();
        if (!u) {
          u = await env.DB.prepare("SELECT sub FROM users WHERE email = ?").bind(email).first();
          if (u) await env.DB.prepare("UPDATE users SET google_sub = ? WHERE sub = ?").bind(g.sub, u.sub).run();
        }
        if (!u) {
          await env.DB.prepare("INSERT INTO users (sub, email, nombre, creado, google_sub) VALUES (?, ?, NULL, ?, ?)").bind(g.sub, email, new Date().toISOString(), g.sub).run();
          u = { sub: g.sub };
        }
        ctx.waitUntil(limpiarViejos(env).catch(() => {}));
        return abrirSesion(env, u.sub, g.name);
      }

      // ----- mail and password: sign up, sign in, forgotten password -----
      if (ruta === "/api/registro" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        const email = emailLimpio(cuerpo.email);
        if (!email) return json(env, { ok: false, error: "email" }, 400);
        if (!claveValida(cuerpo.clave)) return json(env, { ok: false, error: "clave" }, 400);
        const existe = await env.DB.prepare("SELECT clave FROM users WHERE email = ?").bind(email).first();
        if (existe && existe.clave) return json(env, { ok: false, error: "existe" }, 409);
        if (!env.RESEND_API_KEY) return json(env, { ok: false, error: "mail-config" }, 503);
        if (!(await puedeMandarMail(env, email, ip))) return json(env, { ok: false, error: "limite" }, 429);
        // the account is created only after the mailed code proves the address is theirs
        const codigo = await guardarCodigo(env, email, "registro", { clave: await crearClave(cuerpo.clave) });
        try { await mandarCodigo(env, email, "registro", codigo); }
        catch (e) { return json(env, { ok: false, error: (e && e.code) || "mail" }, 502); }
        return json(env, { ok: true });
      }
      if (ruta === "/api/verificar" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        const email = emailLimpio(cuerpo.email);
        if (!email) return json(env, { ok: false, error: "email" }, 400);
        let datos;
        try { datos = await usarCodigo(env, email, "registro", cuerpo.codigo); }
        catch (e) { return json(env, { ok: false, error: e.code || "codigo" }, 400); }
        if (!datos.clave) return json(env, { ok: false, error: "codigo-vencido" }, 400);
        const u = await env.DB.prepare("SELECT sub FROM users WHERE email = ?").bind(email).first();
        let sub;
        if (u) { sub = u.sub; await env.DB.prepare("UPDATE users SET clave = ? WHERE sub = ?").bind(datos.clave, sub).run(); }
        else {
          sub = "u-" + tokenNuevo().slice(0, 24);
          await env.DB.prepare("INSERT INTO users (sub, email, nombre, creado, clave) VALUES (?, ?, NULL, ?, ?)").bind(sub, email, new Date().toISOString(), datos.clave).run();
        }
        return abrirSesion(env, sub);
      }
      if (ruta === "/api/entrar" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        const email = emailLimpio(cuerpo.email);
        if (!email || typeof cuerpo.clave !== "string") return json(env, { ok: false, error: "credenciales" }, 401);
        // after 8 wrong passwords for a mail (or 30 from one connection) wait 15 minutes
        if (await leerLimite(env, "entrar:" + email, 15 * 60 * 1000) >= 8 || await leerLimite(env, "entrar-ip:" + ip, 15 * 60 * 1000) >= 30)
          return json(env, { ok: false, error: "bloqueado" }, 429);
        const u = await env.DB.prepare("SELECT sub, clave FROM users WHERE email = ?").bind(email).first();
        if (!(await claveCorrecta(cuerpo.clave.slice(0, 128), u && u.clave))) {
          await sumarLimite(env, "entrar:" + email, 15 * 60 * 1000);
          await sumarLimite(env, "entrar-ip:" + ip, 15 * 60 * 1000);
          return json(env, { ok: false, error: "credenciales" }, 401);
        }
        await env.DB.prepare("DELETE FROM limites WHERE clave = ?").bind("entrar:" + email).run();
        ctx.waitUntil(limpiarViejos(env).catch(() => {}));
        return abrirSesion(env, u.sub);
      }
      if (ruta === "/api/olvide" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        const email = emailLimpio(cuerpo.email);
        if (!email) return json(env, { ok: false, error: "email" }, 400);
        if (!env.RESEND_API_KEY) return json(env, { ok: false, error: "mail-config" }, 503);
        if (!(await puedeMandarMail(env, email, ip))) return json(env, { ok: false, error: "limite" }, 429);
        // same answer whether the mail has an account or not
        const u = await env.DB.prepare("SELECT sub FROM users WHERE email = ?").bind(email).first();
        if (u) {
          const codigo = await guardarCodigo(env, email, "olvide", null);
          ctx.waitUntil(mandarCodigo(env, email, "olvide", codigo).catch(() => {}));
        }
        return json(env, { ok: true });
      }
      if (ruta === "/api/reenviar" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        const email = emailLimpio(cuerpo.email);
        const tipo = cuerpo.tipo === "olvide" ? "olvide" : "registro";
        if (!email) return json(env, { ok: false, error: "email" }, 400);
        const f = await env.DB.prepare("SELECT datos, enviado FROM codigos WHERE email = ? AND tipo = ?").bind(email, tipo).first();
        if (!f) return json(env, tipo === "olvide" ? { ok: true } : { ok: false, error: "codigo-vencido" }, tipo === "olvide" ? 200 : 400);
        if (Date.now() - f.enviado < 45 * 1000) return json(env, { ok: false, error: "espera" }, 429);
        if (!(await puedeMandarMail(env, email, ip))) return json(env, { ok: false, error: "limite" }, 429);
        const codigo = await guardarCodigo(env, email, tipo, f.datos ? JSON.parse(f.datos) : null);
        try { await mandarCodigo(env, email, tipo, codigo); }
        catch (e) { return json(env, { ok: false, error: (e && e.code) || "mail" }, 502); }
        return json(env, { ok: true });
      }
      if (ruta === "/api/restablecer" && req.method === "POST") {
        const cuerpo = await req.json().catch(() => ({}));
        const email = emailLimpio(cuerpo.email);
        if (!email) return json(env, { ok: false, error: "email" }, 400);
        if (!claveValida(cuerpo.clave)) return json(env, { ok: false, error: "clave" }, 400);
        try { await usarCodigo(env, email, "olvide", cuerpo.codigo); }
        catch (e) { return json(env, { ok: false, error: e.code || "codigo" }, 400); }
        const u = await env.DB.prepare("SELECT sub FROM users WHERE email = ?").bind(email).first();
        if (!u) return json(env, { ok: false, error: "codigo-vencido" }, 400);
        // new password: every other open session is closed
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET clave = ? WHERE sub = ?").bind(await crearClave(cuerpo.clave), u.sub),
          env.DB.prepare("DELETE FROM sessions WHERE sub = ?").bind(u.sub),
          env.DB.prepare("DELETE FROM limites WHERE clave = ?").bind("entrar:" + email)
        ]);
        return abrirSesion(env, u.sub);
      }

      if (ruta.startsWith("/api/")) {
        const u = await usuarioDe(req, env);
        if (!u) return json(env, { ok: false, error: "sesion" }, 401);

        if (ruta === "/api/yo" && req.method === "GET") {
          return json(env, { ok: true, usuario: usuarioPublico(u, env), eventos: await leerLista(env, u.sub) });
        }
        if (ruta === "/api/perfil" && req.method === "PUT") {
          const cuerpo = await req.json().catch(() => ({}));
          const nombre = String(cuerpo.nombre || "").trim().slice(0, 60);
          const base = slugDe(nombre);
          if (base.length < 3) return json(env, { ok: false, error: "slug-corto" }, 400);
          const instagram = limpiarInstagram(cuerpo.instagram);
          if (instagram === null) return json(env, { ok: false, error: "instagram" }, 400);
          const whatsapp = limpiarWhatsapp(cuerpo.whatsapp);
          if (whatsapp === null) return json(env, { ok: false, error: "whatsapp" }, 400);
          // keep the current link if the name didn't change; otherwise find a free one
          const slug = u.slug && slugDe(u.nombre) === base ? u.slug : await slugLibre(env, u.sub, base);
          await env.DB.prepare("UPDATE users SET nombre = ?, slug = ?, instagram = ?, whatsapp = ? WHERE sub = ?")
            .bind(nombre, slug, instagram || null, whatsapp || null, u.sub).run();
          return json(env, { ok: true, usuario: { email: u.email, nombre, slug, link: linkDe(env, slug), instagram, whatsapp } });
        }
        if (ruta === "/api/eventos" && req.method === "PUT") {
          const cuerpo = await req.json().catch(() => ({}));
          const lista = limpiarEventos(cuerpo.eventos);
          if (!lista) return json(env, { ok: false, error: "datos" }, 400);
          // a device that doesn't know a productora sends its name empty: keep the name already stored
          const previos = new Map((await leerLista(env, u.sub)).map(c => [c.id, c]));
          lista.forEach(c => {
            const p = previos.get(c.id);
            if (!c.productoraNombre && c.productoraId && p && p.productoraId === c.productoraId && p.productoraNombre) c.productoraNombre = p.productoraNombre;
          });
          await guardarLista(env, u.sub, lista);
          return json(env, { ok: true, cantidad: lista.length });
        }
        if (ruta === "/api/traspaso") {
          if (req.method === "PUT") {
            const texto = limpiarTraspaso((await req.json().catch(() => ({}))).datos);
            if (!texto) return json(env, { ok: false, error: "datos" }, 400);
            await env.DB.prepare("INSERT INTO traspasos (sub, datos, creado) VALUES (?, ?, ?) ON CONFLICT(sub) DO UPDATE SET datos = excluded.datos, creado = excluded.creado")
              .bind(u.sub, texto, Date.now()).run();
            return json(env, { ok: true });
          }
          if (req.method === "GET") {
            const f = await env.DB.prepare("SELECT datos FROM traspasos WHERE sub = ? AND creado > ?").bind(u.sub, Date.now() - 30 * 24 * HORA_MS).first();
            return json(env, { ok: true, datos: f ? JSON.parse(f.datos) : null });
          }
          if (req.method === "DELETE") {
            await env.DB.prepare("DELETE FROM traspasos WHERE sub = ?").bind(u.sub).run();
            return json(env, { ok: true });
          }
        }
        if (ruta === "/api/cuenta" && req.method === "DELETE") {
          // the RRPP deletes everything stored about them: events, sessions, pending codes and account
          await env.DB.batch([
            env.DB.prepare("DELETE FROM eventos WHERE sub = ?").bind(u.sub),
            env.DB.prepare("DELETE FROM traspasos WHERE sub = ?").bind(u.sub),
            env.DB.prepare("DELETE FROM codigos WHERE email = ?").bind(u.email),
            env.DB.prepare("DELETE FROM sessions WHERE sub = ?").bind(u.sub),
            env.DB.prepare("DELETE FROM users WHERE sub = ?").bind(u.sub)
          ]);
          return json(env, { ok: true });
        }
        if (ruta === "/api/logout" && req.method === "POST") {
          const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
          if (m) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(m[1])).run();
          return json(env, { ok: true });
        }
        return json(env, { ok: false, error: "ruta" }, 404);
      }

      if (ruta === "/robots.txt") return new Response("User-agent: *\nDisallow: /api/\nDisallow: /lector\n", { headers: { "Content-Type": "text/plain" } });

      // ----- public page of a RRPP: /eventos/nico-capello (or ?id=… when two RRPPs share a name) -----
      const pub = ruta.match(/^\/eventos\/([a-z0-9-]{3,40})\/?$/);
      if (pub && req.method === "GET") {
        const id = (url.searchParams.get("id") || "").toLowerCase();
        if (id && !/^[a-z0-9]{2,8}$/.test(id)) return pagina404();
        const u = await env.DB.prepare("SELECT sub, instagram, whatsapp FROM users WHERE slug = ?").bind(id ? pub[1] + "--" + id : pub[1]).first();
        if (!u) return pagina404();
        const hoy = hoyAR();
        const lista = (await leerLista(env, u.sub))
          .filter(c => !c.fecha || c.fecha >= hoy)
          .sort((a, b) => (a.fecha || "9999").localeCompare(b.fecha || "9999"));
        if (lista.some(c => c.link && (!c.actualizado || Date.now() - Date.parse(c.actualizado) > VIEJO_MS))) ctx.waitUntil(refrescar(env, u.sub));
        const nonce = tokenNuevo().slice(0, 24);
        return new Response(paginaHTML(lista, u, nonce), { headers: Object.assign({}, SEGURIDAD, {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; img-src https://files.wearebombo.com https://storage.googleapis.com https://images.venti.live https://d26en73i7b5aju.cloudfront.net https://www.passline.com https://cdn.getcrowder.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-" + nonce + "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        }) });
      }

      // ----- the RRPP app at the root of the site -----
      if (url.hostname === host && req.method === "GET") {
        if (ruta === "/") return servirApp(env, "/index.html");
        if (ARCHIVOS_APP.has(ruta)) return servirApp(env, ruta);
      }

      // links shared before the move (…workers.dev/nico-capello or /nico-capello) go to the new address
      const viejo = ruta.match(/^\/([a-z0-9-]{3,40})\/?$/);
      if (viejo && req.method === "GET" && !RESERVADOS.has(viejo[1])) {
        const u = await env.DB.prepare("SELECT slug FROM users WHERE slug = ?").bind(viejo[1]).first();
        if (u) return Response.redirect(linkDe(env, u.slug), 301);
      }
      return pagina404();
    } catch (e) {
      return json(env, { ok: false, error: "servidor" }, 500);
    }
  }
};
