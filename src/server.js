'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const database = require('./database');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const db = database;

function categoriaExigeOrcamento(pricingMode, nome = '', nomePai = '') {
  if (pricingMode === 'quote' || pricingMode === 'fixed') {
    return pricingMode === 'quote';
  }

  const normalizar = valor => String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  return [normalizar(nome), normalizar(nomePai)].some(valor => /\bempresas\b|\bsistemas\b|gestao comercial|\bsmartpos\b/.test(valor));
}

app.set('trust proxy', 1);
app.disable('x-powered-by');

if (!process.env.SESSION_SECRET || !process.env.ADMIN_SETUP_KEY) {
  throw new Error('Configure SESSION_SECRET e ADMIN_SETUP_KEY no .env');
}

app.use(helmet());

// Diagnóstico seguro do webhook: registra a chegada da requisição e o status
// final sem registrar corpo, token, segredo ou valor da assinatura.
app.use((req, res, next) => {
  if (req.path !== '/api/webhooks/mercadopago') {
    return next();
  }

  const diagnostico = {
    method: req.method,
    contentType: req.get('content-type') || null,
    contentLength: req.get('content-length') || null,
    hasSignature: Boolean(req.get('x-signature')),
    hasRequestId: Boolean(req.get('x-request-id')),
    hasDataIdQuery: typeof req.query['data.id'] === 'string'
  };

  console.info('Webhook Mercado Pago — requisição recebida.', diagnostico);
  res.on('finish', () => {
    console.info('Webhook Mercado Pago — resposta enviada.', {
      method: req.method,
      status: res.statusCode
    });
  });

  return next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  name: 'vortexgrid.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/'
  }
}));

// --------------------------------------------------
// AUXILIARES
// --------------------------------------------------

function erro(res, status, mensagem) {
  return res.status(status).json({ erro: mensagem });
}

function validarTexto(valor, max = 190) {
  return typeof valor === 'string' &&
    valor.trim().length > 0 &&
    valor.trim().length <= max;
}

function validarEmail(email) {
  return typeof email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function valorMonetario(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 && n <= 999999999;
}

async function autenticado(req, res, next) {
  if (!req.session || !req.session.user) {
    return erro(res, 401, 'Faça login para continuar.');
  }

  try {
    // Revalida o usuário e o perfil no banco para que mudanças de acesso
    // tenham efeito sem depender de um novo login ou esperar a sessão expirar.
    const [rows] = await db.query(
      'SELECT id, name, email, role, active FROM users WHERE id = ? LIMIT 1',
      [req.session.user.id]
    );

    const user = rows[0];

    if (!user || !normalizarBooleano(user.active, false)) {
      return req.session.destroy(() => {
        res.clearCookie('vortexgrid.sid', {
          httpOnly: true,
          sameSite: 'lax',
          secure: 'auto',
          path: '/'
        });
        return erro(res, 401, 'Sua conta está inativa ou não existe mais. Faça login novamente.');
      });
    }

    if (!['admin', 'staff'].includes(user.role)) {
      return erro(res, 403, 'O perfil desta conta não possui permissões válidas.');
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    return next();
  } catch (e) {
    console.error('Erro ao validar sessão:', e.code || e.message || 'erro');
    return erro(res, 503, 'Não foi possível validar seu acesso neste momento.');
  }
}

function somenteAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return erro(res, 403, 'Acesso restrito ao administrador.');
  }

  next();
}

function validarId(valor) {
  const id = Number(valor);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Informações personalizadas vinculadas ao serviço contratado e compartilhadas com o Portal.
let contractedServiceDetailsTableReady;
async function ensureContractedServiceDetailsTable() {
  if (!contractedServiceDetailsTableReady) {
    contractedServiceDetailsTableReady = db.query(`
      CREATE TABLE IF NOT EXISTS contracted_service_details (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        contracted_service_id BIGINT UNSIGNED NOT NULL,
        label VARCHAR(80) NOT NULL,
        value TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_contracted_service_details_service (contracted_service_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(error => {
      contractedServiceDetailsTableReady = null;
      throw error;
    });
  }
  await contractedServiceDetailsTableReady;
}

function validarData(valor, permiteNulo = true) {
  if (valor === null || valor === '') {
    return permiteNulo;
  }

  if (typeof valor !== 'string') {
    return false;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);

  if (!match) {
    return false;
  }

  const ano = Number(match[1]);
  const mes = Number(match[2]);
  const dia = Number(match[3]);

  const data = new Date(Date.UTC(ano, mes - 1, dia));

  return data.getUTCFullYear() === ano &&
    data.getUTCMonth() === mes - 1 &&
    data.getUTCDate() === dia;
}

function validarDadosCliente(body) {
  const name = body.name;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const document = typeof body.document === 'string'
    ? body.document.trim()
    : '';
  const notes = typeof body.notes === 'string' ? body.notes : '';

  if (!validarTexto(name, 160)) {
    return {
      erro: 'Informe o nome do cliente (até 160 caracteres).'
    };
  }

  if (email && (!validarEmail(email) || email.length > 190)) {
    return {
      erro: 'Informe um e-mail válido com até 190 caracteres.'
    };
  }

  if (phone.length > 40) {
    return { erro: 'O telefone deve ter até 40 caracteres.' };
  }

  if (document.length > 30) {
    return { erro: 'O documento deve ter até 30 caracteres.' };
  }

  if (notes.length > 5000) {
    return { erro: 'As observações devem ter até 5000 caracteres.' };
  }

  return {
    dados: {
      name: name.trim(),
      email: email ? email.toLowerCase() : null,
      phone: phone || null,
      document: document || null,
      notes: notes.trim() || null
    }
  };
}

// Converte valores booleanos enviados pelo frontend ou recebidos do banco.
function normalizarBooleano(valor, padrao = false) {
  if (valor === undefined || valor === null || valor === '') {
    return padrao;
  }

  return valor === true ||
    valor === 1 ||
    valor === '1' ||
    valor === 'true';
}

// Vincula pedidos ao invoice gerado pelo checkout atual do Portal.
// A descrição contém os IDs dos pedidos; só vincula quando cliente,
// IDs e soma dos valores conferem exatamente com a fatura.
async function vincularSolicitacoesDaFatura(conn, invoiceId) {
  const [invoiceRows] = await conn.query(
    'SELECT id, client_id, amount, description FROM invoices WHERE id = ? FOR UPDATE',
    [invoiceId]
  );
  const invoice = invoiceRows[0];
  if (!invoice) return [];

  let [linkedOrders] = await conn.query(
    `SELECT id, client_id, service_id, description_snapshot, amount_snapshot,
            billing_cycle_snapshot, approval_status, payment_status,
            contracted_service_id
     FROM service_orders
     WHERE invoice_id = ?
     ORDER BY id
     FOR UPDATE`,
    [invoiceId]
  );
  if (linkedOrders.length) return linkedOrders;

  const description = String(invoice.description || '');
  if (!description.startsWith('Pedido VortexGrid:')) return [];

  const ids = [...description.matchAll(/#(\d+)/g)].map(match => Number(match[1]));
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length || uniqueIds.length > 20 || uniqueIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    return [];
  }

  const placeholders = uniqueIds.map(() => '?').join(',');
  const [candidateOrders] = await conn.query(
    `SELECT id, client_id, service_id, description_snapshot, amount_snapshot,
            billing_cycle_snapshot, approval_status, payment_status,
            contracted_service_id, invoice_id
     FROM service_orders
     WHERE client_id = ? AND id IN (${placeholders})
     ORDER BY id
     FOR UPDATE`,
    [invoice.client_id, ...uniqueIds]
  );

  if (candidateOrders.length !== uniqueIds.length) return [];
  if (candidateOrders.some(order => order.invoice_id && Number(order.invoice_id) !== Number(invoiceId))) {
    return [];
  }

  const totalOrders = candidateOrders.reduce(
    (total, order) => total + Math.round(Number(order.amount_snapshot || 0) * 100),
    0
  );
  if (totalOrders !== Math.round(Number(invoice.amount || 0) * 100)) return [];

  await conn.query(
    `UPDATE service_orders
     SET invoice_id = ?
     WHERE client_id = ? AND id IN (${placeholders})
       AND (invoice_id IS NULL OR invoice_id = ?)`,
    [invoiceId, invoice.client_id, ...uniqueIds, invoiceId]
  );

  [linkedOrders] = await conn.query(
    `SELECT id, client_id, service_id, description_snapshot, amount_snapshot,
            billing_cycle_snapshot, approval_status, payment_status,
            contracted_service_id
     FROM service_orders
     WHERE invoice_id = ? AND client_id = ?
     ORDER BY id
     FOR UPDATE`,
    [invoiceId, invoice.client_id]
  );
  return linkedOrders;
}

// Avança pedidos somente após confirmação de pagamento. É idempotente:
// pedidos já vinculados não geram um segundo serviço contratado e estados
// operacionais que já avançaram nunca são regredidos.
async function processarSolicitacoesPagas(conn, invoiceId) {
  const orders = await vincularSolicitacoesDaFatura(conn, invoiceId);
  let processed = 0;

  for (const order of orders) {
    if (order.payment_status !== 'paid') {
      await conn.query(
        `UPDATE service_orders SET payment_status = 'paid' WHERE id = ?`,
        [order.id]
      );
    }

    if (['rejected', 'cancelled'].includes(order.approval_status)) {
      continue;
    }

    let contractedServiceId = order.contracted_service_id
      ? Number(order.contracted_service_id)
      : null;
    let contractedService = null;

    if (contractedServiceId) {
      const [serviceRows] = await conn.query(
        'SELECT id, operational_status FROM contracted_services WHERE id = ? FOR UPDATE',
        [contractedServiceId]
      );
      contractedService = serviceRows[0] || null;
      if (!contractedService) contractedServiceId = null;
    }

    if (!contractedServiceId) {
      const [catalogRows] = await conn.query(
        'SELECT name, description FROM services WHERE id = ? LIMIT 1',
        [order.service_id]
      );
      const catalog = catalogRows[0] || {};
      const serviceName = order.description_snapshot || catalog.name || 'Serviço contratado';
      const [insertResult] = await conn.query(
        `INSERT INTO contracted_services (
           client_id, service_id, name, description, status,
           billing_cycle, sale_price, supplier_cost, notes, operational_status
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, 'preparing')`,
        [
          order.client_id,
          order.service_id,
          serviceName,
          catalog.description || null,
          order.billing_cycle_snapshot || 'one_time',
          Number(order.amount_snapshot || 0),
          `Criado automaticamente após confirmação do pagamento da solicitação #${order.id}.`
        ]
      );
      contractedServiceId = Number(insertResult.insertId);
      await conn.query(
        `INSERT INTO contracted_service_status_history
          (contracted_service_id, previous_status, new_status, note, changed_by)
         VALUES (?, 'awaiting_payment', 'preparing', ?, NULL)`,
        [
          contractedServiceId,
          `Pagamento da fatura #${invoiceId} confirmado; solicitação #${order.id} encaminhada para preparação.`
        ]
      );
    } else if (contractedService.operational_status === 'awaiting_payment') {
      await conn.query(
        `UPDATE contracted_services
         SET operational_status = 'preparing', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [contractedServiceId]
      );
      await conn.query(
        `INSERT INTO contracted_service_status_history
          (contracted_service_id, previous_status, new_status, note, changed_by)
         VALUES (?, 'awaiting_payment', 'preparing', ?, NULL)`,
        [
          contractedServiceId,
          `Pagamento da fatura #${invoiceId} confirmado; solicitação #${order.id} encaminhada para preparação.`
        ]
      );
    }

    if (order.approval_status === 'pending') {
      const note = `Aprovada automaticamente após confirmação do pagamento da fatura #${invoiceId}.`;
      await conn.query(
        `UPDATE service_orders
         SET payment_status = 'paid',
             approval_status = 'approved',
             contracted_service_id = ?,
             reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP),
             admin_notes = CASE
               WHEN admin_notes IS NULL OR admin_notes = '' THEN ?
               ELSE CONCAT(admin_notes, CHAR(10), ?)
             END
         WHERE id = ?`,
        [contractedServiceId, note, note, order.id]
      );
    } else {
      await conn.query(
        `UPDATE service_orders
         SET payment_status = 'paid', contracted_service_id = ?
         WHERE id = ?`,
        [contractedServiceId, order.id]
      );
    }

    processed += 1;
  }

  return processed;
}

// --------------------------------------------------
// SAÚDE
// --------------------------------------------------

app.get('/health', async (req, res) => {
  try {
    const resultado = await db.testarConexao();

    res.json({
      projeto: 'VortexGrid',
      status: 'online',
      banco: resultado.conectado ? 'conectado' : 'indisponivel'
    });
  } catch (e) {
    console.error('Erro health:', e.code || e.message || 'erro');

    res.status(503).json({
      projeto: 'VortexGrid',
      status: 'degradado',
      banco: 'indisponivel'
    });
  }
});

// --------------------------------------------------
// CONFIGURAÇÃO INICIAL
// --------------------------------------------------

app.post('/api/setup', async (req, res) => {
  try {
    if (req.get('x-setup-key') !== process.env.ADMIN_SETUP_KEY) {
      return erro(res, 403, 'Chave de configuração inválida.');
    }

    const [existentes] = await db.query(
      'SELECT id FROM users LIMIT 1'
    );

    if (existentes.length) {
      return erro(res, 409, 'O administrador inicial já foi criado.');
    }

    const { name, email, password } = req.body;

    if (
      !validarTexto(name, 120) ||
      !validarEmail(email) ||
      typeof password !== 'string' ||
      password.length < 12 ||
      password.length > 128
    ) {
      return erro(
        res,
        400,
        'Informe nome, e-mail válido e senha entre 12 e 128 caracteres.'
      );
    }

    const hash = await bcrypt.hash(password, 12);

    const [result] = await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES (?, ?, ?, ?)`,
      [name.trim(), email.trim().toLowerCase(), hash, 'admin']
    );

    return res.status(201).json({
      mensagem: 'Administrador inicial criado.',
      id: result.insertId
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return erro(res, 409, 'Este e-mail já está cadastrado.');
    }

    console.error('Erro no setup:', e.code || e.message || 'erro');

    return erro(res, 500, 'Não foi possível concluir a configuração.');
  }
});

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!validarEmail(email) || typeof password !== 'string') {
      return erro(res, 400, 'Informe e-mail e senha.');
    }

    const [rows] = await db.query(
      `SELECT id, name, email, password_hash, role, active
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email.trim().toLowerCase()]
    );

    const user = rows[0];

    const senhaCorreta = user
      ? await bcrypt.compare(password, user.password_hash)
      : false;

    if (!user || !senhaCorreta || !user.active) {
      return erro(res, 401, 'E-mail ou senha inválidos.');
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(err => err ? reject(err) : resolve());
    });

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    return res.json({ usuario: req.session.user });
  } catch (e) {
    console.error('Erro no login:', e.code || e.message || 'erro');

    return erro(
      res,
      500,
      'Não foi possível realizar o login ou salvar a sessão.'
    );
  }
});

