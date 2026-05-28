require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ulhoa_producao';

// ── Middlewares ──────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

// ── Mongoose Schemas ─────────────────────────────────────────

const etapaSchema = new mongoose.Schema({
  state:        { type: String, default: 'pending' }, // pending | active | paused | done
  baseElapsed:  { type: Number, default: 0 },         // segundos acumulados
  startAt:      Number,                                // timestamp ms (último início)
  firstStartAt: Number,                                // timestamp ms (primeiro início)
  endAt:        Number,                                // timestamp ms (conclusão)
  assignedTo:   String                                 // userId do operador
}, { _id: false });

const obsSchema = new mongoose.Schema({
  idx:  { type: Number, required: true },   // índice da etapa em ETAPAS[]
  text: { type: String, default: '' }
}, { _id: false });

const producaoSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, index: true },
  // key = `${propId}__${grupoId}__${encodeURIComponent(prodNome)}`
  etapas:    [etapaSchema],
  obs:       [obsSchema],
  updatedAt: { type: Date, default: Date.now }
});

const Producao = mongoose.model('Producao', producaoSchema);

// ── Routes ───────────────────────────────────────────────────

// GET /api/producao  — retorna todos os registros salvos
app.get('/api/producao', async (req, res) => {
  try {
    const docs = await Producao.find({}).lean();
    res.json(docs);
  } catch (e) {
    console.error('[GET /api/producao]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/producao/:key  — retorna um registro específico
app.get('/api/producao/:key', async (req, res) => {
  try {
    const doc = await Producao.findOne({ key: req.params.key }).lean();
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/producao/:key  — upsert (cria ou atualiza) o estado de uma chave
app.put('/api/producao/:key', async (req, res) => {
  try {
    const { etapas = [], obs = [] } = req.body;
    const doc = await Producao.findOneAndUpdate(
      { key: req.params.key },
      { $set: { etapas, obs, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ ok: true, key: doc.key });
  } catch (e) {
    console.error('[PUT /api/producao]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/producao/:key  — remove registro (ex: pedido cancelado)
app.delete('/api/producao/:key', async (req, res) => {
  try {
    await Producao.deleteOne({ key: req.params.key });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health-check
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Mongo + Start ─────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('[mongo] conectado em', MONGO_URI.replace(/:\/\/.*@/, '://***@'));
    app.listen(PORT, () => {
      console.log(`[server] Producao backend rodando em http://localhost:${PORT}`);
    });
  })
  .catch(e => {
    console.error('[mongo] ERRO ao conectar:', e.message);
    process.exit(1);
  });
