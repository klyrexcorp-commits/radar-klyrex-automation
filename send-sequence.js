const nodemailer = require('nodemailer');
const dns = require('dns').promises;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const GMAIL_FROM_ADDRESS = process.env.GMAIL_FROM_ADDRESS || GMAIL_USER;
const DELAY_MS = Number(process.env.DELAY_MS || 24000);
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 60);

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY, GMAIL_USER, GMAIL_APP_PASSWORD })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function leerCampanas() {
  const params = new URLSearchParams({
    select: '*,campana_toques(*)',
    activa: 'eq.true'
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/campanas?${params}`, {
    headers: { apikey: SUPABASE_SECRET_KEY }
  });
  if (!res.ok) {
    throw new Error(`Error leyendo campañas: HTTP ${res.status} - ${await res.text()}`);
  }
  const campanas = await res.json();
  for (const c of campanas) {
    c.campana_toques.sort((a, b) => a.orden - b.orden);
  }
  return campanas;
}

async function leerLeadsPendientes() {
  const params = new URLSearchParams({
    select: '*',
    estado: 'not.in.(baja,respondido,ganado,perdido)',
    campana_id: 'not.is.null',
    order: 'created_at.asc'
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?${params}`, {
    headers: { apikey: SUPABASE_SECRET_KEY }
  });
  if (!res.ok) {
    throw new Error(`Error leyendo Supabase: HTTP ${res.status} - ${await res.text()}`);
  }
  return res.json();
}

async function actualizarLead(id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    throw new Error(`Error actualizando lead ${id}: HTTP ${res.status} - ${await res.text()}`);
  }
}

async function actualizarEnvioEstado(patch) {
  const body = { ...patch, actualizado_en: new Date().toISOString() };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/envio_estado?id=eq.global`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    console.error(`Aviso: no se pudo actualizar envio_estado: HTTP ${res.status} - ${await res.text()}`);
  }
}

function rellenarPlantilla(texto, lead) {
  const negocio = lead.nombre || 'tu negocio';
  return String(texto || '')
    .replace(/\{negocio\}/g, negocio)
    .replace(/\{contacto\}/g, lead.contacto || ('equipo de ' + negocio))
    .replace(/\{ciudad\}/g, lead.ciudad || 'tu zona');
}

// Elige, para cada lead, el siguiente toque elegible según el orden de la
// campaña, el tiempo de espera y la condición de apertura/respuesta del toque.
function elegibles(leads, campanasPorId) {
  const hoy = new Date();
  const out = [];
  for (const d of leads) {
    if (!d.email) continue;
    const campana = campanasPorId.get(d.campana_id);
    if (!campana) continue;

    const enviados = new Set(d.toques_enviados || []);
    const abierto = !!d.abierto_en;
    const respondido = String(d.estado || '').toLowerCase() === 'respondido';

    let diasDesdeUltimo = Infinity;
    if (d.fecha_ultimo_envio) {
      diasDesdeUltimo = (hoy - new Date(d.fecha_ultimo_envio)) / (1000 * 60 * 60 * 24);
    }

    let elegido = null;
    for (const t of campana.campana_toques) {
      if (enviados.has(t.id)) continue;
      if (diasDesdeUltimo < t.espera_dias) continue;
      if (t.condicion === 'no_abierto_anterior' && abierto) continue;
      if (t.condicion === 'abierto_no_respondido_anterior' && (!abierto || respondido)) continue;
      elegido = t;
      break;
    }
    if (elegido) out.push({ lead: d, campana, toqueActual: elegido });
  }
  return out;
}

async function tieneDominioValido(email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) return false;
  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch (e) {
    return false;
  }
}

function construirHtmlConPixel(cuerpoHtml, leadId, toqueId) {
  const pixelUrl = `${SUPABASE_URL}/functions/v1/track-open?lead=${leadId}&toque=${toqueId}`;
  return cuerpoHtml + `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">`;
}

async function main() {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  const campanas = await leerCampanas();
  const campanasPorId = new Map(campanas.map(c => [c.id, c]));
  console.log(`Campañas activas: ${campanas.length} (${campanas.map(c => `${c.nombre}: ${c.campana_toques.length} toques`).join(', ') || 'ninguna'}).`);

  const todos = await leerLeadsPendientes();
  const elegiblesHoy = elegibles(todos, campanasPorId);
  const pendientes = elegiblesHoy.slice(0, MAX_PER_RUN);
  console.log(`Leads totales no cerrados con campaña: ${todos.length}. Elegibles hoy: ${elegiblesHoy.length}. Tope por ejecución: ${MAX_PER_RUN}. Se enviarán: ${pendientes.length}. Pausa entre envíos: ${DELAY_MS / 1000}s.`);
  if (elegiblesHoy.length > MAX_PER_RUN) {
    console.log(`Quedan ${elegiblesHoy.length - MAX_PER_RUN} pendientes para una próxima ejecución (límite diario para proteger la reputación de la cuenta de Gmail).`);
  }

  await actualizarEnvioEstado({
    en_curso: true,
    enviados: 0,
    total: pendientes.length,
    iniciado_en: new Date().toISOString()
  });

  let enviados = 0;
  try {
    for (const { lead, toqueActual } of pendientes) {
      const dominioValido = await tieneDominioValido(lead.email);
      if (!dominioValido) {
        console.log(`Dominio sin MX, no se envía a ${lead.email} (${lead.nombre}) — marcado como baja`);
        try {
          await actualizarLead(lead.id, {
            estado: 'baja',
            notas: (lead.notas ? lead.notas + ' | ' : '') + 'Email inválido (dominio sin registros MX), excluido automáticamente'
          });
        } catch (err) {
          console.error(`No se pudo marcar baja a ${lead.email}:`, err.message);
        }
        enviados++;
        await actualizarEnvioEstado({ enviados });
        continue;
      }
      const subject = rellenarPlantilla(toqueActual.asunto, lead);
      const cuerpoHtml = rellenarPlantilla(toqueActual.cuerpo, lead);
      const htmlConPixel = construirHtmlConPixel(cuerpoHtml, lead.id, toqueActual.id);
      try {
        await transporter.sendMail({
          from: `"Ignacio - Klyrex" <${GMAIL_FROM_ADDRESS}>`,
          to: lead.email,
          subject,
          html: htmlConPixel
        });
        const toque = Number(lead.toque || 0);
        const toquesEnviados = [...(lead.toques_enviados || []), toqueActual.id];
        await actualizarLead(lead.id, {
          estado: 'Contactado',
          toque: toque + 1,
          toques_enviados: toquesEnviados,
          fecha_ultimo_envio: new Date().toISOString().slice(0, 10)
        });
        console.log(`Enviado a ${lead.email} (${lead.nombre}) - toque ${toque + 1}`);
      } catch (err) {
        console.error(`Fallo con ${lead.email} (${lead.nombre}):`, err.message);
      }
      enviados++;
      await actualizarEnvioEstado({ enviados });
      if (enviados < pendientes.length) {
        await sleep(DELAY_MS);
      }
    }
  } finally {
    await actualizarEnvioEstado({ en_curso: false });
  }
}

main().catch(err => {
  console.error('Error general:', err);
  process.exit(1);
});