// --------------------------------------------------
// LOGOUT E USUÁRIO ATUAL
// --------------------------------------------------

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Erro no logout:', err.message || 'erro');
      return erro(res, 500, 'Não foi possível encerrar a sessão.');
    }

    res.clearCookie('vortexgrid.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      path: '/'
    });

    return res.json({ mensagem: 'Sessão encerrada.' });
  });
});

app.get('/api/me', autenticado, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ usuario: req.session.user });
});

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------

app.get('/api/dashboard', autenticado, somenteAdmin, async (req, res) => {
  try {
    const [[clientes]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM clients
       WHERE status = 'active'`
    );

    // Serviços ativos vendidos a clientes (não apenas itens do catálogo).
    const [[servicos]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM contracted_services
       WHERE status = 'active'`
    );

    const [[servicosCatalogo]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM services
       WHERE active = 1`
    );

    // Não contar serviços cujo contrato já está ativo/cancelado,
    // mesmo que a etapa operacional antiga esteja desatualizada.
    // A contagem considera o estado do contrato e a etapa operacional.
    const [[ativacoes]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM contracted_services
       WHERE COALESCE(status, '') NOT IN ('active', 'cancelled')
         AND COALESCE(operational_status, 'awaiting_payment')
           IN ('awaiting_payment', 'preparing', 'awaiting_supplier', 'awaiting_client', 'activating')`
    );

    const [[usuarios]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM users
       WHERE active = 1`
    );

    const [[faturas]] = await db.query(`
      SELECT COUNT(*) AS quantidade,
             COALESCE(SUM(amount), 0) AS total
      FROM invoices
      WHERE status IN ('pending', 'overdue')
    `);

    const [[recebido]] = await db.query(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM payments
      WHERE paid_at >= DATE_FORMAT(CURRENT_DATE, '%Y-%m-01')
        AND paid_at < DATE_FORMAT(
          DATE_ADD(CURRENT_DATE, INTERVAL 1 MONTH),
          '%Y-%m-01'
        )
    `);

    const [[solicitacoes]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM service_orders
      WHERE approval_status = 'pending'
    `);

    const [[vencidas]] = await db.query(`
      SELECT COUNT(*) AS quantidade,
             COALESCE(SUM(amount), 0) AS total
      FROM invoices
      WHERE status IN ('pending', 'overdue')
        AND due_date IS NOT NULL
        AND due_date < CURRENT_DATE
    `);

    const [serieRows] = await db.query(`
      SELECT DATE_FORMAT(paid_at, '%Y-%m') AS mes,
             COALESCE(SUM(amount), 0) AS total
      FROM payments
      WHERE paid_at >= DATE_SUB(
        DATE_FORMAT(CURRENT_DATE, '%Y-%m-01'),
        INTERVAL 5 MONTH
      )
      GROUP BY mes
      ORDER BY mes
    `);

    const porMes = new Map(
      serieRows.map(item => [item.mes, Number(item.total)])
    );

    const agora = new Date();
    const recebimentosMensais = [];

    for (let i = 5; i >= 0; i -= 1) {
      const ref = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      const chave = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;

      recebimentosMensais.push({
        mes: chave,
        total: porMes.get(chave) || 0
      });
    }

    const [ultimasFaturas] = await db.query(`
      SELECT i.id, i.description, i.amount, i.status, i.due_date, i.created_at,
             c.name AS client_name
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      ORDER BY i.id DESC
      LIMIT 5
    `);

    let solicitacoesRecentes = [];

    if (req.session.user.role === 'admin') {
      const [pendentes] = await db.query(`
        SELECT so.id, so.description_snapshot, so.amount_snapshot,
               so.billing_cycle_snapshot, so.created_at,
               c.name AS client_name
        FROM service_orders so
        JOIN clients c ON c.id = so.client_id
        WHERE so.approval_status = 'pending'
        ORDER BY so.id DESC
        LIMIT 5
      `);

      solicitacoesRecentes = pendentes.map(item => ({
        ...item,
        amount_snapshot: Number(item.amount_snapshot || 0)
      }));
    }

    const [clientesRecentes] = await db.query('SELECT id, name, email, created_at FROM clients ORDER BY created_at DESC, id DESC LIMIT 5');
    const [pagamentosRecentes] = await db.query("SELECT p.id, p.amount, p.method, p.paid_at, c.name AS client_name, i.description AS invoice_description FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id WHERE p.paid_at IS NOT NULL ORDER BY p.paid_at DESC, p.id DESC LIMIT 5");
    let ativacoesRecentes = [];
    if (req.session.user.role === 'admin') {
      const [rows] = await db.query("SELECT cs.id, cs.name, cs.status, cs.created_at, cs.updated_at, c.name AS client_name FROM contracted_services cs JOIN clients c ON c.id = cs.client_id ORDER BY COALESCE(cs.updated_at, cs.created_at) DESC, cs.id DESC LIMIT 5");
      ativacoesRecentes = rows;
    }
    const atividadeRecente = [
      ...clientesRecentes.map(item => ({ tipo: 'cliente', titulo: item.name, descricao: item.email || 'Cadastro de cliente', data: item.created_at, pagina: 'clients', ordem: item.created_at ? new Date(item.created_at).getTime() : 0 })),
      ...pagamentosRecentes.map(item => ({ tipo: 'pagamento', titulo: item.client_name, descricao: item.invoice_description || (item.method ? 'Pagamento via ' + item.method : 'Pagamento registrado'), data: item.paid_at, valor: Number(item.amount || 0), pagina: 'finance', ordem: item.paid_at ? new Date(item.paid_at).getTime() : 0 })),
      ...ultimasFaturas.map(item => ({ tipo: 'fatura', titulo: item.client_name, descricao: item.description || ('Fatura #' + item.id), data: item.created_at, valor: Number(item.amount || 0), pagina: 'finance', ordem: item.created_at ? new Date(item.created_at).getTime() : 0 })),
      ...(req.session.user.role === 'admin' ? ativacoesRecentes.map(item => ({ tipo: 'ativacao', titulo: item.name || 'Serviço contratado', descricao: item.client_name + ' - Status: ' + item.status, data: item.updated_at || item.created_at, pagina: 'services', ordem: (item.updated_at || item.created_at) ? new Date(item.updated_at || item.created_at).getTime() : 0 })) : []),
      ...solicitacoesRecentes.map(item => ({ tipo: 'solicitacao', titulo: item.client_name, descricao: item.description_snapshot || 'Solicitação de serviço', data: item.created_at, valor: Number(item.amount_snapshot || 0), pagina: 'orders', ordem: item.created_at ? new Date(item.created_at).getTime() : 0 }))
    ].sort((a, b) => b.ordem - a.ordem).slice(0, 8).map(({ ordem, ...item }) => item);

    return res.json({
      clientes: Number(clientes.total),
      servicos: Number(servicos.total),
      ...(req.session.user.role === 'admin' ? {
        servicosCatalogo: Number(servicosCatalogo.total),
        ativacoesPendentes: Number(ativacoes.total),
        usuarios: Number(usuarios.total)
      } : {}),
      faturasPendentes: Number(faturas.quantidade),
      valorPendente: Number(faturas.total),
      recebidoMes: Number(recebido.total),
      ...(req.session.user.role === 'admin' ? {
        solicitacoesPendentes: Number(solicitacoes.total)
      } : {}),
      faturasVencidas: Number(vencidas.quantidade),
      valorVencido: Number(vencidas.total),
      recebimentosMensais,
      ultimasFaturas: ultimasFaturas.map(item => ({
        ...item,
        amount: Number(item.amount || 0)
      })),
      ...(req.session.user.role === 'admin' ? { solicitacoesRecentes } : {}),
      atividadeRecente
    });
  } catch (e) {
    console.error('Erro dashboard:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível carregar o dashboard.');
  }
});

// --------------------------------------------------
// USUÁRIOS
// --------------------------------------------------

app.get('/api/users', autenticado, somenteAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, name, email, role, active, created_at
       FROM users
       ORDER BY id DESC`
    );

    return res.json(rows);
  } catch (e) {
    console.error('Erro usuários:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível listar os usuários.');
  }
});

app.post('/api/users', autenticado, somenteAdmin, async (req, res) => {
  try {
    const { name, email, password, role = 'staff' } = req.body;

    if (
      !validarTexto(name, 120) ||
      !validarEmail(email) ||
      typeof password !== 'string' ||
      password.length < 12 ||
      password.length > 128 ||
      !['admin', 'staff'].includes(role)
    ) {
      return erro(
        res,
        400,
        'Confira os dados. A senha deve ter ao menos 12 caracteres.'
      );
    }

    const hash = await bcrypt.hash(password, 12);

    const [result] = await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES (?, ?, ?, ?)`,
      [name.trim(), email.trim().toLowerCase(), hash, role]
    );

    return res.status(201).json({
      id: result.insertId,
      mensagem: 'Usuário criado.'
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return erro(res, 409, 'Este e-mail já está cadastrado.');
    }

    console.error('Erro criar usuário:', e.code || e.message || 'erro');

    return erro(res, 500, 'Não foi possível criar o usuário.');
  }
});

// --------------------------------------------------
// CLIENTES — LISTAR E PESQUISAR
// --------------------------------------------------

app.get('/api/clients', autenticado, somenteAdmin, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string'
      ? req.query.q.trim().slice(0, 190)
      : '';

    const status = typeof req.query.status === 'string'
      ? req.query.status
      : '';

    const conditions = [];
    const params = [];

    if (q) {
      const term = `%${q}%`;

      conditions.push(
        '(name LIKE ? OR email LIKE ? OR phone LIKE ? OR document LIKE ?)'
      );

      params.push(term, term, term, term);
    }

    if (['active', 'inactive'].includes(status)) {
      conditions.push('status = ?');
      params.push(status);
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const [rows] = await db.query(
      `SELECT id, name, email, phone, document, notes, status, created_at
       FROM clients
       ${where}
       ORDER BY id DESC
       LIMIT 500`,
      params
    );

    return res.json(rows);
  } catch (e) {
    console.error('Erro clientes:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível listar os clientes.');
  }
});

// --------------------------------------------------
// CLIENTES — CADASTRAR
// --------------------------------------------------

app.post('/api/clients', autenticado, async (req, res) => {
  try {
    const validacao = validarDadosCliente(req.body);

    if (validacao.erro) {
      return erro(res, 400, validacao.erro);
    }

    const c = validacao.dados;

    const [result] = await db.query(
      `INSERT INTO clients
        (name, email, phone, document, notes, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [c.name, c.email, c.phone, c.document, c.notes]
    );

    return res.status(201).json({
      id: result.insertId,
      mensagem: 'Cliente cadastrado.'
    });
  } catch (e) {
    console.error('Erro criar cliente:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível cadastrar o cliente.');
  }
});

// --------------------------------------------------
// CLIENTES — EDITAR
// --------------------------------------------------

app.put('/api/clients/:id', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);

    if (!id) {
      return erro(res, 400, 'Identificador de cliente inválido.');
    }

    const validacao = validarDadosCliente(req.body);

    if (validacao.erro) {
      return erro(res, 400, validacao.erro);
    }

    const c = validacao.dados;

    const [result] = await db.query(
      `UPDATE clients
       SET name = ?,
           email = ?,
           phone = ?,
           document = ?,
           notes = ?
       WHERE id = ?`,
      [c.name, c.email, c.phone, c.document, c.notes, id]
    );

    if (!result.affectedRows) {
      const [rows] = await db.query(
        'SELECT id FROM clients WHERE id = ? LIMIT 1',
        [id]
      );

      if (!rows.length) {
        return erro(res, 404, 'Cliente não encontrado.');
      }
    }

    return res.json({ mensagem: 'Cadastro do cliente atualizado.' });
  } catch (e) {
    console.error('Erro editar cliente:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível atualizar o cliente.');
  }
});

// --------------------------------------------------
// CLIENTES — ATIVAR / INATIVAR
// --------------------------------------------------

app.patch('/api/clients/:id/status', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);
    const { status } = req.body;

    if (!id) {
      return erro(res, 400, 'Identificador de cliente inválido.');
    }

    if (!['active', 'inactive'].includes(status)) {
      return erro(res, 400, 'Status inválido.');
    }

    const [result] = await db.query(
      'UPDATE clients SET status = ? WHERE id = ?',
      [status, id]
    );

    if (!result.affectedRows) {
      const [rows] = await db.query(
        'SELECT id FROM clients WHERE id = ? LIMIT 1',
        [id]
      );

      if (!rows.length) {
        return erro(res, 404, 'Cliente não encontrado.');
      }
    }

    return res.json({
      mensagem: status === 'active'
        ? 'Cliente ativado.'
        : 'Cliente inativado.',
      status
    });
  } catch (e) {
    console.error('Erro status cliente:', e.code || e.message || 'erro');

    return erro(
      res,
      500,
      'Não foi possível alterar o status do cliente.'
    );
  }
});

// --------------------------------------------------
// FICHA DO CLIENTE — DADOS, FINANCEIRO E SERVIÇOS
// --------------------------------------------------

