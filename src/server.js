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

app.set('trust proxy', 1);
app.disable('x-powered-by');

if (!process.env.SESSION_SECRET || !process.env.ADMIN_SETUP_KEY) {
  throw new Error('Configure SESSION_SECRET e ADMIN_SETUP_KEY no .env');
}

app.use(helmet());
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

app.get('/api/dashboard', autenticado, async (req, res) => {
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

    const [[ativacoes]] = await db.query(
      `SELECT COUNT(*) AS total
       FROM contracted_services
       WHERE status IN ('pending', 'provisioning')`
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
    const [ativacoesRecentes] = await db.query("SELECT cs.id, cs.name, cs.status, cs.created_at, cs.updated_at, c.name AS client_name FROM contracted_services cs JOIN clients c ON c.id = cs.client_id ORDER BY COALESCE(cs.updated_at, cs.created_at) DESC, cs.id DESC LIMIT 5");
    const atividadeRecente = [
      ...clientesRecentes.map(item => ({ tipo: 'cliente', titulo: item.name, descricao: item.email || 'Cadastro de cliente', data: item.created_at, pagina: 'clients', ordem: item.created_at ? new Date(item.created_at).getTime() : 0 })),
      ...pagamentosRecentes.map(item => ({ tipo: 'pagamento', titulo: item.client_name, descricao: item.invoice_description || (item.method ? 'Pagamento via ' + item.method : 'Pagamento registrado'), data: item.paid_at, valor: Number(item.amount || 0), pagina: 'finance', ordem: item.paid_at ? new Date(item.paid_at).getTime() : 0 })),
      ...ultimasFaturas.map(item => ({ tipo: 'fatura', titulo: item.client_name, descricao: item.description || ('Fatura #' + item.id), data: item.created_at, valor: Number(item.amount || 0), pagina: 'finance', ordem: item.created_at ? new Date(item.created_at).getTime() : 0 })),
      ...ativacoesRecentes.map(item => ({ tipo: 'ativacao', titulo: item.name || 'Serviço contratado', descricao: item.client_name + ' - Status: ' + item.status, data: item.updated_at || item.created_at, pagina: 'services', ordem: (item.updated_at || item.created_at) ? new Date(item.updated_at || item.created_at).getTime() : 0 })),
      ...solicitacoesRecentes.map(item => ({ tipo: 'solicitacao', titulo: item.client_name, descricao: item.description_snapshot || 'Solicitação de serviço', data: item.created_at, valor: Number(item.amount_snapshot || 0), pagina: 'orders', ordem: item.created_at ? new Date(item.created_at).getTime() : 0 }))
    ].sort((a, b) => b.ordem - a.ordem).slice(0, 8).map(({ ordem, ...item }) => item);

    return res.json({
      clientes: Number(clientes.total),
      servicos: Number(servicos.total),
      servicosCatalogo: Number(servicosCatalogo.total),
      ativacoesPendentes: Number(ativacoes.total),
      usuarios: Number(usuarios.total),
      faturasPendentes: Number(faturas.quantidade),
      valorPendente: Number(faturas.total),
      recebidoMes: Number(recebido.total),
      solicitacoesPendentes: Number(solicitacoes.total),
      faturasVencidas: Number(vencidas.quantidade),
      valorVencido: Number(vencidas.total),
      recebimentosMensais,
      ultimasFaturas: ultimasFaturas.map(item => ({
        ...item,
        amount: Number(item.amount || 0)
      })),
      solicitacoesRecentes,
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

app.get('/api/clients', autenticado, async (req, res) => {
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

app.put('/api/clients/:id', autenticado, async (req, res) => {
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

app.get('/api/clients/:id/record', autenticado, async (req, res) => {
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

    const servicosContratados = contractedServiceRows.map(service => ({
      ...service,
      sale_price: Number(service.sale_price || 0)
    }));

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
                c.parent_id, c.created_at,
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
        `SELECT c.name, p.name AS parent_name
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        description,
        category,
        categoryId,
        price,
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
          `SELECT name
           FROM service_categories
           WHERE id = ? AND active = 1
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
         so.id, so.client_id, so.service_id,
         so.description_snapshot, so.amount_snapshot,
         so.billing_cycle_snapshot, so.approval_status,
         so.payment_status, so.customer_notes, so.admin_notes,
         so.reviewed_by, so.reviewed_at, so.created_at, so.updated_at,
         c.name AS client_name, c.email AS client_email,
         s.name AS service_name, u.name AS reviewed_by_name
       FROM service_orders so
       INNER JOIN clients c ON c.id = so.client_id
       INNER JOIN services s ON s.id = so.service_id
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
                amount_snapshot, billing_cycle_snapshot, approval_status
         FROM service_orders
         WHERE id = ?
         FOR UPDATE`,
        [orderId]
      );

      const order = orders[0];

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

        await conn.query(
          `INSERT INTO contracted_services (
             client_id, service_id, name, description, status,
             billing_cycle, sale_price, supplier_cost, notes
           ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?)`,
          [
            order.client_id,
            order.service_id,
            service.name || order.description_snapshot,
            service.description || null,
            order.billing_cycle_snapshot,
            Number(order.amount_snapshot || 0),
            `Criado pela aprovação da solicitação #${order.id}.`
          ]
        );
      }

      await conn.query(
        `UPDATE service_orders
         SET approval_status = ?,
             admin_notes = ?,
             reviewed_by = ?,
             reviewed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          decision,
          adminNotes || null,
          req.session.user.id,
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

    const [clients] = await db.query(
      `SELECT id
       FROM clients
       WHERE id = ? AND status = 'active'`,
      [clientId]
    );

    if (!clients.length) {
      return erro(res, 404, 'Cliente ativo não encontrado.');
    }

    const [result] = await db.query(
      `INSERT INTO invoices
        (client_id, description, amount, status, due_date)
       VALUES (?, ?, ?, 'pending', ?)`,
      [clientId, description.trim(), Number(amount), due_date || null]
    );

    return res.status(201).json({
      id: result.insertId,
      mensagem: 'Fatura criada.'
    });
  } catch (e) {
    console.error('Erro criar fatura:', e.code || e.message || 'erro');
    return erro(res, 500, 'Não foi possível criar a fatura.');
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

    await conn.commit();

    return res.status(201).json({
      mensagem: 'Pagamento registrado.'
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

app.post('/api/me/password', autenticado, async (req, res) => {
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
  console.error(
    'Erro interno:',
    err.code || err.message || err.name || 'erro'
  );

  if (res.headersSent) {
    return next(err);
  }

  return erro(res, 500, 'Erro interno do servidor.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VortexGrid Central iniciada na porta ${PORT}`);
});