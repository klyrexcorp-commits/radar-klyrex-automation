const fs = require('fs');
const dns = require('dns').promises;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OBJETIVO = Number(process.env.OBJETIVO_LEADS || 80);
const VISTOS_PATH = 'leads-data/vistos.json';

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}

function sb(path, opts) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }, (opts && opts.headers) || {})
  })).then(async r => {
    const t = await r.text();
    if (!r.ok) throw new Error(`${path} -> ${r.status}: ${t}`);
    return t ? JSON.parse(t) : null;
  });
}

// ---- 1. Overpass: negocios de interiorismo y reformas en toda España ----
const OVERPASS_QUERY = `
[out:json][timeout:90];
area["name"="España"]["admin_level"="2"]->.a;
(
  nwr["office"="interior_design"](area.a);
  nwr["office"="interior_designer"](area.a);
  nwr["shop"="interior_decoration"](area.a);
  nwr["craft"="interior_decorator"](area.a);
  nwr["craft"="building_constructor"](area.a);
  nwr["craft"="general_contractor"](area.a);
);
out center tags;
`;

// El servidor principal de Overpass se satura a veces (502/504): se prueban
// varios espejos públicos por orden, con reintento, antes de rendirse.
const OVERPASS_ESPEJOS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

async function consultarOverpass() {
  let ultimoError;
  for (const espejo of OVERPASS_ESPEJOS) {
    for (let intento = 0; intento < 2; intento++) {
      try {
        const res = await fetch(espejo, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'RadarKlyrex/1.0 (klyrexcorp@gmail.com)'
          },
          body: 'data=' + encodeURIComponent(OVERPASS_QUERY)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        ultimoError = e;
        console.log(`Overpass (${espejo}) falló: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  throw new Error(`Todos los espejos de Overpass fallaron: ${ultimoError && ultimoError.message}`);
}

async function buscarOverpass() {
  const data = await consultarOverpass();
  return data.elements
    .filter(e => e.tags && e.tags.name && e.tags.website)
    .map(e => {
      const t = e.tags;
      return {
        osmId: `${e.type}/${e.id}`,
        nombre: t.name,
        categoria: t.office || t.shop || t.craft || '',
        ciudad: t['addr:city'] || '',
        telefono: t.phone || t['contact:phone'] || '',
        website: t.website || t['contact:website']
      };
    });
}

// ---- 2. Email scraping ----
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
const IGNORAR_EXT = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i;
const DOMINIOS_BASURA = ['sentry.io', 'wixpress.com', 'example.com', 'godaddy.com', 'schema.org', 'w3.org', 'webador.es', 'webador.com'];
const EMAIL_BASURA_RE = /^(nome|exemplo|su|soporte|webmaster|noreply|no-reply|test|demo)@|@(exemplo|email)\.com$/i;

function limpiarEmails(emails, dominioSitio) {
  const vistos = new Set();
  const out = [];
  for (let e of emails) {
    e = e.toLowerCase().replace(/^mailto:/, '').replace(/^[^a-z0-9]+/, '').trim();
    if (!e || IGNORAR_EXT.test(e) || EMAIL_BASURA_RE.test(e)) continue;
    if (DOMINIOS_BASURA.some(d => e.endsWith('@' + d))) continue;
    if (vistos.has(e)) continue;
    vistos.add(e);
    out.push(e);
  }
  out.sort((a, b) => {
    const aProp = dominioSitio && a.endsWith('@' + dominioSitio) ? 0 : 1;
    const bProp = dominioSitio && b.endsWith('@' + dominioSitio) ? 0 : 1;
    return aProp - bProp;
  });
  return out;
}

async function fetchConTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadarKlyrexBot/1.0; +mailto:klyrexcorp@gmail.com)' }
    });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function buscarEmail(candidato) {
  let dominioSitio = '';
  try { dominioSitio = new URL(candidato.website).hostname.replace(/^www\./, ''); } catch (_) { return null; }

  const paginas = [candidato.website];
  try {
    const base = new URL(candidato.website);
    ['contacto', 'contact', 'contactanos'].forEach(p => paginas.push(base.origin + '/' + p));
  } catch (_) {}

  for (const url of paginas) {
    try {
      const html = await fetchConTimeout(url, 8000);
      const emails = limpiarEmails(html.match(EMAIL_RE) || [], dominioSitio);
      if (emails.length) return emails[0];
    } catch (_) { /* probar siguiente página */ }
  }
  return null;
}

async function tieneMx(email) {
  const dominio = email.split('@')[1];
  try {
    const r = await dns.resolveMx(dominio);
    return Array.isArray(r) && r.length > 0;
  } catch (_) {
    return false;
  }
}

// ---- 3. Ledger de ya vistos (para no repetir negocio de un día a otro) ----
function cargarVistos() {
  try {
    return new Set(JSON.parse(fs.readFileSync(VISTOS_PATH, 'utf8')));
  } catch (_) {
    return new Set();
  }
}

function guardarVistos(set) {
  fs.mkdirSync('leads-data', { recursive: true });
  fs.writeFileSync(VISTOS_PATH, JSON.stringify([...set].sort(), null, 0));
}

async function emailsYaEnCrm() {
  const filas = await sb('leads?select=email');
  return new Set((filas || []).map(f => String(f.email || '').toLowerCase()).filter(Boolean));
}

async function main() {
  const vistos = cargarVistos();
  console.log(`Negocios ya vistos en ejecuciones anteriores: ${vistos.size}`);
  const emailsExistentes = await emailsYaEnCrm();
  console.log(`Emails ya presentes en el CRM: ${emailsExistentes.size}`);

  const candidatos = (await buscarOverpass()).filter(c => !vistos.has(c.osmId));
  console.log(`Candidatos nuevos de Overpass (con web, no vistos antes): ${candidatos.length}`);

  const listos = [];
  const emailsDeEsteLote = new Set();
  for (const c of candidatos) {
    if (listos.length >= OBJETIVO) break;
    const email = await buscarEmail(c);
    vistos.add(c.osmId);
    if (!email) continue;
    const emailNorm = email.toLowerCase();
    if (emailsExistentes.has(emailNorm) || emailsDeEsteLote.has(emailNorm)) continue;
    if (!(await tieneMx(emailNorm))) continue;
    emailsDeEsteLote.add(emailNorm);
    listos.push({ ...c, email: emailNorm });
    console.log(`[${listos.length}/${OBJETIVO}] ${c.nombre} -> ${emailNorm}`);
  }
  guardarVistos(vistos);

  if (listos.length === 0) {
    console.log('No se encontraron leads nuevos válidos hoy. No se toca el CRM.');
    return;
  }

  // Borra el lote anterior sin revisar (sin campaña, estado nuevo, de esta misma fuente),
  // para que el usuario solo vea el lote de hoy. Nunca toca leads ya asignados a campaña.
  const filtroBorrado = new URLSearchParams({
    campana_id: 'is.null',
    estado: 'eq.nuevo',
    notas: 'like.Fuente: OpenStreetMap (diario)*'
  });
  const borrados = await sb(
    `leads?${filtroBorrado}`,
    { method: 'DELETE', headers: { Prefer: 'return=representation' } }
  );
  console.log(`Lote anterior sin revisar borrado: ${(borrados || []).length} leads.`);

  const paraImportar = listos.map(l => ({
    nombre: l.nombre,
    email: l.email,
    ciudad: l.ciudad || '',
    telefono: l.telefono || '',
    origen: 'outbound',
    estado: 'nuevo',
    toque: 0,
    segmento: 'web',
    campana_id: null,
    notas: `Fuente: OpenStreetMap (diario) — categoría ${l.categoria}`
  }));
  await sb('leads', { method: 'POST', body: JSON.stringify(paraImportar) });
  console.log(`Importados ${paraImportar.length} leads nuevos, sin campaña, listos para revisar.`);
}

main().catch(err => {
  console.error('Error general:', err);
  process.exit(1);
});