app.get('/api/clients/:id/record', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);

    if (!id) {
      return erro(res, 400, 'Identificador de cliente inválido.');
    }

    const [clientRows] = await db.query(
      `SELECT id, name, email, phone, document, notes, status, created_at
       FROM clients
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (!clientRows.length) {
      return erro(res, 404, 'Cliente não encontrado.');
    }

    const client = clientRows[0];

    const [invoiceRows] = await db.query(
      `SELECT
         i.id, i.client_id, i.description, i.amount,
         i.status, i.due_date, i.created_at
       FROM invoices i
       WHERE i.client_id = ?
       ORDER BY i.id DESC
       LIMIT 500`,
      [id]
    );

    const [paymentRows] = await db.query(
      `SELECT
         p.id, p.invoice_id, p.amount, p.method,
         p.reference, p.paid_at
       FROM payments p
       INNER JOIN invoices i ON i.id = p.invoice_id
       WHERE i.client_id = ?
       ORDER BY p.id DESC
       LIMIT 500`,
      [id]
    );

    const [contractedServiceRows] = await db.query(
      `SELECT
         cs.id,
         cs.client_id,
         cs.service_id,
         cs.name,
         cs.description,
         cs.status,
         cs.operational_status,
         cs.billing_cycle,
         cs.sale_price,
         cs.started_at,
         cs.next_due_date,
         cs.cancelled_at,
         cs.external_reference,
         cs.notes,
         cs.created_at,
         cs.updated_at,
         s.category AS service_category
       FROM contracted_services cs
       LEFT JOIN services s ON s.id = cs.service_id
       WHERE cs.client_id = ?
       ORDER BY cs.id DESC
       LIMIT 500`,
      [id]
    );

    const invoices = invoiceRows.map(invoice => ({
      ...invoice,
      amount: Number(invoice.amount || 0)
    }));

    const payments = paymentRows.map(payment => ({
      ...payment,
      amount: Number(payment.amount || 0)
    }));

    const isAdmin = req.session.user.role === 'admin';
    const servicosContratados = contractedServiceRows.map(service => {
      const item = {
        ...service,
        sale_price: Number(service.sale_price || 0)
      };

      // Operadores consultam os dados operacionais básicos, sem referências
      // ou observações internas vinculadas ao serviço contratado.
      if (!isAdmin) {
        delete item.external_reference;
        delete item.notes;
        delete item.operational_status;
      }

      return item;
    });

    const totals = {
      invoiceCount: invoices.length,
      pendingCount: 0,
      overdueCount: 0,
      paidCount: 0,
      cancelledCount: 0,
      totalInvoiced: 0,
      totalOpen: 0,
      totalOverdue: 0,
      totalPaidInvoices: 0,
      totalPayments: 0
    };

    for (const invoice of invoices) {
      totals.totalInvoiced += invoice.amount;

      switch (invoice.status) {
        case 'pending':
          totals.pendingCount++;
          totals.totalOpen += invoice.amount;
          break;

        case 'overdue':
          totals.overdueCount++;
          totals.totalOpen += invoice.amount;
          totals.totalOverdue += invoice.amount;
          break;

        case 'paid':
          totals.paidCount++;
          totals.totalPaidInvoices += invoice.amount;
          break;

        case 'cancelled':
          totals.cancelledCount++;
          break;
      }
    }

    for (const payment of payments) {
      totals.totalPayments += payment.amount;
    }

    res.set('Cache-Control', 'no-store');

    return res.json({
      cliente: client,
      financeiro: totals,
      faturas: invoices,
      pagamentos: payments,
      servicosContratados
    });
  } catch (e) {
    console.error('Erro ficha cliente:', e.code || e.message || 'erro');

    return erro(
      res,
      500,
      'Não foi possível carregar a ficha do cliente.'
    );
  }
});

// --------------------------------------------------
// ATRIBUIR SERVIÇO MANUALMENTE A UM CLIENTE
// --------------------------------------------------

app.post(
  '/api/clients/:id/contracted-services',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    try {
      const clientId = validarId(req.params.id);
      const serviceId = validarId(req.body.service_id);

      const startedAt = req.body.started_at || null;
      const nextDueDate = req.body.next_due_date || null;

      const externalReference =
        typeof req.body.external_reference === 'string'
          ? req.body.external_reference.trim()
          : '';

      const notes = typeof req.body.notes === 'string'
        ? req.body.notes.trim()
        : '';

      if (!clientId || !serviceId) {
        return erro(res, 400, 'Informe um cliente e um serviço válidos.');
      }

      if (!validarData(startedAt) || !validarData(nextDueDate)) {
        return erro(res, 400, 'Confira as datas informadas.');
      }

      if (externalReference.length > 190 || notes.length > 5000) {
        return erro(res, 400, 'Referência ou observações muito longas.');
      }

      const [clients] = await db.query(
        `SELECT id
         FROM clients
         WHERE id = ? AND status = 'active'
         LIMIT 1`,
        [clientId]
      );

      if (!clients.length) {
        return erro(res, 404, 'Cliente ativo não encontrado.');
      }

      const [services] = await db.query(
        `SELECT id, name, description, price, billing_cycle, active
         FROM services
         WHERE id = ? AND active = 1
         LIMIT 1`,
        [serviceId]
      );

      if (!services.length) {
        return erro(res, 404, 'Serviço ativo não encontrado.');
      }

      const service = services[0];

      const [result] = await db.query(
        `INSERT INTO contracted_services (
           client_id, service_id, name, description, status,
           billing_cycle, sale_price, supplier_cost, started_at,
           next_due_date, external_reference, notes
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?)`,
        [
          clientId,
          service.id,
          service.name,
          service.description || null,
          service.billing_cycle,
          Number(service.price || 0),
          startedAt,
          nextDueDate,
          externalReference || null,
          notes || null
        ]
      );

      return res.status(201).json({
        id: result.insertId,
        mensagem: 'Serviço atribuído ao cliente como pendente de ativação.'
      });
    } catch (e) {
      console.error('Erro atribuir serviço:', e.code || e.message || 'erro');

      return erro(
        res,
        500,
        'Não foi possível atribuir o serviço ao cliente.'
      );
    }
  }
);

// --------------------------------------------------
// SERVIÇOS CONTRATADOS — EDITAR DADOS
// --------------------------------------------------

app.patch(
  '/api/contracted-services/:id',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    try {
      const id = validarId(req.params.id);

      if (!id) {
        return erro(res, 400, 'Identificador do serviço inválido.');
      }

      const [rows] = await db.query(
        `SELECT id, name, description, started_at, next_due_date,
                external_reference, notes
         FROM contracted_services
         WHERE id = ?
         LIMIT 1`,
        [id]
      );

      if (!rows.length) {
        return erro(res, 404, 'Serviço contratado não encontrado.');
      }

      const atual = rows[0];
      const body = req.body;

      const name = body.name === undefined ? atual.name : body.name;
      const description = body.description === undefined
        ? atual.description
        : body.description;
      const startedAt = body.started_at === undefined
        ? atual.started_at
        : body.started_at;
      const nextDueDate = body.next_due_date === undefined
        ? atual.next_due_date
        : body.next_due_date;
      const externalReference = body.external_reference === undefined
        ? atual.external_reference
        : body.external_reference;
      const notes = body.notes === undefined ? atual.notes : body.notes;

      if (!validarTexto(name, 160)) {
        return erro(res, 400, 'Informe um nome válido para o serviço.');
      }

      if (
        description !== null &&
        description !== undefined &&
        typeof description !== 'string'
      ) {
        return erro(res, 400, 'Descrição inválida.');
      }

      if (startedAt !== null && !validarData(startedAt, false)) {
        return erro(res, 400, 'Data de ativação inválida.');
      }

      if (nextDueDate !== null && !validarData(nextDueDate, false)) {
        return erro(res, 400, 'Próxima data de vencimento inválida.');
      }

      if (
        externalReference !== null &&
        typeof externalReference !== 'string'
      ) {
        return erro(res, 400, 'Referência externa inválida.');
      }

      if (notes !== null && typeof notes !== 'string') {
        return erro(res, 400, 'Observações inválidas.');
      }

      const descricao = typeof description === 'string'
        ? description.trim()
        : '';
      const referencia = typeof externalReference === 'string'
        ? externalReference.trim()
        : '';
      const observacoes = typeof notes === 'string'
        ? notes.trim()
        : '';

      if (
        descricao.length > 5000 ||
        referencia.length > 190 ||
        observacoes.length > 5000
      ) {
        return erro(
          res,
          400,
          'Um ou mais campos excedem o limite permitido.'
        );
      }

      const [result] = await db.query(
        `UPDATE contracted_services
         SET name = ?, description = ?, started_at = ?,
             next_due_date = ?, external_reference = ?, notes = ?
         WHERE id = ?`,
        [
          name.trim(),
          descricao || null,
          startedAt || null,
          nextDueDate || null,
          referencia || null,
          observacoes || null,
          id
        ]
      );

      if (!result.affectedRows) {
        const [check] = await db.query(
          'SELECT id FROM contracted_services WHERE id = ? LIMIT 1',
          [id]
        );

        if (!check.length) {
          return erro(res, 404, 'Serviço contratado não encontrado.');
        }
      }

      return res.json({
        mensagem: 'Dados do serviço contratado atualizados.',
        id
      });
    } catch (e) {
      console.error(
        'Erro editar serviço contratado:',
        e.code || e.message || 'erro'
      );

      return erro(
        res,
        500,
        'Não foi possível atualizar o serviço contratado.'
      );
    }
  }
);


 // --------------------------------------------------
// SERVIÇOS CONTRATADOS — VISÃO GLOBAL DE ATIVAÇÕES
// Somente administradores. Não expõe dados internos de fornecedores.
// --------------------------------------------------
// --------------------------------------------------
// INFORMAÇÕES PERSONALIZADAS DO SERVIÇO CONTRATADO
// Somente administradores podem editar; o Portal lê a mesma tabela.
// --------------------------------------------------
app.get('/api/contracted-services/:id/details', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);
    if (!id) return erro(res, 400, 'Identificador do serviço inválido.');
    const [services] = await db.query('SELECT id FROM contracted_services WHERE id = ? LIMIT 1', [id]);
    if (!services.length) return erro(res, 404, 'Serviço contratado não encontrado.');

    await ensureContractedServiceDetailsTable();
    const [rows] = await db.query(
      `SELECT id, label, value, sort_order
       FROM contracted_service_details
       WHERE contracted_service_id = ?
       ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ details: rows });
  } catch (e) {
    console.error('Erro carregar informações do serviço:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível carregar as informações deste serviço.');
  }
});

app.put('/api/contracted-services/:id/details', autenticado, somenteAdmin, async (req, res) => {
  let conn;
  try {
    const id = validarId(req.params.id);
    if (!id) return erro(res, 400, 'Identificador do serviço inválido.');
    const [services] = await db.query('SELECT id FROM contracted_services WHERE id = ? LIMIT 1', [id]);
    if (!services.length) return erro(res, 404, 'Serviço contratado não encontrado.');

    const details = req.body?.details;
    if (!Array.isArray(details) || details.length > 30) {
      return erro(res, 400, 'Envie uma lista com até 30 informações.');
    }

    const normalized = [];
    for (const item of details) {
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      const value = typeof item?.value === 'string' ? item.value.trim() : '';
      if (!label && !value) continue;
      if (!label || label.length > 80 || value.length > 4000) {
        return erro(res, 400, 'Cada informação precisa de título de até 80 caracteres e valor de até 4000 caracteres.');
      }
      normalized.push({ label, value });
    }

    await ensureContractedServiceDetailsTable();
    conn = await db.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM contracted_service_details WHERE contracted_service_id = ?', [id]);
    for (let index = 0; index < normalized.length; index += 1) {
      const item = normalized[index];
      await conn.query(
        `INSERT INTO contracted_service_details
          (contracted_service_id, label, value, sort_order)
         VALUES (?, ?, ?, ?)`,
        [id, item.label, item.value, index]
      );
    }
    await conn.commit();
    res.set('Cache-Control', 'no-store');
    return res.json({ mensagem: 'Informações do serviço salvas.', details: normalized });
  } catch (e) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error('Erro salvar informações do serviço:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível salvar as informações deste serviço.');
  } finally {
    if (conn) conn.release();
  }
});

