const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const GMAIL_FROM_ADDRESS = process.env.GMAIL_FROM_ADDRESS || GMAIL_USER;

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY, GMAIL_USER, GMAIL_APP_PASSWORD })) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
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

function rellenarPlantilla(texto, lead) {
  return String(texto || '')
    .replace(/\{negocio\}/g, lead.nombre || 'tu negocio')
    .replace(/\{contacto\}/g, lead.contacto || 'equipo')
    .replace(/\{ciudad\}/g, lead.ciudad || 'tu zona');
}

function elegibles(leads, campanasPorId) {
  const hoy = new Date();
  const out = [];
  for (const d of leads) {
    if (!d.email) continue;
    const campana = campanasPorId.get(d.campana_id);
    if (!campana) continue;

    const toque = Number(d.toque || 0);
    const siguienteToque = campana.campana_toques[toque];
    if (!siguienteToque) continue;

    if (toque > 0 && d.fecha_ultimo_envio) {
      const ultimo = new Date(d.fecha_ultimo_envio);
      const dias = (hoy - ultimo) / (1000 * 60 * 60 * 24);
      if (dias < siguienteToque.espera_dias) continue;
    }
    out.push({ lead: d, campana, toqueActual: siguienteToque });
  }
  return out;
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
  const pendientes = elegibles(todos, campanasPorId);
  console.log(`Leads totales no cerrados con campaña: ${todos.length}. Pendientes de envío hoy: ${pendientes.length}.`);

  for (const { lead, toqueActual } of pendientes) {
    const subject = rellenarPlantilla(toqueActual.asunto, lead);
    const body = rellenarPlantilla(toqueActual.cuerpo, lead);
    try {
      await transporter.sendMail({
        from: `"Ignacio - Klyrex" <${GMAIL_FROM_ADDRESS}>`,
        to: lead.email,
        subject,
        text: body
      });
      const toque = Number(lead.toque || 0);
      await actualizarLead(lead.id, {
        estado: 'Contactado',
        toque: toque + 1,
        fecha_ultimo_envio: new Date().toISOString().slice(0, 10)
      });
      console.log(`Enviado a ${lead.email} (${lead.nombre}) - toque ${toque + 1}`);
    } catch (err) {
      console.error(`Fallo con ${lead.email} (${lead.nombre}):`, err.message);
    }
  }
}

main().catch(err => {
  console.error('Error general:', err);
  process.exit(1);
});
