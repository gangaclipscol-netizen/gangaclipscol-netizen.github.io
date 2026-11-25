// GangaClips Publisher — servidor mínimo (Cloudflare Worker) para conectar TikTok y YouTube y publicar clips.
// La página (gangaclipscol-netizen.github.io/app.html) habla con este Worker; las claves secretas viven aquí
// como secretos de Cloudflare (nunca en el código). Las cuentas conectadas se guardan en KV (CUENTAS).
// El robot de GitHub Actions publica con la cabecera X-Robot-Key usando la última cuenta conectada.

const PAGINA = "https://gangaclipscol-netizen.github.io";
const REDIRECT = PAGINA + "/callback.html";
const TT = "https://open.tiktokapis.com/v2";

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin && (origin === PAGINA || origin.startsWith("http://localhost")) ? origin : PAGINA,
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Robot-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
});
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", ...cors(origin) } });
const azar = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function guardar(env, clave, valor) { await env.CUENTAS.put(clave, JSON.stringify(valor)); }
async function leer(env, clave) { const v = await env.CUENTAS.get(clave); return v ? JSON.parse(v) : null; }

// ---------- TikTok ----------
async function ttToken(env, form) {
  const r = await fetch(TT + "/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...form }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("TikTok: " + (d.error_description || d.error || JSON.stringify(d)));
  return { access: d.access_token, refresh: d.refresh_token, open_id: d.open_id, vence: Date.now() + (d.expires_in - 120) * 1000 };
}

async function ttCuenta(env, ref) {
  const c = await leer(env, "tt:" + ref);
  if (!c) throw new Error("TikTok no está conectado");
  if (Date.now() > c.vence) {
    const n = await ttToken(env, { grant_type: "refresh_token", refresh_token: c.refresh });
    await guardar(env, "tt:" + ref, n);
    return n;
  }
  return c;
}

async function ttApi(c, ruta, cuerpo, metodo) {
  const r = await fetch(TT + ruta, {
    method: metodo || "POST",
    headers: { Authorization: "Bearer " + c.access, "Content-Type": "application/json; charset=UTF-8" },
    body: metodo === "GET" ? undefined : JSON.stringify(cuerpo || {}),
  });
  return r.json();
}

async function ttPublicar(c, video, opciones) {
  // Direct Post subiendo el archivo (FILE_UPLOAD), un solo trozo hasta 64 MB.
  const tam = video.byteLength;
  const ini = await ttApi(c, "/post/publish/video/init/", {
    post_info: {
      title: opciones.title || "",
      privacy_level: opciones.privacy,
      disable_comment: !!opciones.disable_comment,
      disable_duet: !!opciones.disable_duet,
      disable_stitch: !!opciones.disable_stitch,
      brand_content_toggle: !!opciones.brand_content,
      brand_organic_toggle: !!opciones.brand_organic,
    },
    source_info: { source: "FILE_UPLOAD", video_size: tam, chunk_size: tam, total_chunk_count: 1 },
  });
  if (!ini.data || !ini.data.upload_url) throw new Error("TikTok init: " + JSON.stringify(ini.error || ini));
  const up = await fetch(ini.data.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": String(tam), "Content-Range": `bytes 0-${tam - 1}/${tam}` },
    body: video,
  });
  if (!up.ok) throw new Error("TikTok subida: HTTP " + up.status + " " + (await up.text()).slice(0, 200));
  return ini.data.publish_id;
}

// ---------- YouTube ----------
async function ytToken(env, form) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...form }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Google: " + (d.error_description || d.error || JSON.stringify(d)));
  return { access: d.access_token, refresh: d.refresh_token || form.refresh_token, vence: Date.now() + (d.expires_in - 120) * 1000 };
}

async function ytCuenta(env, ref) {
  const c = await leer(env, "yt:" + ref);
  if (!c) throw new Error("YouTube no está conectado");
  if (Date.now() > c.vence) {
    const n = await ytToken(env, { grant_type: "refresh_token", refresh_token: c.refresh });
    await guardar(env, "yt:" + ref, n);
    return n;
  }
  return c;
}