app.get('/api/contracted-services', autenticado, somenteAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         cs.id,
         cs.client_id,
         c.name AS client_name,
         c.email AS client_email,
         cs.service_id,
         cs.name,
         cs.description,
         cs.status,
         cs.operational_status,
         cs.billing_cycle,
         cs.sale_price,
         cs.started_at,
         cs.next_due_date,
         cs.created_at,
         cs.updated_at,
         s.category AS service_category
       FROM contracted_services cs
       INNER JOIN clients c ON c.id = cs.client_id
       LEFT JOIN services s ON s.id = cs.service_id
       ORDER BY
         CASE
           WHEN cs.operational_status IN ('activation_failed', 'awaiting_supplier', 'awaiting_client') THEN 0
           WHEN cs.operational_status IN ('preparing', 'activating', 'awaiting_payment') THEN 1
           WHEN cs.operational_status = 'active' THEN 2
           WHEN cs.operational_status = 'suspended' THEN 3
           ELSE 4
         END,
         cs.updated_at DESC,
         cs.id DESC
       LIMIT 1000`
    );

    return res.json({
      services: rows.map(service => ({
        ...service,
        sale_price: Number(service.sale_price || 0)
      }))
    });
  } catch (e) {
    console.error('Erro listar serviços contratados:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível carregar os serviços contratados.');
  }
});

// --------------------------------------------------
 // SERVIÇOS CONTRATADOS — ESTADO OPERACIONAL INTERNO
 // Somente administradores. Não altera financeiro nem status público.
 // --------------------------------------------------
 app.patch('/api/contracted-services/:id/operational-status', autenticado, somenteAdmin, async (req, res) => {
   let conn;
   try {
     const id = validarId(req.params.id);
     const status = req.body.operational_status;
     const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
     const allowed = ['awaiting_payment','preparing','awaiting_supplier','awaiting_client','activating','active','activation_failed','suspended','cancelled'];
     if (!id) return erro(res, 400, 'Identificador do serviço inválido.');
     if (!allowed.includes(status)) return erro(res, 400, 'Estado operacional inválido.');
     if (!note || note.length > 2000) return erro(res, 400, 'Informe uma observação interna de até 2000 caracteres.');
     conn = await db.getConnection();
     await conn.beginTransaction();
     const [rows] = await conn.query('SELECT id, operational_status FROM contracted_services WHERE id = ? FOR UPDATE', [id]);
     if (!rows.length) {
       await conn.rollback();
       return erro(res, 404, 'Serviço contratado não encontrado.');
     }
     const previous = rows[0].operational_status || 'awaiting_payment';
     if (previous === status) {
       await conn.rollback();
       return erro(res, 409, 'O serviço já está nesse estado operacional.');
     }
     await conn.query('UPDATE contracted_services SET operational_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id]);
     await conn.query(
       `INSERT INTO contracted_service_status_history
         (contracted_service_id, previous_status, new_status, note, changed_by)
        VALUES (?, ?, ?, ?, ?)`,
       [id, previous, status, note, req.session.user.id]
     );
     await conn.commit();
     return res.json({ mensagem: 'Estado operacional atualizado. O financeiro não foi alterado.', id, operational_status: status });
   } catch (e) {
     if (conn) await conn.rollback().catch(() => {});
     console.error('Erro alterar estado operacional:', e.code || e.message || 'erro');
     if (['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(e.code)) return erro(res, 503, 'A migração do estado operacional ainda não foi aplicada ao banco.');
     return erro(res, 500, 'Não foi possível alterar o estado operacional.');
   } finally {
     if (conn) conn.release();
   }
 });

 app.get('/api/contracted-services/:id/operational-history', autenticado, somenteAdmin, async (req, res) => {
   try {
     const id = validarId(req.params.id);
     if (!id) return erro(res, 400, 'Identificador do serviço inválido.');
     const [rows] = await db.query(
       `SELECT h.id, h.previous_status, h.new_status, h.note, h.changed_at,
               u.name AS changed_by_name
        FROM contracted_service_status_history h
        LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.contracted_service_id = ?
        ORDER BY h.id DESC LIMIT 100`,
       [id]
     );
     return res.json({ historico: rows });
   } catch (e) {
     console.error('Erro consultar histórico operacional:', e.code || e.message || 'erro');
     if (e.code === 'ER_NO_SUCH_TABLE') return erro(res, 503, 'A migração do estado operacional ainda não foi aplicada ao banco.');
     return erro(res, 500, 'Não foi possível carregar o histórico operacional.');
   }
 });

// --------------------------------------------------
// SERVIÇOS CONTRATADOS — ALTERAR STATUS
// --------------------------------------------------

app.patch(
  '/api/contracted-services/:id/status',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    let conn;

    try {
      const id = validarId(req.params.id);
      const status = req.body.status;

      const statusPermitidos = [
        'pending',
        'provisioning',
        'active',
        'suspended',
        'cancelled'
      ];

      if (!id) {
        return erro(res, 400, 'Identificador do serviço inválido.');
      }

      if (!statusPermitidos.includes(status)) {
        return erro(res, 400, 'Status do serviço inválido.');
      }

      conn = await db.getConnection();
      await conn.beginTransaction();

      const [rows] = await conn.query(
        `SELECT id, status, started_at, cancelled_at
         FROM contracted_services
         WHERE id = ?
         FOR UPDATE`,
        [id]
      );

      if (!rows.length) {
        await conn.rollback();
        return erro(res, 404, 'Serviço contratado não encontrado.');
      }

      const atual = rows[0];

      if (atual.status === 'cancelled' && status !== 'cancelled') {
        await conn.rollback();

        return erro(
          res,
          409,
          'O serviço já está cancelado. Entre em contato com o administrador para avaliar uma reativação.'
        );
      }

      let startedAt = atual.started_at;
      let cancelledAt = atual.cancelled_at;

      if (status === 'active' && !startedAt) {
        const [todayRows] = await conn.query(
          'SELECT CURRENT_DATE AS data_atual'
        );

        startedAt = todayRows[0].data_atual;
      }

      if (status === 'cancelled' && !cancelledAt) {
        const [todayRows] = await conn.query(
          'SELECT CURRENT_DATE AS data_atual'
        );

        cancelledAt = todayRows[0].data_atual;
      }

      await conn.query(
        `UPDATE contracted_services
         SET status = ?, started_at = ?, cancelled_at = ?
         WHERE id = ?`,
        [status, startedAt, cancelledAt, id]
      );

      await conn.commit();

      return res.json({
        mensagem: 'Status do serviço contratado atualizado.',
        id,
        status
      });
    } catch (e) {
      if (conn) {
        await conn.rollback().catch(() => {});
      }

      console.error(
        'Erro alterar status do serviço contratado:',
        e.code || e.message || 'erro'
      );

      if (
        e.code === 'WARN_DATA_TRUNCATED' ||
        e.code === 'ER_TRUNCATED_WRONG_VALUE'
      ) {
        return erro(
          res,
          400,
          'O banco rejeitou esse status. Confira os valores permitidos na coluna status.'
        );
      }

      return erro(
        res,
        500,
        'Não foi possível alterar o status do serviço contratado.'
      );
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }
);

// --------------------------------------------------
// CATEGORIAS E CATÁLOGO DE SERVIÇOS
// --------------------------------------------------

function normalizarEspecificacoes(valor) {
  if (valor === undefined || valor === null || valor === '') {
    return {};
  }

  if (typeof valor === 'string') {
    try {
      const parsed = JSON.parse(valor);

      return parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
        ? parsed
        : null;
    } catch (_) {
      return null;
    }
  }

  return valor &&
    typeof valor === 'object' &&
    !Array.isArray(valor)
    ? valor
    : null;
}

function textoOpcional(valor, max) {
  if (valor === undefined || valor === null || valor === '') {
    return null;
  }

  if (typeof valor !== 'string') {
    return undefined;
  }

  return valor.trim().slice(0, max) || null;
}

app.get(
  '/api/service-categories',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT c.id, c.name, c.slug, c.active, c.sort_order,
                c.parent_id, c.created_at, c.pricing_mode,
                p.name AS parent_name
         FROM service_categories c
         LEFT JOIN service_categories p ON p.id = c.parent_id
         ORDER BY COALESCE(c.parent_id, c.id) ASC,
                  c.parent_id ASC, c.sort_order ASC, c.name ASC`
      );

      return res.json(rows);
    } catch (e) {
      console.error(
        'Erro categorias do catálogo:',
        e.code || e.message || 'erro'
      );

      return erro(
        res,
        500,
        'Não foi possível listar as categorias. Execute a migração do catálogo.'
      );
    }
  }
);

app.post(
  '/api/service-categories',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    try {
      const name = typeof req.body.name === 'string'
        ? req.body.name.trim()
        : '';
      const slugInput = typeof req.body.slug === 'string'
        ? req.body.slug.trim()
        : '';

      const parentId =
        req.body.parent_id === undefined ||
        req.body.parent_id === null ||
        req.body.parent_id === ''
          ? null
          : validarId(req.body.parent_id);

      if (
        req.body.parent_id !== undefined &&
        req.body.parent_id !== null &&
        req.body.parent_id !== '' &&
        !parentId
      ) {
        return erro(res, 400, 'Categoria principal inválida.');
      }

      if (parentId) {
        const [parents] = await db.query(
          'SELECT id, parent_id FROM service_categories WHERE id = ? LIMIT 1',
          [parentId]
        );

        if (!parents.length) {
          return erro(res, 400, 'Categoria principal não encontrada.');
        }

        if (parents[0].parent_id !== null) {
          return erro(
            res,
            400,
            'Só é permitido um nível de subcategoria.'
          );
        }
      }

      const slug = (slugInput || name)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      if (!validarTexto(name, 80) || !validarTexto(slug, 100)) {
        return erro(res, 400, 'Informe um nome de categoria válido.');
      }

      const sortOrder = req.body.sort_order === undefined
        ? 0
        : Number(req.body.sort_order);

      if (!Number.isSafeInteger(sortOrder)) {
        return erro(res, 400, 'Ordem da categoria inválida.');
      }

      const [result] = await db.query(
        `INSERT INTO service_categories
          (name, slug, active, sort_order, parent_id)
         VALUES (?, ?, 1, ?, ?)`,
        [name, slug, sortOrder, parentId]
      );

      return res.status(201).json({
        id: result.insertId,
        name,
        slug,
        parent_id: parentId,
        mensagem: 'Categoria criada.'
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return erro(
          res,
          409,
          'Já existe uma categoria com esse nome ou identificador.'
        );
      }

      console.error('Erro criar categoria:', e.code || e.message || 'erro');

      return erro(res, 500, 'Não foi possível criar a categoria.');
    }
  }
);

app.patch(
  '/api/service-categories/:id',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    try {
      const id = validarId(req.params.id);

      if (!id) {
        return erro(res, 400, 'Categoria inválida.');
      }

      const updates = [];
      const values = [];

      if (req.body.name !== undefined) {
        if (!validarTexto(req.body.name, 80)) {
          return erro(res, 400, 'Nome de categoria inválido.');
        }

        const categoryName = req.body.name.trim();
        const categorySlug = categoryName
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        updates.push('name = ?');
        values.push(categoryName);

        updates.push('slug = ?');
        values.push(categorySlug);
      }

      if (req.body.parent_id !== undefined) {
        const parentId =
          req.body.parent_id === null || req.body.parent_id === ''
            ? null
            : validarId(req.body.parent_id);

        if (
          req.body.parent_id !== null &&
          req.body.parent_id !== '' &&
          !parentId
        ) {
          return erro(res, 400, 'Categoria principal inválida.');
        }

        if (parentId === id) {
          return erro(
            res,
            400,
            'Uma categoria não pode ser sua própria subcategoria.'
          );
        }

        if (parentId) {
          const [parents] = await db.query(
            'SELECT id, parent_id FROM service_categories WHERE id = ? LIMIT 1',
            [parentId]
          );

          if (!parents.length || parents[0].parent_id !== null) {
            return erro(
              res,
              400,
              'Escolha uma categoria principal válida.'
            );
          }
        }

        updates.push('parent_id = ?');
        values.push(parentId);
      }

      if (req.body.active !== undefined) {
        updates.push('active = ?');
        values.push(normalizarBooleano(req.body.active) ? 1 : 0);
      }

      if (req.body.sort_order !== undefined) {
        const sort = Number(req.body.sort_order);

        if (!Number.isSafeInteger(sort)) {
          return erro(res, 400, 'Ordem inválida.');
        }

        updates.push('sort_order = ?');
        values.push(sort);
      }

      if (!updates.length) {
        return erro(res, 400, 'Nenhum campo para atualizar.');
      }

      values.push(id);

      const [result] = await db.query(
        `UPDATE service_categories
         SET ${updates.join(', ')}
         WHERE id = ?`,
        values
      );

      if (!result.affectedRows) {
        const [existing] = await db.query(
          'SELECT id FROM service_categories WHERE id = ? LIMIT 1',
          [id]
        );

        if (!existing.length) {
          return erro(res, 404, 'Categoria não encontrada.');
        }
      }

      return res.json({ mensagem: 'Categoria atualizada.' });
    } catch (e) {
      console.error(
        'Erro atualizar categoria:',
        e.code || e.message || 'erro'
      );

      return erro(res, 500, 'Não foi possível atualizar a categoria.');
    }
  }
);

app.delete(
  '/api/service-categories/:id',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    let connection;

    try {
      const id = validarId(req.params.id);

      if (!id) {
        return erro(res, 400, 'Categoria inválida.');
      }

      connection = await db.getConnection();

      const [categories] = await connection.query(
        'SELECT id, name FROM service_categories WHERE id = ? LIMIT 1',
        [id]
      );

      if (!categories.length) {
        return erro(res, 404, 'Categoria não encontrada.');
      }

      const [children] = await connection.query(
        'SELECT id FROM service_categories WHERE parent_id = ? LIMIT 1',
        [id]
      );

      if (children.length) {
        return erro(
          res,
          409,
          'Não é possível excluir esta categoria porque ela possui subcategorias. Mova ou exclua as subcategorias primeiro.'
        );
      }

      const [services] = await connection.query(
        'SELECT id FROM services WHERE category_id = ? LIMIT 1',
        [id]
      );

      if (services.length) {
        return erro(
          res,
          409,
          'Não é possível excluir esta categoria porque existem serviços vinculados. Reatribua esses serviços a outra categoria primeiro.'
        );
      }

      const [result] = await connection.query(
        'DELETE FROM service_categories WHERE id = ?',
        [id]
      );

      if (!result.affectedRows) {
        return erro(res, 404, 'Categoria não encontrada.');
      }

      return res.json({ mensagem: 'Categoria excluída.' });
    } catch (e) {
      if (
        e.code === 'ER_ROW_IS_REFERENCED_2' ||
        e.code === 'ER_ROW_IS_REFERENCED'
      ) {
        return erro(
          res,
          409,
          'Não é possível excluir esta categoria porque existem registros vinculados.'
        );
      }

      console.error(
        'Erro excluir categoria:',
        e.code || e.message || 'erro'
      );

      return erro(res, 500, 'Não foi possível excluir a categoria.');
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

// --------------------------------------------------
// SERVIÇOS — LISTAGEM INTERNA
// Somente administradores podem consultar dados internos.
// --------------------------------------------------

app.get('/api/services', autenticado, somenteAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, c.parent_id AS category_parent_id,
              c.name AS linked_category_name,
              p.name AS parent_category_name,
              sp.name AS internal_supplier_product_name,
              sp.supplier_id AS internal_supplier_id,
              sp.cost AS internal_supplier_cost
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       LEFT JOIN service_categories p ON p.id = c.parent_id
       LEFT JOIN supplier_products sp ON sp.id = s.supplier_product_id
       ORDER BY s.id DESC
       LIMIT 1000`
    );

    return res.json(rows.map(row => ({
      ...row,
      price: Number(row.price || 0),
      public_visible: Boolean(row.public_visible),
      featured: Boolean(row.featured),
      active: Boolean(row.active),
      display_order: Number(row.display_order || 0),
      specifications: normalizarEspecificacoes(row.specifications) || {}
    })));
  } catch (e) {
    console.error('Erro serviços:', e.code || e.message || 'erro');

    return erro(
      res,
      500,
      'Não foi possível listar os serviços. Execute a migração do catálogo.'
    );
  }
});

// --------------------------------------------------
// CATÁLOGO PÚBLICO
// Somente produtos ativos e publicamente visíveis.
// Nunca retornar custos, fornecedores ou notas internas.
// --------------------------------------------------

app.get('/api/catalog', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
         s.id,
         s.name,
         s.description,
         s.short_description,
         s.category,
         s.category_id,
         c.parent_id AS category_parent_id,
         c.name AS linked_category_name,
         p.name AS parent_category_name,
         s.price,
         s.pricing_mode,
         s.billing_cycle,
         s.region,
         s.specifications,
         s.featured,
         s.badge,
         s.slug,
         s.display_order
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       LEFT JOIN service_categories p ON p.id = c.parent_id
       WHERE s.active = 1
         AND s.public_visible = 1
       ORDER BY
         s.display_order ASC,
         s.category ASC,
         s.price ASC,
         s.name ASC
       LIMIT 500`
    );

    res.set('Cache-Control', 'no-store');

    return res.json(rows.map(row => ({
      ...row,
      price: Number(row.price || 0),
      pricing_mode: row.pricing_mode === 'quote' ? 'quote' : 'fixed',
      quote_required: row.pricing_mode === 'quote',
      featured: Boolean(row.featured),
      display_order: Number(row.display_order || 0),
      specifications: normalizarEspecificacoes(row.specifications) || {}
    })));
  } catch (e) {
    console.error(
      'Erro catálogo público:',
      e.code || e.message || 'erro'
    );

    return erro(res, 500, 'Catálogo temporariamente indisponível.');
  }
});

