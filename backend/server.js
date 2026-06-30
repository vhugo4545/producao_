require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

// ── Mongoose ────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('[db] MongoDB conectado');
    await seedUsuarios().catch(err => console.error('[seed] Erro:', err.message));
  })
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

const comentarioSchema = new mongoose.Schema({
  text:     { type: String, required: true, maxlength: 2000 },
  ts:       { type: Number, required: true },
  userName: { type: String, maxlength: 64, default: '' },
}, { _id: false });

const producaoSchema = new mongoose.Schema({
  key:        { type: String, required: true, unique: true, maxlength: 512 },
  etapas:     { type: [etapaSchema],    default: [] },
  obs:        { type: [obsSchema],      default: [] },
  comentarios:{ type: [comentarioSchema], default: [] },
}, { timestamps: true });

const Producao = mongoose.model('Producao', producaoSchema);

// ── Schema ProposalCache ─────────────────────────────────────
// Armazena snapshot das propostas ativas (com numeroPedido)
// TTL de 2h — Mongo apaga automaticamente após esse tempo
const proposalCacheSchema = new mongoose.Schema({
  proposalId:   { type: String, required: true, unique: true, maxlength: 64 },
  numeroPedido: { type: String, maxlength: 64, default: '' },
  data:         { type: mongoose.Schema.Types.Mixed, required: true },
  syncedAt:     { type: Date, default: Date.now },
}, { timestamps: true });
proposalCacheSchema.index({ syncedAt: 1 }, { expireAfterSeconds: 7200 }); // TTL 2h
const ProposalCache = mongoose.model('ProposalCache', proposalCacheSchema);

// ── Schema OperacaoAvulsa ────────────────────────────────────
const operacaoAvulsaSchema = new mongoose.Schema({
  titulo:       { type: String, required: true, maxlength: 256 },
  descricao:    { type: String, maxlength: 1000, default: '' },
  assignedTo:   { type: String, required: true, maxlength: 64 },
  createdBy:    { type: String, required: true, maxlength: 64 },
  state:        { type: String, default: 'pending', maxlength: 20 },
  baseElapsed:  { type: Number, default: 0, min: 0 },
  startAt:      { type: Number, default: null },
  firstStartAt: { type: Number, default: null },
  endAt:        { type: Number, default: null },
}, { timestamps: true });
const OperacaoAvulsa = mongoose.model('OperacaoAvulsa', operacaoAvulsaSchema);

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

// ── Schema Usuario ───────────────────────────────────────────
const usuarioSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true, maxlength: 64 },
  nome:         { type: String, required: true, maxlength: 128 },
  apelido:      { type: String, maxlength: 64, default: '' },
  cargo:        { type: String, maxlength: 128, default: '' },
  setor:        { type: String, maxlength: 64, default: '' },
  role:         { type: String, enum: ['gestor', 'operador'], default: 'operador' },
  passwordHash: { type: String, required: true },
  firstAccess:  { type: Boolean, default: true },
  ativo:        { type: Boolean, default: true },
}, { timestamps: true });
const Usuario = mongoose.model('Usuario', usuarioSchema);