async function ytSubir(c, video, opciones) {
  const meta = {
    snippet: { title: (opciones.title || "Clip").slice(0, 100), description: opciones.description || "", categoryId: "24" },
    status: { privacyStatus: opciones.privacy || "private", selfDeclaredMadeForKids: false },
  };
  const ini = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + c.access,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(video.byteLength),
    },
    body: JSON.stringify(meta),
  });
  const donde = ini.headers.get("Location");
  if (!donde) throw new Error("YouTube init: HTTP " + ini.status + " " + (await ini.text()).slice(0, 300));
  const up = await fetch(donde, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: video });
  const d = await up.json();
  if (!d.id) throw new Error("YouTube subida: " + JSON.stringify(d.error || d).slice(0, 300));
  return d.id;
}

// ---------- rutas ----------
async function quien(env, req) {
  // Sesión de la página (Authorization: Bearer <sesión>) o el robot (X-Robot-Key) → referencia de la cuenta.
  const robot = req.headers.get("X-Robot-Key");
  if (robot && env.ROBOT_KEY && robot === env.ROBOT_KEY) return (await leer(env, "ultima")) || {};
  const s = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  return s ? (await leer(env, "s:" + s)) || {} : {};
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/config") return json({ tiktok_client_key: env.TIKTOK_CLIENT_KEY, google_client_id: env.GOOGLE_CLIENT_ID, redirect: REDIRECT }, 200, origin);

      if (p === "/auth/tiktok" && req.method === "POST") {
        const { code, session } = await req.json();
        const t = await ttToken(env, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
        const ref = t.open_id;
        await guardar(env, "tt:" + ref, t);
        const s = session || azar();
        const ses = (await leer(env, "s:" + s)) || {};
        ses.tt = ref;
        await guardar(env, "s:" + s, ses);
        await guardar(env, "ultima", { ...((await leer(env, "ultima")) || {}), tt: ref });
        return json({ session: s }, 200, origin);
      }

      if (p === "/auth/youtube" && req.method === "POST") {
        const { code, session } = await req.json();
        const t = await ytToken(env, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
        const s = session || azar();
        const ref = azar().slice(0, 12);
        await guardar(env, "yt:" + ref, t);
        const ses = (await leer(env, "s:" + s)) || {};
        ses.yt = ref;
        await guardar(env, "s:" + s, ses);
        await guardar(env, "ultima", { ...((await leer(env, "ultima")) || {}), yt: ref });
        return json({ session: s }, 200, origin);
      }

      const yo = await quien(env, req);

      if (p === "/me") {
        const out = { tiktok: null, youtube: !!yo.yt };
        if (yo.tt) {
          const c = await ttCuenta(env, yo.tt);
          const d = await ttApi(c, "/user/info/?fields=open_id,avatar_url,display_name", null, "GET");
          out.tiktok = d.data && d.data.user;
        }
        return json(out, 200, origin);
      }

      if (p === "/tiktok/creator") {
        const c = await ttCuenta(env, yo.tt);
        return json(await ttApi(c, "/post/publish/creator_info/query/", {}), 200, origin);
      }

      if (p === "/tiktok/post" && req.method === "POST") {
        const c = await ttCuenta(env, yo.tt);
        const o = Object.fromEntries(url.searchParams);
        for (const k of ["disable_comment", "disable_duet", "disable_stitch", "brand_content", "brand_organic"]) o[k] = o[k] === "1";
        if (!o.privacy) throw new Error("Elige quién puede ver el video");
        const id = await ttPublicar(c, await req.arrayBuffer(), o);
        return json({ publish_id: id }, 200, origin);
      }

      if (p === "/tiktok/status") {
        const c = await ttCuenta(env, yo.tt);
        return json(await ttApi(c, "/post/publish/status/fetch/", { publish_id: url.searchParams.get("id") }), 200, origin);
      }

      if (p === "/youtube/upload" && req.method === "POST") {
        const c = await ytCuenta(env, yo.yt);
        const id = await ytSubir(c, await req.arrayBuffer(), Object.fromEntries(url.searchParams));
        return json({ video_id: id, url: "https://www.youtube.com/shorts/" + id }, 200, origin);
      }

      if (p === "/logout" && req.method === "POST") {
        const s = (req.headers.get("Authorization") || "").replace("Bearer ", "");
        if (s) await env.CUENTAS.delete("s:" + s);
        return json({ ok: true }, 200, origin);
      }

      return json({ app: "GangaClips Publisher API" }, 200, origin);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400, origin);
    }
  },
};