// --------------------------------------------------
// CADASTRAR SERVIÇO
// --------------------------------------------------

app.post('/api/services', autenticado, somenteAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const name = typeof body.name === 'string'
      ? body.name.trim()
      : '';

    const description = textoOpcional(body.description, 5000);
    const shortDescription = textoOpcional(body.short_description, 500);

    const categoryId =
      body.category_id === undefined ||
      body.category_id === null ||
      body.category_id === ''
        ? null
        : validarId(body.category_id);

    let category = typeof body.category === 'string'
      ? body.category.trim()
      : '';

    let pricingMode = 'fixed';

    if (
      body.category_id !== undefined &&
      body.category_id !== null &&
      body.category_id !== '' &&
      !categoryId
    ) {
      return erro(res, 400, 'Selecione uma categoria válida.');
    }

    if (categoryId) {
      const [catRows] = await db.query(
        `SELECT c.name, c.pricing_mode, p.name AS parent_name
         FROM service_categories c
         LEFT JOIN service_categories p ON p.id = c.parent_id
         WHERE c.id = ? AND c.active = 1
         LIMIT 1`,
        [categoryId]
      );

      if (!catRows.length) {
        return erro(
          res,
          400,
          'A categoria selecionada não existe ou está inativa.'
        );
      }

      category = catRows[0].name;
      pricingMode = categoriaExigeOrcamento(catRows[0].pricing_mode, catRows[0].name, catRows[0].parent_name) ? 'quote' : 'fixed';
    }

    const region = textoOpcional(body.region, 100);
    const slug = textoOpcional(body.slug, 190);
    const badge = textoOpcional(body.badge, 80);
    const price = Number(body.price);
    const billingCycle = body.billing_cycle || 'monthly';
    const specifications = normalizarEspecificacoes(body.specifications);

    const supplierProductId = body.supplier_product_id
      ? validarId(body.supplier_product_id)
      : null;

    const internalNotes = textoOpcional(body.internal_notes, 5000);

    if (
      !validarTexto(name, 160) ||
      !valorMonetario(price) ||
      !['one_time', 'monthly', 'yearly'].includes(billingCycle) ||
      !validarTexto(category, 80) ||
      description === undefined ||
      shortDescription === undefined ||
      region === undefined ||
      slug === undefined ||
      badge === undefined ||
      internalNotes === undefined ||
      specifications === null ||
      (body.supplier_product_id && !supplierProductId)
    ) {
      return erro(
        res,
        400,
        'Confira nome, categoria, preço, periodicidade e especificações.'
      );
    }

    // Cada campo da vitrine é independente.
    const active = normalizarBooleano(body.active, true) ? 1 : 0;
    const publicVisible = normalizarBooleano(
      body.public_visible,
      true
    ) ? 1 : 0;
    const featured = normalizarBooleano(body.featured, false) ? 1 : 0;

    const displayOrder = (
      body.display_order === undefined ||
      body.display_order === ''
    )
      ? 0
      : Number(body.display_order);

    if (!Number.isSafeInteger(displayOrder)) {
      return erro(
        res,
        400,
        'A ordem de exibição deve ser um número inteiro.'
      );
    }

    const [result] = await db.query(
      `INSERT INTO services
        (
          name,
          description,
          category,
          category_id,
          price,
          pricing_mode,
          billing_cycle,
          slug,
          short_description,
          region,
          specifications,
          public_visible,
          featured,
          badge,
          display_order,
          supplier_product_id,
          internal_notes,
          active
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        description,
        category,
        categoryId,
        price,
        pricingMode,
        billingCycle,
        slug,
        shortDescription,
        region,
        JSON.stringify(specifications),
        publicVisible,
        featured,
        badge,
        displayOrder,
        supplierProductId,
        internalNotes,
        active
      ]
    );

    return res.status(201).json({
      id: result.insertId,
      active: Boolean(active),
      public_visible: Boolean(publicVisible),
      featured: Boolean(featured),
      display_order: displayOrder,
      mensagem: 'Produto cadastrado com sucesso.'
    });
  } catch (e) {
    console.error('Erro criar serviço:', e.code || e.message || 'erro');

    return erro(
      res,
      500,
      'Não foi possível cadastrar o produto. Confira se a migração do catálogo foi aplicada.'
    );
  }
});

// --------------------------------------------------
// EDITAR SERVIÇO
// --------------------------------------------------

app.put('/api/services/:id', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);

    if (!id) {
      return erro(res, 400, 'Produto inválido.');
    }

    const body = req.body || {};

    const [found] = await db.query(
      'SELECT id FROM services WHERE id = ? LIMIT 1',
      [id]
    );

    if (!found.length) {
      return erro(res, 404, 'Produto não encontrado.');
    }

    const fields = {
      name: {
        column: 'name',
        validate: v => validarTexto(v, 160),
        map: v => v.trim()
      },
      description: {
        column: 'description',
        validate: v => v === null || typeof v === 'string',
        map: v => v === null ? null : v.slice(0, 5000)
      },
      short_description: {
        column: 'short_description',
        validate: v => v === null || typeof v === 'string',
        map: v => v === null ? null : v.slice(0, 500)
      },
      category: {
        column: 'category',
        validate: v => validarTexto(v, 80),
        map: v => v.trim()
      },
      category_id: {
        column: 'category_id',
        validate: v => v === null || v === '' || validarId(v),
        map: v => v === null || v === '' ? null : Number(v)
      },
      price: {
        column: 'price',
        validate: valorMonetario,
        map: Number
      },
      billing_cycle: {
        column: 'billing_cycle',
        validate: v => ['one_time', 'monthly', 'yearly'].includes(v),
        map: v => v
      },
      slug: {
        column: 'slug',
        validate: v => v === null || typeof v === 'string',
        map: v => v === null ? null : v.slice(0, 190)
      },
      region: {
        column: 'region',
        validate: v => v === null || typeof v === 'string',
        map: v => v === null ? null : v.slice(0, 100)
      },
      badge: {
        column: 'badge',
        validate: v => v === null || typeof v === 'string',
        map: v => v === null ? null : v.slice(0, 80)
      },
      public_visible: {
        column: 'public_visible',
        validate: v =>
          typeof v === 'boolean' ||
          v === 0 ||
          v === 1 ||
          v === '0' ||
          v === '1',
        map: v => normalizarBooleano(v) ? 1 : 0
      },
      featured: {
        column: 'featured',
        validate: v =>
          typeof v === 'boolean' ||
          v === 0 ||
          v === 1 ||
          v === '0' ||
          v === '1',
        map: v => normalizarBooleano(v) ? 1 : 0
      },
      active: {
        column: 'active',
        validate: v =>
          typeof v === 'boolean' ||
          v === 0 ||
          v === 1 ||
          v === '0' ||
          v === '1',
        map: v => normalizarBooleano(v) ? 1 : 0
      },
      display_order: {
        column: 'display_order',
        validate: v =>
          v !== null &&
          v !== '' &&
          Number.isSafeInteger(Number(v)),
        map: Number
      },
      supplier_product_id: {
        column: 'supplier_product_id',
        validate: v => v === null || v === '' || validarId(v),
        map: v => v === null || v === '' ? null : Number(v)
      },
      internal_notes: {
        column: 'internal_notes',
        validate: v => v === null || typeof v === 'string',
        map: v => v === null ? null : v.slice(0, 5000)
      }
    };

    const updates = [];
    const values = [];

    for (const [key, field] of Object.entries(fields)) {
      if (body[key] === undefined) {
        continue;
      }

      if (!field.validate(body[key])) {
        return erro(res, 400, `Campo inválido: ${key}.`);
      }

      if (
        key === 'category_id' &&
        body[key] !== null &&
        body[key] !== ''
      ) {
        const [catRows] = await db.query(
          `SELECT c.name, c.pricing_mode, p.name AS parent_name
           FROM service_categories c
           LEFT JOIN service_categories p ON p.id = c.parent_id
           WHERE c.id = ? AND c.active = 1
           LIMIT 1`,
          [Number(body[key])]
        );

        if (!catRows.length) {
          return erro(
            res,
            400,
            'A categoria selecionada não existe ou está inativa.'
          );
        }

        updates.push('category = ?');
        values.push(catRows[0].name);
        updates.push('pricing_mode = ?');
        values.push(categoriaExigeOrcamento(catRows[0].pricing_mode, catRows[0].name, catRows[0].parent_name) ? 'quote' : 'fixed');
      }

      updates.push(`${field.column} = ?`);
      values.push(field.map(body[key]));
    }

    if (body.specifications !== undefined) {
      const specs = normalizarEspecificacoes(body.specifications);

      if (specs === null) {
        return erro(
          res,
          400,
          'As especificações devem ser um objeto JSON válido.'
        );
      }

      updates.push('specifications = ?');
      values.push(JSON.stringify(specs));
    }

    if (!updates.length) {
      return erro(res, 400, 'Nenhum campo para atualizar.');
    }

    values.push(id);

    await db.query(
      `UPDATE services
       SET ${updates.join(', ')}
       WHERE id = ?`,
      values
    );

    return res.json({
      mensagem: 'Produto atualizado.',
      id
    });
  } catch (e) {
    console.error(
      'Erro atualizar produto:',
      e.code || e.message || 'erro'
    );

    return erro(res, 500, 'Não foi possível atualizar o produto.');
  }
});

// --------------------------------------------------
// SERVIÇOS — ATIVAR / INATIVAR
// Não modifica public_visible nem featured.
// --------------------------------------------------

app.patch(
  '/api/services/:id/status',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    try {
      const id = validarId(req.params.id);

      if (!id || typeof req.body.active !== 'boolean') {
        return erro(res, 400, 'Informe o status do produto.');
      }

      const active = req.body.active ? 1 : 0;

      const [result] = await db.query(
        'UPDATE services SET active = ? WHERE id = ?',
        [active, id]
      );

      if (!result.affectedRows) {
        const [rows] = await db.query(
          'SELECT id FROM services WHERE id = ? LIMIT 1',
          [id]
        );

        if (!rows.length) {
          return erro(res, 404, 'Produto não encontrado.');
        }
      }

      return res.json({
        mensagem: active
          ? 'Produto ativado.'
          : 'Produto inativado.',
        id,
        active: Boolean(active)
      });
    } catch (e) {
      console.error(
        'Erro status do produto:',
        e.code || e.message || 'erro'
      );

      return erro(
        res,
        500,
        'Não foi possível alterar o status do produto.'
      );
    }
  }
);

// --------------------------------------------------
// --------------------------------------------------
// ORÇAMENTOS PERSONALIZADOS — ADMINISTRAR
// --------------------------------------------------
app.get('/api/quote-requests', autenticado, somenteAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const allowed = ['requested', 'proposed', 'accepted', 'declined', 'cancelled'];
    const params = [];
    let where = '';
    if (allowed.includes(status)) {
      where = 'WHERE qr.status = ?';
      params.push(status);
    }
    const [rows] = await db.query(
      `SELECT qr.id, qr.client_id, qr.service_id, qr.customer_notes, qr.status,
              qr.proposed_amount, qr.billing_cycle, qr.proposal_notes, qr.valid_until,
              qr.created_at, qr.updated_at, qr.responded_at,
              c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
              s.name AS service_name, s.category
       FROM quote_requests qr
       JOIN clients c ON c.id = qr.client_id
       JOIN services s ON s.id = qr.service_id
       ${where}
       ORDER BY FIELD(qr.status, 'requested', 'proposed', 'accepted', 'declined', 'cancelled'),
                qr.id DESC
       LIMIT 500`,
      params
    );
    return res.json({ quote_requests: rows.map(row => ({
      ...row,
      proposed_amount: row.proposed_amount === null ? null : Number(row.proposed_amount)
    })) });
  } catch (e) {
    console.error('Erro listar orçamentos:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível listar os orçamentos.');
  }
});

app.patch('/api/quote-requests/:id/proposal', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);
    const amount = Number(req.body.proposed_amount);
    const billingCycle = req.body.billing_cycle || 'one_time';
    const proposalNotes = textoOpcional(req.body.proposal_notes, 5000);
    const validUntil = req.body.valid_until || null;
    if (!id || !Number.isFinite(amount) || amount < 0.01 || amount > 99999999 ||
        !['one_time', 'monthly', 'yearly'].includes(billingCycle) ||
        proposalNotes === undefined || !validarData(validUntil)) {
      return erro(res, 400, 'Confira o valor, ciclo, observações e validade da proposta.');
    }
    const [result] = await db.query(
      `UPDATE quote_requests
       SET proposed_amount = ?, billing_cycle = ?, proposal_notes = ?,
           valid_until = ?, status = 'proposed', responded_at = NULL
       WHERE id = ? AND status IN ('requested', 'proposed')`,
      [Number(amount.toFixed(2)), billingCycle, proposalNotes || null, validUntil, id]
    );
    if (!result.affectedRows) {
      return erro(res, 409, 'Este orçamento não está aguardando proposta ou já foi respondido.');
    }
    return res.json({ sucesso: true, mensagem: 'Proposta enviada ao cliente.', id });
  } catch (e) {
    console.error('Erro enviar proposta:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível enviar a proposta.');
  }
});

// SOLICITAÇÕES DE SERVIÇOS — ADMINISTRAR
// --------------------------------------------------

app.get('/api/service-orders', autenticado, somenteAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string'
      ? req.query.status
      : '';

    const conditions = [];
    const params = [];

    if (['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      conditions.push('so.approval_status = ?');
      params.push(status);
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const [rows] = await db.query(
      `SELECT
         so.id, so.client_id, so.service_id, so.invoice_id,
         so.contracted_service_id,
         so.description_snapshot, so.amount_snapshot,
         so.billing_cycle_snapshot, so.approval_status,
         so.payment_status, so.customer_notes, so.admin_notes,
         so.reviewed_by, so.reviewed_at, so.created_at, so.updated_at,
         i.status AS invoice_status,
         cs.operational_status,
         c.name AS client_name, c.email AS client_email,
         s.name AS service_name, u.name AS reviewed_by_name
       FROM service_orders so
       INNER JOIN clients c ON c.id = so.client_id
       INNER JOIN services s ON s.id = so.service_id
       LEFT JOIN invoices i ON i.id = so.invoice_id
       LEFT JOIN contracted_services cs ON cs.id = so.contracted_service_id
       LEFT JOIN users u ON u.id = so.reviewed_by
       ${where}
       ORDER BY
         CASE WHEN so.approval_status = 'pending' THEN 0 ELSE 1 END,
         so.id DESC
       LIMIT 500`,
      params
    );

    return res.json(rows.map(order => ({
      ...order,
      amount_snapshot: Number(order.amount_snapshot || 0)
    })));
  } catch (e) {
    console.error(
      'Erro listar solicitações:',
      e.code || e.message || 'erro'
    );

    return erro(res, 500, 'Não foi possível listar as solicitações.');
  }
});

// --------------------------------------------------
// SOLICITAÇÕES — APROVAR OU REJEITAR
// --------------------------------------------------

app.patch(
  '/api/service-orders/:id/review',
  autenticado,
  somenteAdmin,
  async (req, res) => {
    let conn;

    try {
      const orderId = validarId(req.params.id);
      const decision = req.body.decision;

      const adminNotes = typeof req.body.admin_notes === 'string'
        ? req.body.admin_notes.trim()
        : '';

      if (!orderId) {
        return erro(
          res,
          400,
          'Identificador de solicitação inválido.'
        );
      }

      if (!['approved', 'rejected'].includes(decision)) {
        return erro(
          res,
          400,
          'Escolha aprovar ou rejeitar a solicitação.'
        );
      }

      if (adminNotes.length > 5000) {
        return erro(
          res,
          400,
          'As observações devem ter até 5000 caracteres.'
        );
      }

      conn = await db.getConnection();
      await conn.beginTransaction();

      const [orders] = await conn.query(
        `SELECT id, client_id, service_id, description_snapshot,
                amount_snapshot, billing_cycle_snapshot, approval_status,
                payment_status, invoice_id, contracted_service_id
         FROM service_orders
         WHERE id = ?
         FOR UPDATE`,
        [orderId]
      );

      const order = orders[0];
      let contractedServiceId = order?.contracted_service_id
        ? Number(order.contracted_service_id)
        : null;

      if (!order) {
        await conn.rollback();
        return erro(res, 404, 'Solicitação não encontrada.');
      }

      if (order.approval_status !== 'pending') {
        await conn.rollback();

        return erro(
          res,
          409,
          'Esta solicitação já foi analisada e não pode ser alterada novamente.'
        );
      }

      if (decision === 'approved') {
        const [clients] = await conn.query(
          `SELECT id, status
           FROM clients
           WHERE id = ?
           LIMIT 1`,
          [order.client_id]
        );

        if (!clients.length || clients[0].status !== 'active') {
          await conn.rollback();

          return erro(
            res,
            409,
            'O cliente não existe ou está inativo. A solicitação não foi aprovada.'
          );
        }

        const [services] = await conn.query(
          `SELECT id, name, description, active
           FROM services
           WHERE id = ?
           LIMIT 1`,
          [order.service_id]
        );

        if (!services.length || !services[0].active) {
          await conn.rollback();

          return erro(
            res,
            409,
            'O serviço não existe ou está inativo. A solicitação não foi aprovada.'
          );
        }

        const service = services[0];

        const [existingServiceRows] = order.contracted_service_id
          ? await conn.query(
              'SELECT id FROM contracted_services WHERE id = ? LIMIT 1',
              [order.contracted_service_id]
            )
          : [[]];

        if (existingServiceRows.length) {
          contractedServiceId = Number(existingServiceRows[0].id);
        } else {
          const operationalStatus = order.payment_status === 'paid'
            ? 'preparing'
            : 'awaiting_payment';
          const [createdService] = await conn.query(
            `INSERT INTO contracted_services (
               client_id, service_id, name, description, status,
               billing_cycle, sale_price, supplier_cost, notes, operational_status
             ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?)`,
            [
              order.client_id,
              order.service_id,
              order.description_snapshot || service.name,
              service.description || null,
              order.billing_cycle_snapshot,
              Number(order.amount_snapshot || 0),
              `Criado pela aprovação da solicitação #${order.id}.`,
              operationalStatus
            ]
          );
          contractedServiceId = Number(createdService.insertId);

          if (operationalStatus === 'preparing') {
            await conn.query(
              `INSERT INTO contracted_service_status_history
                (contracted_service_id, previous_status, new_status, note, changed_by)
               VALUES (?, 'awaiting_payment', 'preparing', ?, ?)`,
              [
                contractedServiceId,
                `Serviço da solicitação #${order.id} já estava pago no momento da aprovação.`,
                req.session.user.id
              ]
            );
          }
        }
      }

      await conn.query(
        `UPDATE service_orders
         SET approval_status = ?,
             admin_notes = ?,
             reviewed_by = ?,
             reviewed_at = CURRENT_TIMESTAMP,
             contracted_service_id = COALESCE(?, contracted_service_id)
         WHERE id = ?`,
        [
          decision,
          adminNotes || null,
          req.session.user.id,
          contractedServiceId || null,
          orderId
        ]
      );

      await conn.commit();

      return res.json({
        mensagem: decision === 'approved'
          ? 'Solicitação aprovada. O serviço foi criado como pendente de ativação.'
          : 'Solicitação rejeitada.',
        id: orderId,
        approval_status: decision
      });
    } catch (e) {
      if (conn) {
        await conn.rollback().catch(() => {});
      }

      console.error(
        'Erro analisar solicitação:',
        e.code || e.message || 'erro'
      );

      return erro(res, 500, 'Não foi possível analisar a solicitação.');
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }
);