// ── Schema Sessao ────────────────────────────────────────────
const sessaoSchema = new mongoose.Schema({
  token:     { type: String, required: true, unique: true },
  userId:    { type: String, required: true, maxlength: 64 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
sessaoSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-delete
sessaoSchema.index({ userId: 1 });
const Sessao = mongoose.model('Sessao', sessaoSchema);

// ── Seed de usuários iniciais ─────────────────────────────────
const USUARIOS_INICIAIS = [
  {id:'luizao',  nome:'Luiz Fernando Lima',             apelido:'Luizão',  cargo:'Coordenador de Produção',    setor:'Coordenação', role:'gestor'},
  {id:'davidson',nome:'Davidson Junio Pereira Maciel',  apelido:'',        cargo:'Serralheiro Montador',        setor:'Serralheria', role:'operador'},
  {id:'dionata', nome:'Dionata Alan Silva Costa',        apelido:'',        cargo:'Serralheiro Montador I',      setor:'Serralheria', role:'operador'},
  {id:'ednaldo', nome:'Ednaldo Gomes Filho',             apelido:'',        cargo:'Serralheiro Montador III',    setor:'Serralheria', role:'operador'},
  {id:'erivaldo',nome:'Erivaldo Amaro de Almeida',      apelido:'',        cargo:'Serralheiro Montador III',    setor:'Serralheria', role:'operador'},
  {id:'leonardo',nome:'Leonardo Sousa Oliveira',         apelido:'',        cargo:'Serralheiro Montador III',    setor:'Serralheria', role:'operador'},
  {id:'roberto', nome:'Roberto Martins do Nascimento',  apelido:'',        cargo:'Serralheiro Montador',        setor:'Serralheria', role:'operador'},
  {id:'rodrigo_bc',nome:'Rodrigo Brito Cardoso',        apelido:'',        cargo:'Serralheiro Montador III',    setor:'Serralheria', role:'operador'},
  {id:'ronan',   nome:'Ronan Gomes de Souza Lima',      apelido:'',        cargo:'Serralheiro Montador',        setor:'Serralheria', role:'operador'},
  {id:'sebastiao',nome:'Sebastião dos Reis de Matos',   apelido:'',        cargo:'Serralheiro Montador III',    setor:'Serralheria', role:'operador'},
  {id:'matheus', nome:'Matheus Henrique Souza Braga',   apelido:'',        cargo:'Ajudante de Serralheiro',     setor:'Serralheria', role:'operador'},
  {id:'osvaldo', nome:'Osvaldo Paura Oliveira',          apelido:'',        cargo:'Ajudante de Serralheiro',     setor:'Serralheria', role:'operador'},
  {id:'gilmar',  nome:'José Gilmar Pinheiro',            apelido:'',        cargo:'Polidor Instrutor',           setor:'Polimento',   role:'operador'},
  {id:'fernando',nome:'Fernando Pereira de Souza Junior',apelido:'',        cargo:'Polidor 2',                   setor:'Polimento',   role:'operador'},
  {id:'sergio',  nome:'Sergio Ricardo Pio',              apelido:'',        cargo:'Polidor 2',                   setor:'Polimento',   role:'operador'},
  {id:'jose_carlos',nome:'José Carlos Soares da Cruz',  apelido:'',        cargo:'Instalador Externo',          setor:'Instalação',  role:'operador'},
  {id:'rodrigo_ns', nome:'Rodrigo Nobre dos Santos',    apelido:'',        cargo:'Torneiro',                    setor:'Torneiro',    role:'operador'},
];

async function seedUsuarios() {
  // Remove índice legado de versão anterior (email_1 único que conflita)
  try { await mongoose.connection.collection('usuarios').dropIndex('email_1'); } catch (_) {}
  const defaultHash = await bcrypt.hash('Senha123456', 10);
  const ops = USUARIOS_INICIAIS.map(u => ({
    updateOne: {
      filter: { id: u.id },
      update: { $setOnInsert: { ...u, passwordHash: defaultHash, firstAccess: true, ativo: true } },
      upsert: true,
    }
  }));
  await Usuario.bulkWrite(ops, { ordered: false });
  console.log('[seed] Usuários verificados');
}

// ── Auth middleware ───────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const sessao = await Sessao.findOne({ token }).lean();
    if (!sessao || sessao.expiresAt < new Date()) {
      if (sessao) await Sessao.deleteOne({ token });
      return res.status(401).json({ error: 'Sessão expirada' });
    }
    const user = await Usuario.findOne({ id: sessao.userId, ativo: true }, '-passwordHash -__v').lean();
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Erro de autenticação' });
  }
}

function requireGestor(req, res, next) {
  if (req.user?.role !== 'gestor') return res.status(403).json({ error: 'Acesso restrito ao gestor' });
  next();
}

// ── POST /api/auth/login ──────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { userId, senha } = req.body;
  if (!userId || !senha) return res.status(400).json({ error: 'userId e senha obrigatórios' });
  try {
    const user = await Usuario.findOne({ id: String(userId).slice(0, 64), ativo: true }).lean();
    if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    const ok = await bcrypt.compare(senha, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias
    await Sessao.create({ token, userId: user.id, expiresAt });
    const { passwordHash, ...pub } = user;
    res.json({ ok: true, token, user: pub, firstAccess: user.firstAccess });
  } catch (e) {
    console.error('[POST /api/auth/login]', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── GET /api/auth/me — valida token e retorna usuário atual ──
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ── POST /api/auth/logout ─────────────────────────────────────
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  await Sessao.deleteOne({ token });
  res.json({ ok: true });
});

// ── POST /api/auth/change-password ───────────────────────────
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres' });
  try {
    const user = await Usuario.findOne({ id: req.user.id });
    const ok = await bcrypt.compare(senhaAtual, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await Usuario.updateOne({ id: req.user.id }, { passwordHash: hash, firstAccess: false });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/auth/change-password]', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── GET /api/users — lista usuários (gestor) ──────────────────
app.get('/api/users', requireAuth, requireGestor, async (_req, res) => {
  try {
    const users = await Usuario.find({}, '-passwordHash -__v').sort({ setor: 1, nome: 1 }).lean();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── POST /api/users — cria usuário (gestor) ───────────────────
app.post('/api/users', requireAuth, requireGestor, async (req, res) => {
  const { id, nome, apelido, cargo, setor, role } = req.body;
  if (!id || !nome) return res.status(400).json({ error: 'id e nome obrigatórios' });
  if (!/^[a-z0-9_]{2,32}$/.test(id)) return res.status(400).json({ error: 'id inválido (use letras minúsculas, números e _)' });
  try {
    const hash = await bcrypt.hash('Senha123456', 10);
    const user = await Usuario.create({
      id: id.slice(0, 64), nome: nome.slice(0, 128),
      apelido: (apelido || '').slice(0, 64),
      cargo: (cargo || '').slice(0, 128),
      setor: (setor || '').slice(0, 64),
      role: role === 'gestor' ? 'gestor' : 'operador',
      passwordHash: hash, firstAccess: true, ativo: true,
    });
    const { passwordHash, __v, ...pub } = user.toObject();
    res.json({ ok: true, user: pub });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'ID já existe' });
    console.error('[POST /api/users]', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── PUT /api/users/:id — atualiza usuário (gestor) ───────────
app.put('/api/users/:id', requireAuth, requireGestor, async (req, res) => {
  const { nome, apelido, cargo, setor, role, ativo } = req.body;
  try {
    const user = await Usuario.findOneAndUpdate(
      { id: req.params.id },
      { $set: { nome, apelido, cargo, setor, role, ativo } },
      { new: true, projection: '-passwordHash -__v' }
    ).lean();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── POST /api/users/:id/reset-password — reset senha (gestor) ─
app.post('/api/users/:id/reset-password', requireAuth, requireGestor, async (req, res) => {
  const { novaSenha } = req.body;
  const senha = (novaSenha || 'Senha123456').trim();
  if (senha.length < 6) return res.status(400).json({ error: 'Senha muito curta (mín. 6 caracteres)' });
  try {
    const hash = await bcrypt.hash(senha, 10);
    const r = await Usuario.updateOne({ id: req.params.id }, { passwordHash: hash, firstAccess: true });
    if (!r.matchedCount) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── DELETE /api/producao/all — limpa todas demandas (gestor) ──
app.delete('/api/producao/all', requireAuth, requireGestor, async (_req, res) => {
  try {
    const r = await Producao.deleteMany({});
    console.log('[admin] Producao limpo —', r.deletedCount, 'documentos removidos');
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) {
    console.error('[DELETE /api/producao/all]', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

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

// GET /api/producao/updates?since=<ms> — só docs atualizados após o timestamp
// Usado pelo polling incremental do frontend (evita baixar tudo a cada 20s)
app.get('/api/producao/updates', async (req, res) => {
  const since = Number(req.query.since) || 0;
  try {
    const filter = since > 0 ? { updatedAt: { $gt: new Date(since) } } : {};
    const docs = await Producao.find(filter, '-__v').lean();
    res.json(docs);
  } catch (err) {
    console.error('[GET /api/producao/updates]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/producao/:key — busca um documento
app.get('/api/producao/:key', async (req, res) => {
  const key = req.params.key; // Express já decodifica req.params uma vez; não decodificar novamente
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
  const key = req.params.key;
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

// GET /api/producao/:key/comentarios
app.get('/api/producao/:key/comentarios', async (req, res) => {
  const key = req.params.key;
  if (!validateKey(key)) return res.status(400).json({ error: 'Chave inválida' });
  try {
    const doc = await Producao.findOne({ key }, 'comentarios').lean();
    res.json(doc?.comentarios || []);
  } catch (err) {
    console.error('[GET comentarios]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/producao/:key/comentarios
app.post('/api/producao/:key/comentarios', async (req, res) => {
  const key = req.params.key;
  if (!validateKey(key)) return res.status(400).json({ error: 'Chave inválida' });
  const { text, userName } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Texto obrigatório' });
  const comentario = {
    text: text.trim().slice(0, 2000),
    ts: Date.now(),
    userName: (userName || '').toString().slice(0, 64),
  };
  try {
    await Producao.findOneAndUpdate(
      { key },
      { $push: { comentarios: comentario } },
      { upsert: true, new: true, runValidators: true }
    );
    res.status(201).json(comentario);
  } catch (err) {
    console.error('[POST comentarios]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/producao/batch — upsert de múltiplos documentos em uma única requisição
app.post('/api/producao/batch', express.json({ limit: '512kb' }), async (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Array de items obrigatório' });

  const ops = items
    .filter(item => validateKey(item.key))
    .map(item => ({
      updateOne: {
        filter: { key: item.key },
        update: { $set: { etapas: sanitizeEtapas(item.etapas), obs: sanitizeObs(item.obs || []) } },
        upsert: true,
      }
    }));

  if (!ops.length) return res.status(400).json({ error: 'Nenhuma chave válida' });

  try {
    await Producao.bulkWrite(ops, { ordered: false });
    res.json({ ok: true, saved: ops.length });
  } catch (err) {
    console.error('[POST /api/producao/batch]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// DELETE /api/producao/:key
app.delete('/api/producao/:key', async (req, res) => {
  const key = req.params.key;
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

// ── Rotas ProposalCache ──────────────────────────────────────

// GET /api/proposals-cache
// Retorna todas as propostas ativas cacheadas no nosso MongoDB
app.get('/api/proposals-cache', async (_req, res) => {
  try {
    const docs = await ProposalCache.find({}, 'data -_id').lean();
    res.json(docs.map(d => d.data));
  } catch (err) {
    console.error('[GET /api/proposals-cache]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/proposals-cache/sync
// Recebe lote de propostas do frontend e salva no cache
// Aceita até 500kb para comportar ~200 propostas
app.post('/api/proposals-cache/sync', express.json({ limit: '500kb' }), async (req, res) => {
  const proposals = req.body?.proposals;
  if (!Array.isArray(proposals) || proposals.length === 0)
    return res.status(400).json({ error: 'Array de propostas obrigatório' });

  try {
    const ops = proposals.map(p => ({
      updateOne: {
        filter: { proposalId: String(p._id).slice(0, 64) },
        update: {
          $set: {
            proposalId:   String(p._id).slice(0, 64),
            numeroPedido: (p.numeroPedido || p.camposFormulario?.numeroPedido || '').toString().slice(0, 64),
            data:         p,
            syncedAt:     new Date(),
          }
        },
        upsert: true,
      }
    }));
    await ProposalCache.bulkWrite(ops, { ordered: false });
    res.json({ ok: true, synced: proposals.length });
  } catch (err) {
    console.error('[POST /api/proposals-cache/sync]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/user-context/:userId
// Retorna os proposalIds onde este usuário tem etapas atribuídas
app.get('/api/user-context/:userId', async (req, res) => {
  const userId = req.params.userId?.slice(0, 64);
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });
  try {
    const docs = await Producao.find(
      { 'etapas.assignedTo': userId },
      'key -_id'
    ).lean();
    const proposalIds = [...new Set(docs.map(d => d.key.split('__')[0]).filter(Boolean))];
    res.json({ userId, proposalIds });
  } catch (err) {
    console.error('[GET /api/user-context]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/operator-context/:userId
// Endpoint de fast-load para operadores: retorna em UMA chamada
//   • docs de produção com etapas ativas atribuídas ao usuário
//   • proposals correspondentes do cache do servidor
// Chamado logo após o login do operador para mostrar tarefas em < 500ms
app.get('/api/operator-context/:userId', async (req, res) => {
  const userId = req.params.userId?.slice(0, 64);
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });
  try {
    // 1. Docs de produção onde o usuário tem etapa pendente/ativa/pausada
    const producaoDocs = await Producao.find(
      { etapas: { $elemMatch: { assignedTo: userId, state: { $in: ['pending', 'active', 'paused'] } } } },
      '-__v'
    ).lean();

    // 2. proposalIds únicos extraídos das keys
    const proposalIds = [...new Set(producaoDocs.map(d => d.key.split('__')[0]).filter(Boolean))];

    // 3. Propostas do cache (paralelo ao passo 1 para máxima velocidade)
    const cachedProposals = proposalIds.length
      ? await ProposalCache.find({ proposalId: { $in: proposalIds } }, 'data -_id').lean()
      : [];

    res.json({
      producao:  producaoDocs,
      proposals: cachedProposals.map(d => d.data),
    });
  } catch (err) {
    console.error('[GET /api/operator-context]', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── Operações Avulsas ────────────────────────────────────────
app.get('/api/operacoes-avulsas', async (_req, res) => {
  try { res.json(await OperacaoAvulsa.find({}, '-__v').sort({ createdAt: -1 }).lean()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operacoes-avulsas', requireAuth, requireGestor, async (req, res) => {
  const { titulo, descricao, assignedTo } = req.body;
  if (!titulo?.trim() || !assignedTo) return res.status(400).json({ error: 'titulo e assignedTo obrigatórios' });
  try {
    const op = await OperacaoAvulsa.create({ titulo: titulo.trim(), descricao: descricao?.trim() || '', assignedTo, createdBy: req.userId });
    res.status(201).json(op);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/operacoes-avulsas/:id', async (req, res) => {
  const allowed = ['state','baseElapsed','startAt','firstStartAt','endAt','titulo','descricao','assignedTo'];
  const upd = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) upd[k] = req.body[k]; });
  try {
    const doc = await OperacaoAvulsa.findByIdAndUpdate(req.params.id, { $set: upd }, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/operacoes-avulsas/:id', requireAuth, requireGestor, async (req, res) => {
  try {
    await OperacaoAvulsa.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Proxy: GET /api/propostas — repassa para a API Kommo ─────
const KOMMO_API_BASE = process.env.KOMMO_API_BASE || 'https://ulhoa-0a02024d350a.herokuapp.com';
app.get('/api/propostas', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const url = `${KOMMO_API_BASE}/api/propostas${qs ? '?' + qs : ''}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (err) {
    console.error('[proxy /api/propostas]', err.message);
    res.status(502).json({ error: 'Erro ao buscar propostas: ' + err.message });
  }
});

// ── Frontend estático ────────────────────────────────────────
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC, { etag: false, maxAge: 0 }));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[server] Rodando na porta ${PORT}`));
