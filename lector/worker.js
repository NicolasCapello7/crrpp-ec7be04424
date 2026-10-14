// Lector de Bombo: reads a public Bombo event page and returns its data as JSON for the Comisiones app.
// Only wearebombo.com / wearebombo.app.link links are accepted, and only the app's origin may call it.
const ORIGENES = ["https://nicolascapello7.github.io"];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function respuesta(cuerpo, status, origin) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ORIGENES.includes(origin) ? origin : ORIGENES[0],
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function esBombo(u) {
  return /(^|\.)wearebombo\.com$/.test(u.hostname) || u.hostname === "wearebombo.app.link";
}

async function traer(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" }, redirect: "follow" });
  return { status: r.status, url: r.url, html: await r.text() };
}

function leerEvento(html) {
  const bloques = html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g);
  for (const b of bloques) {
    let j;
    try { j = JSON.parse(b[1]); } catch (e) { continue; }
    const lista = Array.isArray(j) ? j : [j];
    for (const ev of lista) {
      if (!ev || !/Event$/.test(String(ev["@type"] || ""))) continue;
      const imagen = Array.isArray(ev.image) ? ev.image[0] : ev.image;
      return {
        nombre: ev.name || "",
        inicio: ev.startDate || "",
        flyer: typeof imagen === "string" ? imagen : (imagen && imagen.url) || "",
        lugar: (ev.location && (ev.location.name || (ev.location.address && ev.location.address.streetAddress))) || "",
        ofertas: (Array.isArray(ev.offers) ? ev.offers : ev.offers ? [ev.offers] : []).map(o => ({
          nombre: o.name || "",
          precio: Number(o.price) || 0,
          disponible: !/SoldOut|OutOfStock|Discontinued/i.test(String(o.availability || ""))
        }))
      };
    }
  }
  return null;
}

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": ORIGENES.includes(origin) ? origin : ORIGENES[0], "Access-Control-Allow-Methods": "GET", "Vary": "Origin" } });
    }
    let destino;
    try { destino = new URL(new URL(req.url).searchParams.get("url") || ""); } catch (e) { return respuesta({ ok: false, error: "link" }, 400, origin); }
    if (!esBombo(destino)) return respuesta({ ok: false, error: "link" }, 400, origin);

    try {
      let pagina = await traer(destino.toString());
      // Links shared from the app (wearebombo.app.link) land on a page that points to the real event URL
      if (destino.hostname === "wearebombo.app.link") {
        const m = pagina.html.match(/https:\/\/wearebombo\.com\/event[o]?\/[A-Za-z0-9-]+/);
        if (!m) return respuesta({ ok: false, error: "evento" }, 404, origin);
        pagina = await traer(m[0]);
      }
      if (pagina.status >= 400) return respuesta({ ok: false, error: "bombo", status: pagina.status }, 502, origin);
      const ev = leerEvento(pagina.html);
      if (!ev) return respuesta({ ok: false, error: "evento" }, 404, origin);
      return respuesta(Object.assign({ ok: true, url: pagina.url.split("?")[0] }, ev), 200, origin);
    } catch (e) {
      return respuesta({ ok: false, error: "red" }, 502, origin);
    }
  }
};