// --------------------------------------------------
// FATURAS
// --------------------------------------------------

app.get('/api/invoices', autenticado, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT i.*, c.name AS client_name
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      ORDER BY i.id DESC
      LIMIT 500
    `);

    return res.json(rows);
  } catch (e) {
    console.error('Erro faturas:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível listar as faturas.');
  }
});

app.post('/api/invoices', autenticado, somenteAdmin, async (req, res) => {
  let conn;

  try {
    const {
      client_id,
      description,
      amount,
      due_date = null
    } = req.body;

    const clientId = validarId(client_id);

    if (
      !clientId ||
      !validarTexto(description, 255) ||
      !valorMonetario(amount) ||
      !validarData(due_date)
    ) {
      return erro(
        res,
        400,
        'Confira cliente, descrição, valor e vencimento.'
      );
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [clients] = await conn.query(
      `SELECT id
       FROM clients
       WHERE id = ? AND status = 'active'
       FOR UPDATE`,
      [clientId]
    );

    if (!clients.length) {
      await conn.rollback();
      return erro(res, 404, 'Cliente ativo não encontrado.');
    }

    const [result] = await conn.query(
      `INSERT INTO invoices
        (client_id, description, amount, status, due_date)
       VALUES (?, ?, ?, 'pending', ?)`,
      [clientId, description.trim(), Number(amount), due_date || null]
    );

    // Se a fatura foi criada para pedidos do checkout, vincula-os
    // imediatamente, antes do pagamento. A função só vincula quando
    // cliente, IDs e soma dos pedidos conferem exatamente com a fatura.
    const pedidosVinculados = await vincularSolicitacoesDaFatura(
      conn,
      result.insertId
    );

    await conn.commit();

    return res.status(201).json({
      id: result.insertId,
      pedidos_vinculados: pedidosVinculados.length,
      mensagem: 'Fatura criada.'
    });
  } catch (e) {
    if (conn) {
      await conn.rollback().catch(() => {});
    }

    console.error('Erro criar fatura:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível criar a fatura.');
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

// --------------------------------------------------
// REGISTRAR PAGAMENTO INTEGRAL
// --------------------------------------------------

app.post('/api/invoices/:id/payments', autenticado, somenteAdmin, async (req, res) => {
  let conn;

  try {
    const invoiceId = validarId(req.params.id);
    const { method = 'manual', reference = null } = req.body;

    if (
      !invoiceId ||
      !validarTexto(method, 60) ||
      (reference && !validarTexto(reference, 190))
    ) {
      return erro(res, 400, 'Dados de pagamento inválidos.');
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, amount, status
       FROM invoices
       WHERE id = ?
       FOR UPDATE`,
      [invoiceId]
    );

    const invoice = rows[0];

    if (!invoice) {
      await conn.rollback();
      return erro(res, 404, 'Fatura não encontrada.');
    }

    if (!['pending', 'overdue'].includes(invoice.status)) {
      await conn.rollback();
      return erro(res, 409, 'Esta fatura não está pendente.');
    }

    await conn.query(
      `INSERT INTO payments (invoice_id, amount, method, reference)
       VALUES (?, ?, ?, ?)`,
      [invoice.id, invoice.amount, method, reference || null]
    );

    await conn.query(
      `UPDATE invoices SET status = 'paid' WHERE id = ?`,
      [invoice.id]
    );

    const solicitacoesProcessadas = await processarSolicitacoesPagas(conn, invoice.id);
    await conn.commit();

    return res.status(201).json({
      mensagem: 'Pagamento registrado.',
      solicitacoes_processadas: solicitacoesProcessadas
    });
  } catch (e) {
    if (conn) {
      await conn.rollback().catch(() => {});
    }

    console.error('Erro pagamento:', e.code || e.message || 'erro');

    return erro(res, 500, 'Não foi possível registrar o pagamento.');
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

// --------------------------------------------------
// ATUALIZAR FATURAS VENCIDAS
// --------------------------------------------------

app.post('/api/invoices/refresh-overdue', autenticado, somenteAdmin, async (req, res) => {
  try {
    await db.query(`
      UPDATE invoices
      SET status = 'overdue'
      WHERE status = 'pending'
        AND due_date IS NOT NULL
        AND due_date < CURRENT_DATE
    `);

    return res.json({
      mensagem: 'Faturas vencidas atualizadas.'
    });
  } catch (e) {
    console.error(
      'Erro atualizar vencimentos:',
      e.code || e.message || 'erro'
    );

    return erro(res, 500, 'Não foi possível atualizar os vencimentos.');
  }
});

// --------------------------------------------------
// USUÁRIOS — EDITAR, ATIVAR/INATIVAR E REDEFINIR SENHA
// --------------------------------------------------

async function contarAdminsAtivos(excluirId = null) {
  const params = [];
  let sql = `SELECT COUNT(*) AS total
             FROM users
             WHERE role = 'admin' AND active = 1`;

  if (excluirId) {
    sql += ' AND id <> ?';
    params.push(excluirId);
  }

  const [[linha]] = await db.query(sql, params);
  return Number(linha.total);
}

app.put('/api/users/:id', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);
    const { name, role } = req.body;

    if (!id) {
      return erro(res, 400, 'Identificador de usuário inválido.');
    }

    if (!validarTexto(name, 120) || !['admin', 'staff'].includes(role)) {
      return erro(res, 400, 'Informe um nome e um perfil válidos.');
    }

    const [rows] = await db.query(
      'SELECT id, role, active FROM users WHERE id = ? LIMIT 1',
      [id]
    );

    const alvo = rows[0];

    if (!alvo) {
      return erro(res, 404, 'Usuário não encontrado.');
    }

    if (alvo.role === 'admin' && role !== 'admin') {
      if (id === req.session.user.id) {
        return erro(res, 409, 'Você não pode remover seu próprio perfil de administrador.');
      }

      if (alvo.active && (await contarAdminsAtivos(id)) === 0) {
        return erro(res, 409, 'É necessário manter ao menos um administrador ativo.');
      }
    }

    await db.query(
      'UPDATE users SET name = ?, role = ? WHERE id = ?',
      [name.trim(), role, id]
    );

    if (id === req.session.user.id) {
      req.session.user.name = name.trim();
    }

    return res.json({ mensagem: 'Usuário atualizado.' });
  } catch (e) {
    console.error('Erro editar usuário:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível atualizar o usuário.');
  }
});

app.patch('/api/users/:id/status', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);

    if (!id) {
      return erro(res, 400, 'Identificador de usuário inválido.');
    }

    const ativo = normalizarBooleano(req.body.active, false);

    const [rows] = await db.query(
      'SELECT id, role, active FROM users WHERE id = ? LIMIT 1',
      [id]
    );

    const alvo = rows[0];

    if (!alvo) {
      return erro(res, 404, 'Usuário não encontrado.');
    }

    if (!ativo) {
      if (id === req.session.user.id) {
        return erro(res, 409, 'Você não pode inativar a sua própria conta.');
      }

      if (alvo.role === 'admin' && alvo.active && (await contarAdminsAtivos(id)) === 0) {
        return erro(res, 409, 'É necessário manter ao menos um administrador ativo.');
      }
    }

    await db.query(
      'UPDATE users SET active = ? WHERE id = ?',
      [ativo ? 1 : 0, id]
    );

    return res.json({
      mensagem: ativo ? 'Usuário ativado.' : 'Usuário inativado.'
    });
  } catch (e) {
    console.error('Erro status usuário:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível alterar o status do usuário.');
  }
});

app.post('/api/users/:id/password', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);
    const { password } = req.body;

    if (!id) {
      return erro(res, 400, 'Identificador de usuário inválido.');
    }

    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return erro(res, 400, 'A senha deve ter entre 12 e 128 caracteres.');
    }

    const [rows] = await db.query(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [id]
    );

    if (!rows.length) {
      return erro(res, 404, 'Usuário não encontrado.');
    }

    const hash = await bcrypt.hash(password, 12);

    await db.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [hash, id]
    );

    return res.json({ mensagem: 'Senha redefinida.' });
  } catch (e) {
    console.error('Erro redefinir senha:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível redefinir a senha.');
  }
});

// --------------------------------------------------
// MINHA CONTA — ALTERAR PRÓPRIA SENHA
// --------------------------------------------------

app.post('/api/me/password', autenticado, somenteAdmin, async (req, res) => {
  try {
    const { current_password: atual, new_password: nova } = req.body;

    if (typeof atual !== 'string' || !atual) {
      return erro(res, 400, 'Informe a senha atual.');
    }

    if (typeof nova !== 'string' || nova.length < 12 || nova.length > 128) {
      return erro(res, 400, 'A nova senha deve ter entre 12 e 128 caracteres.');
    }

    if (nova === atual) {
      return erro(res, 400, 'A nova senha deve ser diferente da atual.');
    }

    const [rows] = await db.query(
      'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
      [req.session.user.id]
    );

    if (!rows.length || !(await bcrypt.compare(atual, rows[0].password_hash))) {
      return erro(res, 403, 'A senha atual está incorreta.');
    }

    const hash = await bcrypt.hash(nova, 12);

    await db.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [hash, req.session.user.id]
    );

    return res.json({ mensagem: 'Senha alterada com sucesso.' });
  } catch (e) {
    console.error('Erro alterar senha:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível alterar a senha.');
  }
});

