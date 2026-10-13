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

const plantillasWeb = [
  { asunto: d => `¿Te encuentran tus clientes en Google, ${d.nombre}?`,
    cuerpo: d => `Hola ${d.contacto || 'equipo'},

Vi ${d.nombre} en Google Maps — se nota que el negocio funciona bien. Pero no encontré una web donde la gente pueda ver horarios, servicios o reservar sin llamar.

Ayudo a negocios de ${d.ciudad} a tener una web sencilla y profesional en pocos días, pensada para traer más clientes, no solo para "estar en internet".

¿Te va bien una llamada de 10 minutos esta semana para ver si encaja?

Un saludo,
Ignacio — Klyrex
Si prefieres no recibir más correos, respóndeme con "baja" y no te escribo más.` },
  { asunto: d => `Re: ¿Te encuentran tus clientes en Google, ${d.nombre}?`,
    cuerpo: d => `Hola ${d.contacto || 'equipo'}, te escribo de nuevo por si el correo anterior se perdió.

Muchos negocios como el tuyo pierden clientes simplemente porque, al buscarlos, la competencia sí aparece con web y ellos no. Es un cambio rápido y con resultado visible desde el primer mes.

¿Hay algún día esta semana que te venga bien para hablar 10 minutos?

Ignacio — Klyrex` },
  { asunto: d => `Último mensaje, ${d.nombre}`,
    cuerpo: d => `Hola ${d.contacto || 'equipo'}, no quiero ser pesado — este es el último correo que te envío por ahora.

Si en algún momento te interesa tener una web para ${d.nombre}, aquí me tienes.

Un saludo,
Ignacio — Klyrex` }
];

const plantillasAuto = [
  { asunto: d => `¿Cuántas horas a la semana se van en tareas repetitivas en ${d.nombre}?`,
    cuerpo: d => `Hola ${d.contacto || 'equipo'},

Trabajo con empresas de ${d.ciudad} ayudándolas a automatizar tareas que hoy se hacen a mano (pedidos, facturas, seguimiento de clientes...), liberando horas del equipo sin cambiar las herramientas que ya usáis.

¿Tenéis 15 minutos esta semana para ver si hay algo automatizable en ${d.nombre}? Sin compromiso.

Ignacio — Klyrex
Si no es de tu interés, respóndeme "baja" y no insisto más.` },
  { asunto: () => `Un ejemplo rápido`,
    cuerpo: d => `Hola ${d.contacto || 'equipo'}, te doy un ejemplo concreto: una empresa similar a ${d.nombre} redujo el tiempo de gestión de pedidos de 2 horas diarias a 15 minutos automatizando solo esa parte.

¿Vemos si algo parecido aplica en vuestro caso? 15 minutos, sin compromiso.

Ignacio — Klyrex` },
  { asunto: d => `Cierro el tema por ahora, ${d.nombre}`,
    cuerpo: d => `Hola ${d.contacto || 'equipo'}, dejo de insistir con esto — si en el futuro os interesa revisar procesos que se puedan automatizar, aquí me tenéis.

Un saludo,
Ignacio — Klyrex` }
];

const INTERVALOS = [0, 4, 5]; // días de espera antes del toque 1, 2, 3

function elegibles(rows) {
  const hoy = new Date();
  const out = [];
  for (const d of rows) {
    const estado = (d.estado || '').toLowerCase();
    if (['baja', 'respondido', 'ganado', 'perdido'].includes(estado)) continue;
    if (!d.email) continue;

    const toque = Number(d.toque || 0);
    if (toque >= 3) continue;

    if (toque > 0 && d.fecha_ultimo_envio) {
      const ultimo = new Date(d.fecha_ultimo_envio);
      const dias = (hoy - ultimo) / (1000 * 60 * 60 * 24);
      if (dias < INTERVALOS[toque]) continue;
    }
    out.push(d);
  }
  return out;
}

async function leerLeadsPendientes() {
  const params = new URLSearchParams({
    select: '*',
    estado: 'not.in.(baja,respondido,ganado,perdido)',
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

function construirMensaje(d) {
  const toque = Number(d.toque || 0);
  const set = d.segmento === 'web' ? plantillasWeb : plantillasAuto;
  const plantilla = set[toque];
  return {
    subject: plantilla.asunto(d),
    body: plantilla.cuerpo(d)
  };
}

async function main() {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  const todos = await leerLeadsPendientes();
  const pendientes = elegibles(todos);
  console.log(`Leads totales no cerrados: ${todos.length}. Pendientes de envío hoy: ${pendientes.length}.`);

  for (const lead of pendientes) {
    const { subject, body } = construirMensaje(lead);
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
