const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const { execSync } = require('child_process');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OBJETIVO = Number(process.env.OBJETIVO_LEADS || 50);
const VISTOS_PATH = 'leads-data/vistos_licitaciones.json';

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}

function sb(path2, opts) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path2}`, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json'
    }, (opts && opts.headers) || {})
  })).then(async r => {
    const t = await r.text();
    if (!r.ok) throw new Error(`${path2} -> ${r.status}: ${t}`);
    return t ? JSON.parse(t) : null;
  });
}

// ---- 1. Descargar el fichero mensual de licitaciones de PLACSP ----
// Los datos tardan unos meses en publicarse: se prueba desde hace 2 meses
// hacia atrás hasta encontrar uno que exista.
async function descargarZipMasReciente() {
  const hoy = new Date();
  for (let atras = 2; atras <= 8; atras++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - atras, 1);
    const aaaamm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const url = `https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3_${aaaamm}.zip`;
    console.log(`Probando mes ${aaaamm}...`);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RadarKlyrexBot/1.0; +mailto:klyrexcorp@gmail.com)' } });
      if (!res.ok) { console.log(`  HTTP ${res.status}, siguiente mes`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100000) { console.log('  fichero demasiado pequeño, siguiente mes'); continue; }
      const tmpZip = path.join(os.tmpdir(), 'licitaciones.zip');
      fs.writeFileSync(tmpZip, buf);
      console.log(`  OK, ${buf.length} bytes. Mes usado: ${aaaamm}`);
      return { zipPath: tmpZip, mes: aaaamm };
    } catch (e) {
      console.log(`  error: ${e.message}, siguiente mes`);
    }
  }
  throw new Error('No se encontró ningún mes descargable en los últimos 8 meses.');
}

function descomprimir(zipPath) {
  const dir = path.join(os.tmpdir(), 'licitaciones-extraidas');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${dir}"`, { stdio: 'ignore' });
  return dir;
}

// ---- 2. Filtrar contratos relevantes ----
const KEYWORDS = /chatbot|asistente virtual|render(izado)?s? 3d|visualizaci[oó]n 3d|p[aá]gina web (municipal|corporativa)?|dise[nñ]o (y desarrollo )?web|plan de contenidos|redes sociales|gemelo digital/i;
const EXCLUIR_GANADOR = /^(indra|ntt data|telef[oó]nica|accenture|atos\b|everis|minsait|t-systems|capgemini|deloitte|vodafone|banco )/i;

function extraerCandidatos(dirExtraido) {
  const ficheros = fs.readdirSync(dirExtraido).filter(f => f.endsWith('.atom'));
  const candidatos = [];
  for (const f of ficheros) {
    const data = fs.readFileSync(path.join(dirExtraido, f), 'utf8');
    const entries = data.split('<entry>').slice(1);
    for (const e of entries) {
      const titleM = e.match(/<title>([^<]*)<\/title>/);
      if (!titleM || !KEYWORDS.test(titleM[1])) continue;
      const winnerM = e.match(/<cac:WinningParty>[\s\S]*?<cbc:Name>([^<]*)<\/cbc:Name>/);
      if (!winnerM) continue;
      const winner = winnerM[1].trim();
      if (!winner || EXCLUIR_GANADOR.test(winner)) continue;
      const nifM = e.match(/<cac:WinningParty>\s*<cac:PartyIdentification>\s*<cbc:ID schemeName="NIF">([^<]*)<\/cbc:ID>/);
      const buyerM = e.match(/<cac:PartyName>\s*<cbc:Name>([^<]*)<\/cbc:Name>/);
      const cityM = e.match(/<cac:WinningParty>[\s\S]{0,400}?<cbc:CityName>([^<]*)<\/cbc:CityName>/);
      candidatos.push({
        nif: nifM ? nifM[1].trim() : '',
        nombre: winner,
        titulo: titleM[1].trim(),
        organo: buyerM ? buyerM[1].trim() : '',
        ciudad: cityM ? cityM[1].trim() : ''
      });
    }
  }
  // Dedup por NIF (o por nombre si no hay NIF)
  const porClave = new Map();
  for (const c of candidatos) {
    const clave = c.nif || c.nombre.toLowerCase();
    if (!porClave.has(clave)) porClave.set(clave, c);
  }
  return [...porClave.values()];
}