// --------------------------------------------------
// FATURAS — CANCELAR
// --------------------------------------------------

app.patch('/api/invoices/:id/cancel', autenticado, somenteAdmin, async (req, res) => {
  try {
    const id = validarId(req.params.id);

    if (!id) {
      return erro(res, 400, 'Identificador de fatura inválido.');
    }

    const [result] = await db.query(
      `UPDATE invoices
       SET status = 'cancelled'
       WHERE id = ? AND status IN ('pending', 'overdue')`,
      [id]
    );

    if (!result.affectedRows) {
      return erro(res, 409, 'Somente faturas pendentes ou vencidas podem ser canceladas.');
    }

    return res.json({ mensagem: 'Fatura cancelada.' });
  } catch (e) {
    console.error('Erro cancelar fatura:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível cancelar a fatura.');
  }
});

// --------------------------------------------------
// MERCADO PAGO PIX — EMISSÃO E CONFIRMAÇÃO VALIDADA
// --------------------------------------------------

const crypto = require('crypto');
const MP_API_BASE = 'https://api.mercadopago.com';

function mercadoPagoConfigurado() {
  return Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_WEBHOOK_SECRET);
}

async function mercadoPagoRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Accept': 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    throw new Error(`Resposta inválida do Mercado Pago (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const causes = Array.isArray(data.cause)
      ? data.cause.map(item => item.code || item.description).filter(Boolean).join('; ')
      : '';
    const detail = data.message || causes || data.error || `HTTP ${response.status}`;
    throw new Error(`Mercado Pago: ${String(detail).slice(0, 350)}`);
  }
  return data;
}

async function garantirTabelaMercadoPago() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mercadopago_transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      invoice_id BIGINT UNSIGNED NOT NULL,
      payment_id VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      amount DECIMAL(12,2) NOT NULL,
      pix_code TEXT DEFAULT NULL,
      pix_url TEXT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_mp_payment_id (payment_id),
      KEY idx_mp_invoice_id (invoice_id),
      KEY idx_mp_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function validarAssinaturaMercadoPago(req) {
  const segredo = process.env.MP_WEBHOOK_SECRET;
  const assinatura = req.get('x-signature') || '';
  const requestId = req.get('x-request-id') || '';
  const dataIdRaw = typeof req.query['data.id'] === 'string'
    ? req.query['data.id']
    : (typeof req.query.id === 'string' ? req.query.id : '');
  const dataId = dataIdRaw.trim().toLowerCase();

  if (!segredo) return { valida: false, motivo: 'segredo_ausente' };
  if (!assinatura) return { valida: false, motivo: 'cabecalho_x_signature_ausente' };
  if (!requestId) return { valida: false, motivo: 'cabecalho_x_request_id_ausente' };
  if (!dataId) return { valida: false, motivo: 'parametro_data_id_ausente' };

  const partes = {};
  for (const parte of assinatura.split(',')) {
    const separador = parte.indexOf('=');
    if (separador < 1) continue;
    const chave = parte.slice(0, separador).trim();
    const valor = parte.slice(separador + 1).trim();
    if (chave && valor) partes[chave] = valor;
  }

  if (!partes.ts || !partes.v1 || !/^[a-f0-9]{64}$/i.test(partes.v1)) {
    return { valida: false, motivo: 'formato_x_signature_invalido' };
  }

  const manifesto = `id:${dataId};request-id:${requestId};ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', segredo).update(manifesto).digest();
  const recebidoBuffer = Buffer.from(partes.v1, 'hex');

  if (recebidoBuffer.length !== esperado.length) {
    return { valida: false, motivo: 'assinatura_nao_confere' };
  }

  return {
    valida: crypto.timingSafeEqual(recebidoBuffer, esperado),
    motivo: 'assinatura_nao_confere'
  };
}

async function garantirTabelaCheckoutPro() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mercadopago_checkout_preferences (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      invoice_id BIGINT UNSIGNED NOT NULL,
      preference_id VARCHAR(100) NOT NULL,
      payment_id VARCHAR(64) DEFAULT NULL,
      external_reference VARCHAR(120) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'created',
      amount DECIMAL(12,2) NOT NULL,
      init_point TEXT NOT NULL,
      sandbox_init_point TEXT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_mp_preference_id (preference_id),
      KEY idx_mp_checkout_invoice (invoice_id),
      KEY idx_mp_checkout_payment (payment_id),
      KEY idx_mp_checkout_reference (external_reference)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

app.post('/api/invoices/:id/mercadopago/checkout-pro', autenticado, somenteAdmin, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN) {
    return erro(res, 503, 'Mercado Pago não configurado: falta MP_ACCESS_TOKEN no ambiente.');
  }

  try {
    const invoiceId = validarId(req.params.id);
    if (!invoiceId) return erro(res, 400, 'Identificador da fatura inválido.');

    const [rows] = await db.query(
      `SELECT i.id, i.client_id, i.description, i.amount, i.status,
              c.name AS client_name, c.email AS client_email
       FROM invoices i
       INNER JOIN clients c ON c.id = i.client_id
       WHERE i.id = ? LIMIT 1`,
      [invoiceId]
    );
    const invoice = rows[0];

    if (!invoice) return erro(res, 404, 'Fatura não encontrada.');
    if (!['pending', 'overdue'].includes(invoice.status)) {
      return erro(res, 409, 'Somente faturas pendentes ou vencidas podem receber um link de Checkout Pro.');
    }

    // Checkout Pro em produção: usar somente credenciais oficiais de produção.
    // MP_ENVIRONMENT é uma confirmação explícita do operador; o prefixo APP_USR-
    // sozinho não diferencia tokens de produção de tokens de contas de teste.
    if (String(process.env.MP_ENVIRONMENT || '').trim().toLowerCase() !== 'production') {
      return erro(res, 409, 'Checkout Pro está bloqueado até configurar MP_ENVIRONMENT=production e credenciais oficiais de produção no servidor.');
    }
    if (!String(process.env.MP_ACCESS_TOKEN || '').startsWith('APP_USR-')) {
      return erro(res, 409, 'O Access Token não parece válido. Confira as Credenciais de produção da aplicação Central VortexGrid.');
    }

    if (!validarEmail(invoice.client_email)) {
      return erro(res, 400, 'O cadastro do cliente precisa ter um e-mail válido antes de criar o checkout.');
    }

    const amount = Number(invoice.amount);
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 99999999) {
      return erro(res, 400, 'Valor da fatura inválido para emissão do Checkout Pro.');
    }

    const baseUrl = String(process.env.PUBLIC_BASE_URL || 'https://central.vortexgrid.com.br').replace(/\/$/, '');
    const notificationUrl = `${baseUrl}/api/webhooks/mercadopago`;
    const externalReference = `vortexgrid-invoice-${invoice.id}`;
    const description = String(invoice.description || `Fatura VortexGrid #${invoice.id}`).slice(0, 250);
    const payload = {
      items: [{
        id: String(invoice.id),
        title: description,
        description,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(amount.toFixed(2))
      }],
      external_reference: externalReference,
      notification_url: notificationUrl,
      back_urls: {
        success: `${baseUrl}/?checkout=success&invoice_id=${invoice.id}`,
        pending: `${baseUrl}/?checkout=pending&invoice_id=${invoice.id}`,
        failure: `${baseUrl}/?checkout=failure&invoice_id=${invoice.id}`
      },
      auto_return: 'approved',
      // Identificação curta da marca na cobrança; a personalização visual
      // completa do checkout é limitada ao que o Mercado Pago disponibiliza.
      statement_descriptor: 'VORTEXGRID',
      payer: { email: invoice.client_email },
      // Não definimos installments: o Checkout Pro aplica as condições
      // de parcelamento disponíveis para a conta e para o comprador.
      payment_methods: {
        // Mantém Pix, cartões e saldo Mercado Pago; remove boleto/lotérica
        // do checkout padrão. A disponibilidade final depende da conta.
        excluded_payment_types: [{ id: 'ticket' }]
      }
    };

    const preference = await mercadoPagoRequest(`${MP_API_BASE}/checkout/preferences`, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(payload)
    });

    const preferenceId = preference.id ? String(preference.id) : '';
    const initPoint = typeof preference.init_point === 'string' ? preference.init_point : '';
    const sandboxInitPoint = typeof preference.sandbox_init_point === 'string'
      ? preference.sandbox_init_point
      : null;

    if (!preferenceId || !/^https:\/\//i.test(initPoint)) {
      console.error('Mercado Pago não retornou uma preferência Checkout Pro válida.', {
        preferenceIdPresent: Boolean(preferenceId),
        initPointPresent: Boolean(initPoint)
      });
      return erro(res, 502, 'O Mercado Pago não retornou o link do Checkout Pro.');
    }

    await garantirTabelaCheckoutPro();
    await db.query(
      `INSERT INTO mercadopago_checkout_preferences
        (invoice_id, preference_id, external_reference, status, amount, init_point, sandbox_init_point)
       VALUES (?, ?, ?, 'created', ?, ?, ?)`,
      [invoice.id, preferenceId, externalReference, amount, initPoint, sandboxInitPoint]
    );

    // Checkout Pro com vendedor/comprador de teste usa init_point.
    // A simulação depende de usar as credenciais do vendedor de teste e entrar
    // no checkout com a conta compradora de teste, não de sandbox_init_point.
    const checkoutUrl = initPoint;

    return res.status(201).json({
      mensagem: 'Preferência Checkout Pro criada.',
      invoice_id: invoice.id,
      preference_id: preferenceId,
      external_reference: externalReference,
      amount,
      init_point: initPoint,
      sandbox_init_point: sandboxInitPoint,
      checkout_url: checkoutUrl
    });
  } catch (e) {
    console.error('Erro criar preferência Checkout Pro:', e.message || e.code || 'erro');
    return erro(res, 502, 'Não foi possível criar a preferência Checkout Pro. Confira as credenciais e o log da aplicação.');
  }
});

