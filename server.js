// =============================================
// Carrega variáveis de ambiente (.env local / Railway)
// =============================================
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json());

// =============================================
// HEALTHCHECK (útil pro Railway)
// =============================================
app.get('/', (req, res) => {
  res.status(200).send('Bot Autônomos online 🚗');
});

// =============================================
// BANCO DE DADOS (SQLite)
// =============================================
const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_phone TEXT NOT NULL,
    UNIQUE(name, owner_phone)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    item TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    date TEXT NOT NULL,
    notes TEXT,
    source TEXT,
    FOREIGN KEY(client_id) REFERENCES clients(id)
  )`);
});

// =============================================
// HELPERS
// =============================================
async function sendText(to, text) {
  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.META_TOKEN}`
      }
    }
  );
}

function toCents(v) {
  if (!v) return null;
  const cleaned = (v + '')
    .toLowerCase()
    .replace(/[^0-9,\.]/g, '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

// "Cliente — serviço — valor"  ou  "Cliente; serviço; valor"  ou  "Cliente - serviço - valor"
function parseEntry(text) {
  const sep = text.includes('—')
    ? '—'
    : text.includes(';')
    ? ';'
    : text.includes('-')
    ? '-'
    : null;

  if (sep) {
    const [client, item, val] = text.split(sep).map((s) => s.trim());
    const amount_cents = toCents(val);
    if (client && item && amount_cents != null) {
      return { client, item, amount_cents };
    }
  }

  // fallback simples: pega último número como valor
  const numMatch = text.match(/(\d+[\.,]?\d*)/);
  if (numMatch) {
    const amount_cents = toCents(numMatch[1]);
    const semNumero = text.replace(numMatch[0], '');
    const parts = semNumero
      .split(/[;,\-—]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2 && amount_cents != null) {
      return {
        client: parts[0],
        item: parts.slice(1).join(' '),
        amount_cents
      };
    }
  }

  return null;
}

function ensureClient(owner_phone, name) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM clients WHERE owner_phone=? AND name=?`,
      [owner_phone, name],
      (err, row) => {
        if (err) return reject(err);
        if (row) return resolve(row.id);

        db.run(
          `INSERT INTO clients (name, owner_phone) VALUES (?, ?)`,
          [name, owner_phone],
          function (err2) {
            if (err2) return reject(err2);
            resolve(this.lastID);
          }
        );
      }
    );
  });
}

function addEntry(client_id, item, amount_cents, source = 'text') {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO entries (client_id, item, amount_cents, date, source)
       VALUES (?, ?, ?, ?, ?)`,
      [client_id, item, amount_cents, new Date().toISOString(), source],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function getHistory(owner_phone, client = null) {
  return new Promise((resolve, reject) => {
    let sql = `
      SELECT e.*, c.name AS client
      FROM entries e
      JOIN clients c ON c.id = e.client_id
      WHERE c.owner_phone = ?`;
    const params = [owner_phone];

    if (client) {
      sql += ` AND c.name LIKE ?`;
      params.push(`%${client}%`);
    }

    sql += ` ORDER BY e.date DESC LIMIT 50`;

    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// =============================================
// WEBHOOK VERIFY (GET)
// =============================================
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.VERIFY_TOKEN;

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('✅ Webhook verificado com sucesso');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Falha na verificação do webhook');
  return res.sendStatus(403);
});

// =============================================
// WEBHOOK RECEIVER (POST)
// =============================================
app.post('/webhook', async (req, res) => {
  // Meta exige resposta 200 rápido
  res.sendStatus(200);

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const msg = change?.value?.messages?.[0];

  if (!msg) {
    return;
  }

  const from = msg.from;

  try {
    // ---------------- TEXT ----------------
    if (msg.type === 'text') {
      const body = msg.text.body.trim();
      console.log(`📩 Texto de ${from}: ${body}`);

      // ajuda
      if (/^ajuda$/i.test(body)) {
        await sendText(
          from,
          'Envie: "Cliente — serviço — valor". Ex: "João — troca de óleo — 120".\n' +
            'Comandos: "hist" ou "hist João" para ver o histórico.'
        );
        return;
      }

      // histórico
      if (/^hist/i.test(body)) {
        const client = body.replace(/^hist(órico)?/i, '').trim() || null;
        const rows = await getHistory(from, client);

        if (!rows.length) {
          await sendText(from, 'Sem lançamentos encontrados para esse filtro.');
          return;
        }

        const lines = rows.map(
          (r) =>
            `${dayjs(r.date).format('DD/MM')} · ${r.client} · ${r.item} · R$ ${(
              r.amount_cents / 100
            ).toFixed(2)}`
        );

        const reply = lines.join('\n');
        await sendText(from, reply);
        return;
      }

      // lançamento normal
      const parsed = parseEntry(body);
      if (!parsed) {
        await sendText(
          from,
          'Não entendi. Use algo como:\n"João — troca de óleo — 120"'
        );
        return;
      }

      const clientId = await ensureClient(from, parsed.client);
      await addEntry(clientId, parsed.item, parsed.amount_cents, 'text');
      await sendText(
        from,
        `Lançamento salvo:\n${parsed.client} | ${parsed.item} | R$ ${(
          parsed.amount_cents / 100
        ).toFixed(2)}`
      );
      return;
    }

    // ---------------- AUDIO ----------------
    if (msg.type === 'audio') {
      console.log(`🎧 Áudio recebido de ${from}`);
      await sendText(from, 'Recebi seu áudio, processando...');

      const mediaId = msg.audio.id;

      const mediaInfo = await axios.get(
        `https://graph.facebook.com/v21.0/${mediaId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.META_TOKEN}`
          }
        }
      );

      const mediaUrl = mediaInfo.data.url;

      const audio = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        headers: {
          Authorization: `Bearer ${process.env.META_TOKEN}`
        }
      });

      const form = new FormData();
      form.append('file', Buffer.from(audio.data), {
        filename: 'audio.ogg',
        contentType: 'audio/ogg'
      });
      form.append('model', 'whisper-1');

      const whisper = await axios.post(
        'https://api.openai.com/v1/audio/transcriptions',
        form,
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            ...form.getHeaders()
          }
        }
      );

      const text = whisper.data.text;
      console.log(`🗣️ Transcrição: ${text}`);
      const parsed = parseEntry(text);

      if (!parsed) {
        await sendText(
          from,
          'Não entendi seu áudio. Fale algo como: "Cliente João, troca de óleo, 120 reais".'
        );
        return;
      }

      const clientId = await ensureClient(from, parsed.client);
      await addEntry(clientId, parsed.item, parsed.amount_cents, 'audio');
      await sendText(
        from,
        `Lançamento salvo (áudio):\n${parsed.client} | ${parsed.item} | R$ ${(
          parsed.amount_cents / 100
        ).toFixed(2)}`
      );
      return;
    }

    // outros tipos de mensagem: ignora
    console.log(`📨 Mensagem de tipo ${msg.type} ignorada.`);
    return;
  } catch (err) {
    console.error('💥 ERRO NO WEBHOOK:', err);
    try {
      await sendText(from, 'Erro ao processar sua mensagem. Tente novamente.');
    } catch (_) {}
    return;
  }
});

// =============================================
// SERVER LISTEN (Railway / Local)
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BOT Autônomos rodando na porta ${PORT}`);
});