// ---- 3. Resolver web de la empresa probando dominios probables ----
function slugify(nombre) {
  return nombre
    .toLowerCase()
    .replace(/\b(s\.?l\.?u?\.?|s\.?a\.?u?\.?|sociedad limitada|sociedad anonima|sociedad an[oó]nima)\b/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
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
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolverWeb(nombreEmpresa) {
  const slug = slugify(nombreEmpresa);
  if (slug.length < 3) return null;
  const candidatos = [`https://www.${slug}.es`, `https://www.${slug}.com`, `https://${slug}.es`, `https://${slug}.com`];
  for (const url of candidatos) {
    const html = await fetchConTimeout(url, 6000);
    if (html && html.length > 200) return { url, html };
  }
  return null;
}

// ---- 4. Sacar email de la web ----
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
const IGNORAR_EXT = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i;
const DOMINIOS_BASURA = ['sentry.io', 'wixpress.com', 'example.com', 'godaddy.com', 'schema.org', 'w3.org'];
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

async function buscarEmailEnWeb(url, html) {
  let dominioSitio = '';
  try { dominioSitio = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
  let emails = limpiarEmails(html.match(EMAIL_RE) || [], dominioSitio);
  if (emails.length) return emails[0];
  const base = new URL(url);
  for (const p of ['contacto', 'contact']) {
    const html2 = await fetchConTimeout(base.origin + '/' + p, 6000);
    if (!html2) continue;
    emails = limpiarEmails(html2.match(EMAIL_RE) || [], dominioSitio);
    if (emails.length) return emails[0];
  }
  return null;
}

// Sugerencia de a quién dirigirse según cómo suena el nombre de la empresa.
// Es una pista para el envío manual, no un dato verificado.
function sugerirPuesto(nombre) {
  const n = nombre.toLowerCase();
  if (/\bslu\b/.test(n)) return 'el administrador único / socio fundador';
  if (/\bsl\b/.test(n) && !/\bgrupo\b|\bholding\b/.test(n)) return 'el gerente o socio';
  if (/\bsa\b|\bgrupo\b|\bholding\b/.test(n)) return 'el responsable comercial o de desarrollo de negocio';
  if (!/\b(sl|sa|slu|sau)\b/.test(n)) return 'la propia persona (autónomo/freelance)';
  return 'el responsable de proyectos o comercial';
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

// ---- 5. Ledger y CRM ----
function cargarVistos() {
  try { return new Set(JSON.parse(fs.readFileSync(VISTOS_PATH, 'utf8'))); } catch (_) { return new Set(); }
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
  const { zipPath, mes } = await descargarZipMasReciente();
  const dirExtraido = descomprimir(zipPath);
  const candidatos = extraerCandidatos(dirExtraido);
  console.log(`Contratos relevantes encontrados en ${mes}: ${candidatos.length}`);

  const vistos = cargarVistos();
  const emailsExistentes = await emailsYaEnCrm();
  const nuevos = candidatos.filter(c => !vistos.has(c.nif || c.nombre.toLowerCase()));
  console.log(`No vistos en meses anteriores: ${nuevos.length}`);

  const listos = [];
  for (const c of nuevos) {
    if (listos.length >= OBJETIVO) break;
    const clave = c.nif || c.nombre.toLowerCase();
    vistos.add(clave);
    const web = await resolverWeb(c.nombre);
    if (!web) continue;
    const email = await buscarEmailEnWeb(web.url, web.html);
    if (!email) continue;
    if (emailsExistentes.has(email) || listos.some(l => l.email === email)) continue;
    if (!(await tieneMx(email))) continue;
    listos.push({ ...c, email, website: web.url });
    console.log(`[${listos.length}/${OBJETIVO}] ${c.nombre} -> ${email} (${web.url})`);
  }
  guardarVistos(vistos);

  if (listos.length === 0) {
    console.log('No se encontraron leads nuevos con web/email resoluble este mes. No se toca el CRM.');
    return;
  }

  const filtroBorrado = new URLSearchParams({
    campana_id: 'is.null',
    estado: 'eq.nuevo',
    notas: 'like.Fuente: Licitación pública*'
  });
  const borrados = await sb(`leads?${filtroBorrado}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  console.log(`Lote anterior de licitaciones sin revisar borrado: ${(borrados || []).length} leads.`);

  const paraImportar = listos.map(l => ({
    nombre: l.nombre,
    email: l.email,
    ciudad: l.ciudad || '',
    origen: 'outbound',
    estado: 'nuevo',
    toque: 0,
    segmento: 'web',
    campana_id: null,
    notas: `Fuente: Licitación pública — ENVÍO MANUAL, no mover a campaña. Ganó "${l.titulo.slice(0, 120)}" de ${l.organo}. Dirigirse a: ${sugerirPuesto(l.nombre)}.`
  }));
  await sb('leads', { method: 'POST', body: JSON.stringify(paraImportar) });
  console.log(`Importados ${paraImportar.length} leads nuevos de licitaciones públicas, sin campaña, listos para revisar.`);
}

main().catch(err => {
  console.error('Error general:', err);
  process.exit(1);
});