app.post('/api/invoices/:id/mercadopago/pix', autenticado, somenteAdmin, async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN) {
    return erro(res, 503, 'Mercado Pago não configurado: falta MP_ACCESS_TOKEN no ambiente.');
  }

  try {
    const invoiceId = validarId(req.params.id);
    const cpf = typeof req.body.payer_cpf_cnpj === 'string'
      ? req.body.payer_cpf_cnpj.replace(/\D/g, '')
      : '';
    const daysDue = req.body.days_due_date === undefined ? 1 : Number(req.body.days_due_date);

    if (!invoiceId) return erro(res, 400, 'Identificador da fatura inválido.');
    if (!/^\d{11}$|^\d{14}$/.test(cpf)) {
      return erro(res, 400, 'Informe CPF ou CNPJ válido do pagador (somente números).');
    }
    if (!Number.isInteger(daysDue) || daysDue < 1 || daysDue > 30) {
      return erro(res, 400, 'O vencimento do PIX deve ficar entre 1 e 30 dias.');
    }

    await garantirTabelaMercadoPago();
    const [rows] = await db.query(
      `SELECT i.id, i.client_id, i.description, i.amount, i.status,
              c.name AS client_name, c.email AS client_email
       FROM invoices i
       INNER JOIN clients c ON c.id = i.client_id
       WHERE i.id = ? LIMIT 1`,
      [invoiceId]
    );
    const invoice = rows[0];

    if (!invoice) return erro(res, 404, 'Fatura não encontrada.');
    if (!['pending', 'overdue'].includes(invoice.status)) {
      return erro(res, 409, 'Somente faturas pendentes ou vencidas podem receber um PIX.');
    }

    const amount = Number(invoice.amount);
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 99999999) {
      return erro(res, 400, 'Valor da fatura inválido para emissão do PIX.');
    }
    if (!validarEmail(invoice.client_email)) {
      return erro(res, 400, 'O cadastro do cliente precisa ter um e-mail válido antes de emitir o PIX.');
    }

    const notificationUrl = `${String(process.env.PUBLIC_BASE_URL || 'https://central.vortexgrid.com.br').replace(/\/$/, '')}/api/webhooks/mercadopago`;
    const idempotencyKey = crypto.randomUUID();
    const payload = {
      transaction_amount: Number(amount.toFixed(2)),
      description: String(invoice.description || `Fatura VortexGrid #${invoice.id}`).slice(0, 250),
      payment_method_id: 'pix',
      external_reference: `vortexgrid-invoice-${invoice.id}`,
      notification_url: notificationUrl,
      date_of_expiration: new Date(Date.now() + daysDue * 86400000).toISOString(),
      payer: {
        email: invoice.client_email,
        first_name: String(invoice.client_name || 'Cliente').trim().split(/\s+/)[0].slice(0, 80),
        identification: {
          type: cpf.length === 11 ? 'CPF' : 'CNPJ',
          number: cpf
        }
      }
    };

    const payment = await mercadoPagoRequest(`${MP_API_BASE}/v1/payments`, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload)
    });

    const paymentId = payment.id ? String(payment.id) : '';
    const pixData = payment.point_of_interaction?.transaction_data || {};
    const pixCode = typeof pixData.qr_code === 'string' ? pixData.qr_code : null;
    const pixUrl = typeof pixData.ticket_url === 'string' ? pixData.ticket_url : null;

    if (!paymentId || (!pixCode && !pixUrl)) {
      console.error('Mercado Pago não retornou dados PIX esperados:', {
        paymentIdPresent: Boolean(paymentId),
        status: payment.status || 'ausente',
        detail: payment.status_detail || 'sem detalhe'
      });
      return erro(res, 502, 'O Mercado Pago não retornou os dados esperados do PIX. Confira o log.');
    }

    await db.query(
      `INSERT INTO mercadopago_transactions
        (invoice_id, payment_id, status, amount, pix_code, pix_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [invoice.id, paymentId, String(payment.status || 'pending'), amount, pixCode, pixUrl]
    );

    return res.status(201).json({
      mensagem: 'PIX emitido pelo Mercado Pago.',
      invoice_id: invoice.id,
      payment_id: paymentId,
      amount,
      status: payment.status || 'pending',
      pix_code: pixCode,
      pix_url: pixUrl,
      qr_code_base64: pixData.qr_code_base64 || null,
      expiration_date: payment.date_of_expiration || null
    });
  } catch (e) {
    console.error('Erro emissão PIX Mercado Pago:', e.message || e.code || 'erro');
    return erro(res, 502, 'Não foi possível emitir o PIX pelo Mercado Pago. Confira as credenciais e o log da aplicação.');
  }
});

// --------------------------------------------------
// MERCADO PAGO — DIAGNÓSTICO SOMENTE LEITURA (ADMIN)
// Consulta o pagamento na API e compara com os registros locais,
// sem criar cobrança, registrar recebimento ou alterar fatura.
// --------------------------------------------------
app.get('/api/admin/mercadopago/diagnostico/:paymentId', autenticado, somenteAdmin, async (req, res) => {
  const paymentId = typeof req.params.paymentId === 'string' ? req.params.paymentId.trim() : '';

  if (!/^\d{1,30}$/.test(paymentId)) {
    return erro(res, 400, 'ID de pagamento inválido.');
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return erro(res, 503, 'Mercado Pago não configurado: falta MP_ACCESS_TOKEN no ambiente.');
  }

  try {
    const payment = await mercadoPagoRequest(
      `${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`,
      { method: 'GET' }
    );

    const [transactionRows] = await db.query(
      `SELECT id, invoice_id, payment_id, status, amount, created_at, updated_at
       FROM mercadopago_transactions
       WHERE payment_id = ?
       LIMIT 1`,
      [String(payment.id)]
    );
    const transaction = transactionRows[0] || null;

    let invoice = null;
    if (transaction) {
      const [invoiceRows] = await db.query(
        'SELECT id, amount, status, description FROM invoices WHERE id = ? LIMIT 1',
        [transaction.invoice_id]
      );
      invoice = invoiceRows[0] || null;
    }

    return res.set('Cache-Control', 'no-store').json({
      somente_leitura: true,
      mercado_pago: {
        payment_id: String(payment.id),
        status: payment.status || null,
        status_detail: payment.status_detail || null,
        transaction_amount: Number(payment.transaction_amount || 0),
        external_reference: payment.external_reference || null,
        currency_id: payment.currency_id || null,
        live_mode: Boolean(payment.live_mode)
      },
      transacao_local: transaction ? {
        id: transaction.id,
        invoice_id: transaction.invoice_id,
        payment_id: transaction.payment_id,
        status: transaction.status,
        amount: Number(transaction.amount),
        valor_confere: Math.round(Number(transaction.amount) * 100) === Math.round(Number(payment.transaction_amount) * 100),
        referencia_confere: payment.external_reference === `vortexgrid-invoice-${transaction.invoice_id}`
      } : null,
      fatura_local: invoice ? {
        id: invoice.id,
        amount: Number(invoice.amount),
        status: invoice.status,
        description: invoice.description
      } : null,
      diagnostico: !transaction
        ? 'Pagamento existe no Mercado Pago, mas não foi encontrada transação local com esse payment_id.'
        : !invoice
          ? 'Transação local encontrada, mas a fatura vinculada não foi encontrada.'
          : 'Consulta concluída; nenhum dado foi alterado.'
    });
  } catch (e) {
    console.error('Erro diagnóstico Mercado Pago:', e.message || e.code || 'erro');
    return erro(res, 502, 'Não foi possível consultar o pagamento no Mercado Pago. Confira o log da aplicação.');
  }
});

// --------------------------------------------------
// MERCADO PAGO — CONCILIAÇÃO MANUAL VALIDADA (ADMIN)
// Revalida o pagamento diretamente na API antes de registrar
// o recebimento. Operação idempotente por referência do pagamento.
// --------------------------------------------------
app.post('/api/admin/mercadopago/conciliar/:paymentId', autenticado, somenteAdmin, async (req, res) => {
  const paymentId = typeof req.params.paymentId === 'string'
    ? req.params.paymentId.trim()
    : '';

  if (!/^\d{1,30}$/.test(paymentId)) {
    return erro(res, 400, 'ID de pagamento inválido.');
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return erro(res, 503, 'Mercado Pago não configurado: falta MP_ACCESS_TOKEN no ambiente.');
  }

  let conn;
  try {
    await garantirTabelaMercadoPago();

    // A fonte de verdade é consultada ao vivo; não confiamos no diagnóstico anterior.
    const payment = await mercadoPagoRequest(
      `${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`,
      { method: 'GET' }
    );

    if (String(payment.id) !== paymentId) {
      return erro(res, 409, 'O ID retornado pelo Mercado Pago não corresponde ao solicitado.');
    }

    if (payment.status !== 'approved' || payment.status_detail !== 'accredited') {
      return erro(res, 409, 'O Mercado Pago ainda não confirma este pagamento como aprovado e creditado.');
    }

    if (payment.currency_id !== 'BRL' || !payment.live_mode) {
      return erro(res, 409, 'O pagamento não pertence ao ambiente de produção em BRL.');
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [transactionRows] = await conn.query(
      `SELECT id, invoice_id, payment_id, status, amount
       FROM mercadopago_transactions
       WHERE payment_id = ?
       LIMIT 1
       FOR UPDATE`,
      [paymentId]
    );
    const local = transactionRows[0];

    if (!local) {
      await conn.rollback();
      return erro(res, 404, 'Não existe transação local para este pagamento. Nenhum dado foi alterado.');
    }

    const expectedAmount = Number(local.amount);
    const paidAmount = Number(payment.transaction_amount);
    const expectedReference = `vortexgrid-invoice-${local.invoice_id}`;

    if (
      payment.external_reference !== expectedReference ||
      !Number.isFinite(paidAmount) ||
      !Number.isFinite(expectedAmount) ||
      Math.round(paidAmount * 100) !== Math.round(expectedAmount * 100)
    ) {
      await conn.rollback();
      return erro(res, 409, 'O valor ou a referência do pagamento não corresponde à transação local.');
    }

    const [invoiceRows] = await conn.query(
      'SELECT id, amount, status FROM invoices WHERE id = ? FOR UPDATE',
      [local.invoice_id]
    );
    const invoice = invoiceRows[0];

    if (
      !invoice ||
      Math.round(Number(invoice.amount) * 100) !== Math.round(expectedAmount * 100)
    ) {
      await conn.rollback();
      return erro(res, 409, 'A fatura não corresponde ao valor confirmado pelo Mercado Pago.');
    }

    await conn.query(
      'UPDATE mercadopago_transactions SET status = ? WHERE payment_id = ?',
      ['approved', paymentId]
    );

    const [existingPayments] = await conn.query(
      'SELECT id FROM payments WHERE reference = ? LIMIT 1',
      [`mercadopago:${paymentId}`]
    );

    let paymentRecorded = false;
    if (!existingPayments.length) {
      await conn.query(
        'INSERT INTO payments (invoice_id, amount, method, reference) VALUES (?, ?, ?, ?)',
        [local.invoice_id, expectedAmount, 'mercadopago_pix', `mercadopago:${paymentId}`]
      );
      paymentRecorded = true;
    }

    await conn.query(
      "UPDATE invoices SET status = 'paid' WHERE id = ?",
      [local.invoice_id]
    );

    const solicitacoesProcessadas = await processarSolicitacoesPagas(conn, local.invoice_id);
    await conn.commit();

    console.info('Conciliação manual Mercado Pago concluída.', {
      paymentId,
      invoiceId: local.invoice_id,
      paymentRecorded
    });

    return res.set('Cache-Control', 'no-store').json({
      conciliado: true,
      payment_id: paymentId,
      invoice_id: Number(local.invoice_id),
      status_mercado_pago: payment.status,
      status_transacao_local: 'approved',
      status_fatura: 'paid',
      recebimento_novo: paymentRecorded,
      solicitacoes_processadas: solicitacoesProcessadas,
      mensagem: paymentRecorded
        ? 'Pagamento validado e recebimento registrado; fatura marcada como paga.'
        : 'Pagamento já estava registrado; fatura confirmada como paga sem duplicar o recebimento.'
    });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('Erro conciliação manual Mercado Pago:', e.message || e.code || 'erro');
    return erro(res, 500, 'Não foi possível conciliar o pagamento. Nenhuma confirmação deve ser presumida.');
  } finally {
    if (conn) conn.release();
  }
});

app.get('/api/webhooks/mercadopago', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(405).json({
    erro: 'Endpoint disponível. O webhook do Mercado Pago recebe notificações por POST.'
  });
});

app.post('/api/webhooks/mercadopago', async (req, res) => {
  if (!process.env.MP_ACCESS_TOKEN || !process.env.MP_WEBHOOK_SECRET) {
    console.error('Webhook Mercado Pago recebido, mas faltam MP_ACCESS_TOKEN ou MP_WEBHOOK_SECRET.');
    return erro(res, 503, 'Webhook Mercado Pago não configurado no servidor.');
  }

  const resultadoAssinatura = validarAssinaturaMercadoPago(req);
  if (!resultadoAssinatura.valida) {
    // Registra apenas o motivo técnico; nunca registra token, segredo ou assinatura.
    console.warn('Webhook Mercado Pago rejeitado na validação:', resultadoAssinatura.motivo);
    return erro(res, 401, 'Assinatura do webhook inválida.');
  }

  const topic = String(req.query.type || req.body?.type || req.body?.topic || '').toLowerCase();
  const paymentId = String(req.query['data.id'] || req.query.id || req.body?.data?.id || '').trim();
  if (!paymentId || (topic && !['payment', 'payments'].includes(topic))) {
    return res.status(200).json({ recebido: true, ignorado: true });
  }

  let conn;
  try {
    await garantirTabelaMercadoPago();
    const payment = await mercadoPagoRequest(`${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET'
    });
    const [transactions] = await db.query(
      'SELECT id, invoice_id, payment_id, amount, status FROM mercadopago_transactions WHERE payment_id = ? LIMIT 1',
      [String(payment.id)]
    );

    let local = transactions[0] ? { ...transactions[0], source: 'pix' } : null;

    if (!local) {
      const externalReference = String(payment.external_reference || '');
      const match = externalReference.match(/^vortexgrid-invoice-(\d+)$/);
      const referencedInvoiceId = match ? Number(match[1]) : 0;

      if (referencedInvoiceId > 0) {
        await garantirTabelaCheckoutPro();
        const [preferences] = await db.query(
          `SELECT id, invoice_id, preference_id, payment_id, external_reference, amount, status
           FROM mercadopago_checkout_preferences
           WHERE invoice_id = ? AND external_reference = ?
           ORDER BY id DESC
           LIMIT 1`,
          [referencedInvoiceId, externalReference]
        );
        if (preferences[0]) {
          local = { ...preferences[0], source: 'checkout_pro' };
        }
      }
    }

    if (!local) {
      console.warn('Webhook Mercado Pago sem transação local correspondente.', { paymentId: String(payment.id) });
      return res.status(200).json({ recebido: true, ignorado: true });
    }

    const paidAmount = Number(payment.transaction_amount);
    const expectedAmount = Number(local.amount);
    const expectedReference = local.external_reference || `vortexgrid-invoice-${local.invoice_id}`;
    if (payment.external_reference !== expectedReference ||
        !Number.isFinite(paidAmount) ||
        Math.round(paidAmount * 100) !== Math.round(expectedAmount * 100)) {
      console.error('Mercado Pago: pagamento não conciliado por referência ou valor.', {
        paymentId: String(payment.id),
        invoiceId: local.invoice_id
      });
      return erro(res, 409, 'Pagamento não corresponde à fatura local.');
    }

    const status = String(payment.status || 'unknown');
    conn = await db.getConnection();
    await conn.beginTransaction();
    if (local.source === 'checkout_pro') {
      await conn.query(
        'UPDATE mercadopago_checkout_preferences SET status = ?, payment_id = ? WHERE id = ?',
        [status.slice(0, 32), String(payment.id), local.id]
      );
    } else {
      await conn.query(
        'UPDATE mercadopago_transactions SET status = ? WHERE payment_id = ?',
        [status.slice(0, 32), String(payment.id)]
      );
    }

    if (status === 'approved') {
      const [invoiceRows] = await conn.query(
        'SELECT id, amount, status FROM invoices WHERE id = ? FOR UPDATE',
        [local.invoice_id]
      );
      const invoice = invoiceRows[0];
      if (!invoice || Math.round(Number(invoice.amount) * 100) !== Math.round(expectedAmount * 100)) {
        await conn.rollback();
        return erro(res, 409, 'A fatura não corresponde ao valor confirmado pelo Mercado Pago.');
      }

      const [existingPayments] = await conn.query(
        "SELECT id FROM payments WHERE reference = ? LIMIT 1",
        [`mercadopago:${payment.id}`]
      );
      if (!existingPayments.length) {
        await conn.query(
          'INSERT INTO payments (invoice_id, amount, method, reference) VALUES (?, ?, ?, ?)',
          [
            local.invoice_id,
            expectedAmount,
            local.source === 'checkout_pro' ? 'mercadopago_checkout_pro' : 'mercadopago_pix',
            `mercadopago:${payment.id}`
          ]
        );
      }
      await conn.query("UPDATE invoices SET status = 'paid' WHERE id = ?", [local.invoice_id]);
      const solicitacoesProcessadas = await processarSolicitacoesPagas(conn, local.invoice_id);
      local.solicitacoes_processadas = solicitacoesProcessadas;
    }

    await conn.commit();
    console.info('Webhook Mercado Pago processado.', {
      paymentId: String(payment.id),
      invoiceId: local.invoice_id,
      status
    });
    return res.status(200).json({
      recebido: true,
      status,
      solicitacoes_processadas: Number(local.solicitacoes_processadas || 0)
    });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('Erro webhook Mercado Pago:', e.message || e.code || 'erro');
    return erro(res, 500, 'Não foi possível validar a notificação do Mercado Pago.');
  } finally {
    if (conn) conn.release();
  }
});

// --------------------------------------------------
// INTERFACE E ERROS
// --------------------------------------------------

const publicPath = path.join(__dirname, '../public');

app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.use('/api', (req, res) => {
  return erro(res, 404, 'Rota da API não encontrada.');
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  // JSON malformado deve receber 400, não um 500 genérico.
  if (
    req.path === '/api/webhooks/mercadopago' &&
    err instanceof SyntaxError &&
    err.status === 400 &&
    Object.prototype.hasOwnProperty.call(err, 'body')
  ) {
    console.warn('Webhook Mercado Pago rejeitado: corpo JSON inválido.');
    return erro(res, 400, 'Corpo JSON inválido.');
  }

  console.error(
    'Erro interno:',
    err.code || err.message || err.name || 'erro'
  );

  return erro(res, 500, 'Erro interno do servidor.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VortexGrid Central iniciada na porta ${PORT}`);
});