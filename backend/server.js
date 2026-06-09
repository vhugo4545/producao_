require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '256kb' })); // rejeita payloads gigantes

// ── Mongoose ────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('[db] MongoDB conectado'))
  .catch(err => { console.error('[db] Falha na conexão:', err.message); process.exit(1); });

// ── Schemas ─────────────────────────────────────────────────
const etapaSchema = new mongoose.Schema({
  state:        { type: String, default: 'idle', maxlength: 20 },
  baseElapsed:  { type: Number, default: 0,    min: 0, max: 99999999 },
  startAt:      { type: Number, default: null },
  firstStartAt: { type: Number, default: null },
  endAt:        { type: Number, default: null },
  assignedTo:   { type: String, default: null, maxlength: 64 },
}, { _id: false });

const obsSchema = new mongoose.Schema({
  idx:  { type: Number, required: true, min: 0, max: 63 },
  text: { type: String, maxlength: 2000 },
}, { _id: false });

const producaoSchema = new mongoose.Schema({
  key:    { type: String, required: true, unique: true, maxlength: 512 },
  etapas: { type: [etapaSchema], default: [] },
  obs:    { type: [obsSchema],   default: [] },
}, { timestamps: true });

const Producao = mongoose.model('Producao', producaoSchema);

// ── Schema FilaProducao ──────────────────────────────────────
const filaProducaoSchema = new mongoose.Schema({
  lead_id:          { type: Number, required: true, unique: true },
  numero_pedido:    { type: String, default: null, maxlength: 64 },
  numero_orcamento: { type: String, default: null, maxlength: 64 },
  referencia:       { type: String, required: true, maxlength: 128 },
  evento:           { type: String, default: 'supervisor_producao', maxlength: 64 },
  entrou_em:        { type: Date,   default: Date.now },
}, { timestamps: true });

const FilaProducao = mongoose.model('FilaProducao', filaProducaoSchema);

// ── POST /api/fila-producao — recebe notificação do Kommo ────
app.post('/api/fila-producao', async (req, res) => {
  const { evento, lead_id, numero_pedido, numero_orcamento, referencia } = req.body;

  if (!lead_id || !referencia) {
    return res.status(400).json({ error: 'lead_id e referencia são obrigatórios' });
  }

  try {
    const doc = await FilaProducao.findOneAndUpdate(
      { lead_id: Number(lead_id) },
      {
        $set: {
          evento:           evento           || 'supervisor_producao',
          numero_pedido:    numero_pedido    || null,
          numero_orcamento: numero_orcamento || null,
          referencia:       String(referencia).slice(0, 128),
          entrou_em:        new Date(),
        },
      },
      { upsert: true, new: true, runValidators: true }
    );

    console.log('[FILA] ✅ Lead [' + lead_id + '] registrado — ref: ' + referencia);
    res.status(201).json({ ok: true, doc });
  } catch (err) {
    console.error('[POST /api/fila-producao]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── GET /api/fila-producao — lista todos ─────────────────────
app.get('/api/fila-producao', async (_req, res) => {
  try {
    const docs = await FilaProducao.find({}, '-__v').sort({ entrou_em: -1 }).lean();
    res.json({ total: docs.length, itens: docs });
  } catch (err) {
    console.error('[GET /api/fila-producao]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── Validação de entrada ─────────────────────────────────────
const MAX_ETAPAS = 64;

function validateKey(key) {
  // Aceita apenas ObjectId__ObjectId__URLencoded (sem injeção de path)
  if (!key || typeof key !== 'string') return false;
  if (key.length > 512) return false;
  if (/[<>"'`\r\n\0]/.test(key)) return false; // bloqueia chars HTML/JS perigosos
  return true;
}

function sanitizeEtapas(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ETAPAS).map(e => ({
    state:        String(e.state        || 'idle').slice(0, 20),
    baseElapsed:  Math.max(0, Math.min(99999999, Number(e.baseElapsed) || 0)),
    startAt:      e.startAt      ? Number(e.startAt)      : null,
    firstStartAt: e.firstStartAt ? Number(e.firstStartAt) : null,
    endAt:        e.endAt        ? Number(e.endAt)         : null,
    assignedTo:   e.assignedTo   ? String(e.assignedTo).slice(0, 64) : null,
  }));
}

function sanitizeObs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ETAPAS).map(o => ({
    idx:  Math.max(0, Math.min(63, Number(o.idx) || 0)),
    text: o.text ? String(o.text).slice(0, 2000) : '',
  })).filter(o => o.text);
}

// ── Rotas ────────────────────────────────────────────────────

// GET /health
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// GET /api/producao — lista todos os documentos
app.get('/api/producao', async (_req, res) => {
  try {
    const docs = await Producao.find({}, '-__v').lean();
    res.json(docs);
  } catch (err) {
    console.error('[GET /api/producao]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/producao/:key — busca um documento
app.get('/api/producao/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!validateKey(key)) return res.status(400).json({ error: 'Chave inválida' });
  try {
    const doc = await Producao.findOne({ key }).lean();
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    res.json(doc);
  } catch (err) {
    console.error('[GET /api/producao/:key]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PUT /api/producao/:key — upsert
app.put('/api/producao/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!validateKey(key)) return res.status(400).json({ error: 'Chave inválida' });

  const etapas = sanitizeEtapas(req.body.etapas);
  const obs    = sanitizeObs(req.body.obs);

  try {
    const doc = await Producao.findOneAndUpdate(
      { key },
      { $set: { etapas, obs } },
      { upsert: true, new: true, runValidators: true }
    );
    res.json(doc);
  } catch (err) {
    console.error('[PUT /api/producao/:key]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// DELETE /api/producao/:key
app.delete('/api/producao/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!validateKey(key)) return res.status(400).json({ error: 'Chave inválida' });
  try {
    await Producao.deleteOne({ key });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/producao/:key]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── Schema Hidden (soft-delete de pedidos e produtos) ────────
const hiddenSchema = new mongoose.Schema({
  type: { type: String, enum: ['pedido', 'produto'], required: true },
  ref:  { type: String, required: true, maxlength: 512 },
}, { timestamps: true });
hiddenSchema.index({ type: 1, ref: 1 }, { unique: true });
const Hidden = mongoose.model('Hidden', hiddenSchema);

// GET /api/hidden — retorna todos os itens ocultos
app.get('/api/hidden', async (_req, res) => {
  try {
    const docs = await Hidden.find({}, 'type ref -_id').lean();
    const pedidos  = docs.filter(d => d.type === 'pedido').map(d => d.ref);
    const produtos = docs.filter(d => d.type === 'produto').map(d => d.ref);
    res.json({ pedidos, produtos });
  } catch (err) {
    console.error('[GET /api/hidden]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/hidden — oculta um item { type, ref }
app.post('/api/hidden', async (req, res) => {
  const { type, ref } = req.body;
  if (!['pedido', 'produto'].includes(type) || !ref || typeof ref !== 'string' || ref.length > 512) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }
  try {
    await Hidden.findOneAndUpdate(
      { type, ref },
      { type, ref },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/hidden]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// DELETE /api/hidden — restaura um item { type, ref }
app.delete('/api/hidden', async (req, res) => {
  const { type, ref } = req.body;
  if (!type || !ref) return res.status(400).json({ error: 'Parâmetros inválidos' });
  try {
    await Hidden.deleteOne({ type, ref });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/hidden]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[server] Rodando na porta ${PORT}`));
