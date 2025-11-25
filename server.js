// =============================================
// Handlers globais pra não derrubar o processo
// =============================================
process.on('uncaughtException', (err) => {
  console.error('🔥 ERRO FATAL (uncaughtException):', err);
});

process.on('unhandledRejection', (err) => {
  console.error('🔥 PROMISE SEM CATCH (unhandledRejection):', err);
});

// =============================================
// Variáveis de ambiente
// =============================================
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// =============================================
// HEALTHCHECK (Railway testa essa rota)
// =============================================
app.get('/', (req, res) => {
  res.status(200).send('Bot Autônomos online 🚗 (versão mínima)');
});

// =============================================
// Helper pra enviar mensagem de texto no WhatsApp
// =============================================
async function sendText(to, text) {
  const url = `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

  try {
    const resp = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.META_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Mensagem enviada:', resp.data);
  } catch (err) {
    console.error(
      '❌ Erro ao enviar mensagem:',
      err.response?.data || err.message || err
    );
  }
}

// =============================================
// WEBHOOK VERIFY (GET) - igual ao painel da Meta
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
// WEBHOOK RECEIVER (POST) - versão simples
// =============================================
app.post('/webhook', async (req, res) => {
  // Meta exige 200 rápido para não reclamar
  res.sendStatus(200);

  console.log('📥 WEBHOOK RECEBIDO:');
  console.log(JSON.stringify(req.body, null, 2));

  const entry = req.body.entry?.[0];
  const change = entry?.changes?.[0];
  const msg = change?.value?.messages?.[0];

  if (!msg) {
    console.log('⚠️ Nenhuma mensagem em change.value.messages');
    return;
  }

  const from = msg.from;
  const type = msg.type;

  try {
    if (type === 'text') {
      const body = msg.text?.body?.trim() || '';
      console.log(`📩 Texto de ${from}: ${body}`);

      await sendText(from, `Recebi sua mensagem: "${body}"`);
      return;
    }

    // Outros tipos de mensagem: só loga
    console.log(`📨 Mensagem do tipo ${type} recebida (não tratada).`);
    await sendText(from, `Recebi uma mensagem do tipo: ${type}. (versão mínima do bot)`);
  } catch (err) {
    console.error('💥 ERRO NO WEBHOOK SIMPLES:', err);
    try {
      await sendText(from, 'Erro ao processar sua mensagem (versão mínima).');
    } catch (_) {}
  }
});

// =============================================
// SERVER LISTEN (Railway / Local)
// =============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 BOT Autônomos rodando na porta ${PORT}`);
});

