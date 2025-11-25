import express from "express";

const app = express();

// Rota simples para testar
app.get("/", (req, res) => {
  res.send("OK - Bot Autônomos ONLINE");
});

// Usa porta dinâmica do Railway OU 3000 local
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 SERVER HELLO WORLD rodando na porta ${PORT}`);
});
