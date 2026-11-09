const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const { ImapFlow } = require('imapflow');

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

// Supabase devuelve como máximo 1000 filas por petición: se lee por páginas.
// Sin esto solo se veían los 1000 leads más antiguos (ya contactados) y los
// recién importados no entraban nunca en la cola de envío.
async function leerLeadsPendientes() {
  const PAGINA = 1000;
  const todos = [];
  for (let offset = 0; ; offset += PAGINA) {
    const params = new URLSearchParams({
      select: '*',
      estado: 'not.in.(baja,respondido,ganado,perdido)',
      campana_id: 'not.is.null',
      order: 'created_at.asc,id.asc',
      limit: String(PAGINA),
      offset: String(offset)
    });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/leads?${params}`, {
      headers: { apikey: SUPABASE_SECRET_KEY }
    });
    if (!res.ok) {
      throw new Error(`Error leyendo Supabase: HTTP ${res.status} - ${await res.text()}`);
    }
    const filas = await res.json();
    todos.push(...filas);
    if (filas.length < PAGINA) break;
  }
  return todos;
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

function asuntoMailto(prefijo, lead) {
  return encodeURIComponent(`${prefijo} - ${lead.nombre || 'lead'}`);
}

// Botones de respuesta de un clic: al pulsarlos el cliente de correo del lead
// abre un nuevo email (From = su propia dirección) dirigido a nosotros, que
// revisarRespuestas() detecta luego por remitente + por el asunto SI/NO/BAJA.
function construirCtaHtml(lead) {
  const mailtoSi = `mailto:${GMAIL_FROM_ADDRESS}?subject=${asuntoMailto('SI', lead)}`;
  const mailtoNo = `mailto:${GMAIL_FROM_ADDRESS}?subject=${asuntoMailto('NO', lead)}`;
  return `<div style="margin:22px 0 4px">` +
    `<a href="${mailtoSi}" style="display:inline-block;background:#1a7f37;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-family:Arial,sans-serif;font-size:14px;margin-right:10px">Sí, cuéntame más</a>` +
    `<a href="${mailtoNo}" style="display:inline-block;background:#6b7280;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-family:Arial,sans-serif;font-size:14px">No, gracias</a>` +
    `</div>`;
}

function construirFooterHtml(lead) {
  const mailtoBaja = `mailto:${GMAIL_FROM_ADDRESS}?subject=${asuntoMailto('BAJA', lead)}`;
  return `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e5e5e5;font-family:Arial,sans-serif;font-size:11px;color:#888888">` +
    `Klyrex · Si no quieres recibir más emails, <a href="${mailtoBaja}" style="color:#888888">haz clic aquí para darte de baja</a>.` +
    `</div>`;
}

function htmlATexto(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function construirHtmlConPixel(cuerpoHtml, leadId, toqueId, lead) {
  const pixelUrl = `${SUPABASE_URL}/functions/v1/track-open?lead=${leadId}&toque=${toqueId}`;
  return cuerpoHtml + construirCtaHtml(lead) + construirFooterHtml(lead) + `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">`;
}

function construirTextoPlano(cuerpoHtml) {
  return htmlATexto(cuerpoHtml) +
    '\n\n¿Te interesa? Responde SI.\n¿No es para vosotros? Responde NO.\n\nPara no recibir más emails, responde BAJA.';
}

// Revisa el inbox de Gmail por IMAP (misma cuenta que envía) buscando
// respuestas de los leads activos de los últimos días. Si el remitente
// coincide con el email de un lead: "BAJA" en el asunto -> estado baja,
// cualquier otra respuesta -> estado respondido. Así no hace falta marcar
// nada a mano y el envío del día ya no vuelve a escribir a quien contestó.
async function revisarRespuestas(leadsActivos) {
  const porEmail = new Map();
  for (const l of leadsActivos) {
    if (l.email) porEmail.set(l.email.toLowerCase(), l);
  }
  if (porEmail.size === 0) return;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false
  });

  let respuestas = 0;
  let bajas = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const desde = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      for await (const msg of client.fetch({ since: desde }, { envelope: true })) {
        const remitente = ((msg.envelope.from && msg.envelope.from[0] && msg.envelope.from[0].address) || '').toLowerCase();
        const lead = porEmail.get(remitente);
        if (!lead) continue;
        const asunto = String(msg.envelope.subject || '');
        if (/^\s*baja\b/i.test(asunto)) {
          await actualizarLead(lead.id, {
            estado: 'baja',
            notas: (lead.notas ? lead.notas + ' | ' : '') + 'Baja solicitada por email'
          });
          bajas++;
        } else if (String(lead.estado || '').toLowerCase() !== 'respondido') {
          await actualizarLead(lead.id, { estado: 'respondido' });
          respuestas++;
        }
      }
    } finally {
      await lock.release();
    }
  } catch (err) {
    console.error('Aviso: no se pudo revisar el inbox por IMAP:', err.message);
  } finally {
    try { await client.logout(); } catch (_) { /* no bloquea el envío */ }
  }
  console.log(`Revisión de inbox: ${respuestas} respuesta(s) nueva(s), ${bajas} baja(s).`);
}

async function main() {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  let campanas = await leerCampanas();
  const CAMPANA_NOMBRE = String(process.env.CAMPANA_NOMBRE || '').trim();
  if (CAMPANA_NOMBRE) {
    const filtradas = campanas.filter(c => c.nombre.trim().toLowerCase() === CAMPANA_NOMBRE.toLowerCase());
    if (filtradas.length === 0) {
      console.error(`No existe ninguna campaña activa llamada "${CAMPANA_NOMBRE}". Campañas activas: ${campanas.map(c => c.nombre).join(', ') || 'ninguna'}.`);
      process.exit(1);
    }
    campanas = filtradas;
    console.log(`Envío puntual: solo para la campaña "${CAMPANA_NOMBRE}".`);
  }
  const campanasPorId = new Map(campanas.map(c => [c.id, c]));
  console.log(`Campañas activas: ${campanas.length} (${campanas.map(c => `${c.nombre}: ${c.campana_toques.length} toques`).join(', ') || 'ninguna'}).`);

  const antesDeRevisar = await leerLeadsPendientes();
  await revisarRespuestas(antesDeRevisar);
  // Se relee tras revisarRespuestas() para que quien acaba de contestar o
  // darse de baja no reciba hoy otro email de la secuencia.
  const todos = await leerLeadsPendientes();
  const elegiblesHoy = elegibles(todos, campanasPorId);
  // Se baraja antes de recortar al tope diario: si no, los leads más
  // antiguos (p. ej. una tanda importada un día antes que otra) acaparan
  // el cupo cada día y los más nuevos nunca llegan a tocarles el turno.
  for (let i = elegiblesHoy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [elegiblesHoy[i], elegiblesHoy[j]] = [elegiblesHoy[j], elegiblesHoy[i]];
  }
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
      const htmlConPixel = construirHtmlConPixel(cuerpoHtml, lead.id, toqueActual.id, lead);
      const textoPlano = construirTextoPlano(cuerpoHtml);
      try {
        await transporter.sendMail({
          from: `"Ignacio - Klyrex" <${GMAIL_FROM_ADDRESS}>`,
          to: lead.email,
          subject,
          html: htmlConPixel,
          text: textoPlano,
          headers: {
            'List-Unsubscribe': `<mailto:${GMAIL_FROM_ADDRESS}?subject=${asuntoMailto('BAJA', lead)}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
          }
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
