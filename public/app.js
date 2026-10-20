
'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);

  const state = {
    user: null,
    page: 'dashboard',
    currentTicketId: null,
    ticketFilters: { status: 'all', priority: 'all', assigned_to: 'all' },
    clientSearch: '',
    clientStatus: 'all',
    orderStatus: 'pending',
    activationStatus: 'in_progress',
    financeStatus: 'all',
    financeSearch: '',
    currentClientId: null,
    globalSearchCache: null,
    cache: {
      clients: [],
      services: [],
      invoices: [],
      users: [],
      categories: [],
      orders: []
    }
  };

  const app = $('#app-view');
  const loginView = $('#login-view');
  const content = $('#page-content');
  let modal = $('#modal');
  const notice = $('#notice');
  const loginError = $('#login-error');

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function money(value) {
    const n = Number(value ?? 0);
    return (Number.isFinite(n) ? n : 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    });
  }

  function date(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? escapeHTML(value)
      : parsed.toLocaleDateString('pt-BR');
  }

  function dateTime(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? escapeHTML(value)
      : parsed.toLocaleString('pt-BR');
  }

  function notify(message, error = false) {
    if (!notice) {
      alert(message);
      return;
    }

    notice.textContent = message;
    notice.style.color = error ? '#b42318' : '#287d46';
    notice.hidden = false;
    notice.style.display = 'block';
    notice.classList.add('visible');

    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => {
      notice.hidden = true;
      notice.style.display = 'none';
      notice.classList.remove('visible');
    }, 4500);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Resposta inválida do servidor (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      throw new Error(
        data.erro || data.error || data.message ||
        `Erro HTTP ${response.status}`
      );
    }

    // Invalida resultados globais após qualquer operação de escrita, evitando
    // que a busca continue exibindo dados antigos após cadastros/edições.
    const method = String(options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      state.globalSearchCache = null;
    }

    return data;
  }

  function normalizeUser(result) {
    if (!result || typeof result !== 'object') return null;

    const candidate =
      result.user || result.usuario ||
      result.data?.user || result.data?.usuario || result;

    if (!candidate || typeof candidate !== 'object') return null;

    const email = candidate.email || candidate.e_mail ||
      candidate.username || candidate.login;

    const name = candidate.name || candidate.nome ||
      candidate.full_name || candidate.fullName || email;

    const role = candidate.role || candidate.perfil ||
      candidate.tipo || candidate.type;

    if (!email && !candidate.id && !candidate.userId) return null;

    return {
      ...candidate,
      email: email || '',
      name: name || 'Usuário',
      role: role || 'staff'
    };
  }

  function isActive(record) {
    return !(
      record?.active === 0 ||
      record?.active === false ||
      record?.active === '0'
    );
  }

  // Normaliza o valor do campo featured, independentemente de como a API o retorne.
  function isFeatured(service) {
    const value = service?.featured;

    return value === true ||
      value === 1 ||
      value === '1' ||
      value === 'true';
  }

  function showLogin() {
    state.user = null;
    if (loginView) loginView.hidden = false;
    if (app) app.hidden = true;
    if (loginError) loginError.textContent = '';
  }

  function showApp() {
    if (loginView) loginView.hidden = true;
    if (app) app.hidden = false;
    updateUserInfo();
    navigate(state.user?.role === 'admin' ? 'dashboard' : 'finance');
  }

  function updateUserInfo() {
    const name = state.user?.name || 'Administrador';
    const email = state.user?.email || '';

    document.querySelectorAll(
      '[data-user-name], #user-name, .user-name'
    ).forEach(el => {
      el.textContent = name;
    });

    document.querySelectorAll('.sidebar-user-info small').forEach(el => {
      el.textContent = state.user?.role === 'admin' ? 'Administrador' : 'Operador';
    });

    document.querySelectorAll(
      '[data-user-email], #user-email, .user-email'
    ).forEach(el => {
      el.textContent = email;
    });

    const isAdmin = state.user?.role === 'admin';

    document.querySelectorAll('[data-page]').forEach(el => {
      el.hidden = isAdmin ? false : el.dataset.page !== 'finance';
    });

    document.querySelectorAll('[data-action="my-account"]').forEach(el => {
      el.hidden = !isAdmin;
    });

    const adminGroup = $('#users-nav');
    if (adminGroup) adminGroup.hidden = !isAdmin;
  }

  function setLoading(message = 'Carregando...') {
    if (content) {
      content.innerHTML = `<div class="loading">${escapeHTML(message)}</div>`;
    }
  }

  function table(headers, rows) {
    if (!rows.length) {
      return `<div class="empty-state">Nenhum registro encontrado.</div>`;
    }

    return `
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>${headers.map(header =>
              `<th>${escapeHTML(header)}</th>`
            ).join('')}</tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>${row.map(cell =>
                `<td>${cell ?? '—'}</td>`
              ).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function pageHeader(title, description, buttonText = '', action = '') {
    return `
      <div class="page-header">
        <div>
          <h1>${escapeHTML(title)}</h1>
          <p>${escapeHTML(description)}</p>
        </div>
        ${buttonText ? `
          <button type="button" class="btn btn-primary"
            data-action="${escapeHTML(action)}">
            <span aria-hidden="true">${action === 'refresh-dashboard' ? '↻' : '+'}</span>
            ${escapeHTML(buttonText)}
          </button>
        ` : ''}
      </div>
    `;
  }

  function statCard(title, value, description = '', icon = '•') {
    return `
      <article class="stat-card">
        <div class="stat-card-top">
          <span class="stat-label">${escapeHTML(title)}</span>
          <span class="stat-icon" aria-hidden="true">${escapeHTML(icon)}</span>
        </div>
        <strong class="stat-value">${escapeHTML(value)}</strong>
        <span class="stat-description">${escapeHTML(description)}</span>
      </article>
    `;
  }

  function statusLabel(status) {
    const labels = {
      active: 'Ativo',
      inactive: 'Inativo',
      pending: 'Pendente',
      provisioning: 'Em provisionamento',
      suspended: 'Suspenso',
      expired: 'Expirado',
      paid: 'Pago',
      overdue: 'Vencido',
      cancelled: 'Cancelado',
      approved: 'Aprovada',
      rejected: 'Rejeitada'
    };

    return `
      <span class="status status-${escapeHTML(status || 'unknown')}">
        ${escapeHTML(labels[status] || status || '—')}
      </span>
    `;
  }

  function paymentStatusLabel(status) {
    if (status === 'paid') return statusLabel('paid');
    if (status === 'pending' || !status) {
      return '<span class="status status-pending">Aguardando pagamento</span>';
    }
    return statusLabel(status);
  }

  function operationalStatusLabel(status) {
    const labels = {
      awaiting_payment: 'Aguardando pagamento',
      preparing: 'Em preparação',
      awaiting_supplier: 'Aguardando fornecedor',
      awaiting_client: 'Aguardando informações do cliente',
      activating: 'Em ativação',
      active: 'Ativo',
      activation_failed: 'Falha na ativação',
      suspended: 'Suspenso',
      cancelled: 'Cancelado'
    };
    if (!status) {
      return '<span class="status status-inactive">Aguardando pagamento</span>';
    }
    return `<span class="status status-${escapeHTML(status)}">${escapeHTML(labels[status] || status)}</span>`;
  }

  function featuredLabel(service) {
    const featured = isFeatured(service);

    return `
      <span class="status ${featured ? 'status-active' : 'status-inactive'}">
        ${featured ? 'Na vitrine' : 'Fora da vitrine'}
      </span>
    `;
  }

  function getArray(result, property) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.[property])) return result[property];
    return [];
  }

  // --------------------------------------------------
  // NAVEGAÇÃO
  // --------------------------------------------------

  async function navigate(page) {
    const allowed = [
      'dashboard',
      'clients',
      'services',
      'activations',
      'categories',
      'orders',
      'tickets',
      'finance',
      'users'
    ];

    if (!allowed.includes(page)) page = 'dashboard';

    if (state.user?.role !== 'admin' && page !== 'finance') {
      notify('Operadores podem acessar apenas as faturas e cadastrar novos clientes.', true);
      return;
    }

    if (['orders', 'services', 'activations'].includes(page) && state.user?.role !== 'admin') {
      notify('Esta área é restrita a administradores.', true);
      return;
    }

    if (page === 'users' && state.user?.role !== 'admin') {
      notify('Você não tem permissão para acessar usuários.', true);
      return;
    }

    if (page === 'categories' && state.user?.role !== 'admin') {
      notify('Apenas administradores podem gerenciar categorias.', true);
      return;
    }

    state.page = page;

    document.querySelectorAll('[data-page]').forEach(el => {
      el.classList.toggle(
        'active',
        el.dataset.page === page ||
        (page === 'categories' && el.dataset.page === 'services')
      );
    });

    const titles = {
      dashboard: 'Visão geral',
      clients: 'Clientes',
      services: 'Catálogo de serviços',
      activations: 'Ativações e serviços contratados',
      categories: 'Categorias de serviços',
      orders: 'Solicitações',
      tickets: 'Atendimento / Tickets',
      finance: 'Financeiro',
      users: 'Usuários'
    };

    const pageTitle = $('#page-title');
    if (pageTitle) pageTitle.textContent = titles[page];

    if (!content) {
      console.error('VortexGrid: #page-content não encontrado.');
      return;
    }

    setLoading();
    refreshOrdersBadge();

    try {
      switch (page) {
        case 'dashboard':
          await renderDashboard();
          break;
        case 'clients':
          await renderClients();
          break;
        case 'services':
          await renderServices();
          break;
        case 'activations':
          await renderActivations();
          break;
        case 'categories':
          await renderCategories();
          break;
        case 'orders':
          await renderOrders();
          break;
        case 'tickets':
          await renderTickets();
          break;
        case 'finance':
          await renderFinance();
          break;
        case 'users':
          await renderUsers();
          break;
      }
    } catch (error) {
      content.innerHTML = `
        <div class="error-state">
          <h2>Não foi possível carregar esta tela</h2>
          <p>${escapeHTML(error.message)}</p>
          <button type="button" class="btn btn-primary"
            data-action="reload">Tentar novamente</button>
        </div>
      `;
    }
  }

  // --------------------------------------------------
  // DASHBOARD
  // --------------------------------------------------

  function compactMoney(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      notation: 'compact',
      maximumFractionDigits: 1
    });
  }

  function cycleLabel(cycle) {
    return {
      one_time: 'Única',
      monthly: 'Mensal',
      yearly: 'Anual'
    }[cycle] || cycle || '—';
  }

  function monthlyChart(series) {
    const months = [
      'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
      'jul', 'ago', 'set', 'out', 'nov', 'dez'
    ];

    const max = Math.max(...series.map(item => Number(item.total)), 1);

    return `
      <div class="bar-chart" role="img" aria-label="Recebimentos dos últimos seis meses">
        ${series.map(item => {
          const total = Number(item.total || 0);
          const height = total > 0 ? Math.max(6, Math.round((total / max) * 100)) : 2;
          const [year, month] = String(item.mes).split('-');

          return `
            <div class="bar-col" title="${escapeHTML(money(total))}">
              <span class="bar-value">${escapeHTML(compactMoney(total))}</span>
              <div class="bar-track">
                <span class="bar-fill" style="height:${height}%"></span>
              </div>
              <span class="bar-label">${escapeHTML(months[Number(month) - 1] || month)}/${escapeHTML(String(year).slice(2))}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function renderDashboard() {
    const data = await api('/api/dashboard');
    updateHeaderAlerts(data);
    const isAdmin = state.user?.role === 'admin';

    const clientes = Number(data.clientes ?? 0);
    const servicos = Number(data.servicos ?? 0);
    const servicosCatalogo = Number(data.servicosCatalogo ?? 0);
    const ativacoesPendentes = Number(data.ativacoesPendentes ?? 0);
    const pendentes = Number(data.faturasPendentes ?? 0);
    const valorPendente = Number(data.valorPendente ?? 0);
    const recebido = Number(data.recebidoMes ?? 0);
    const vencidas = Number(data.faturasVencidas ?? 0);
    const valorVencido = Number(data.valorVencido ?? 0);
    const valorEmDia = Math.max(0, valorPendente - valorVencido);
    const percentualVencido = valorPendente > 0
      ? Math.min(100, Math.round((valorVencido / valorPendente) * 100))
      : 0;
    const percentualEmDia = 100 - percentualVencido;
    const solicitacoes = Number(data.solicitacoesPendentes ?? 0);
    const serie = Array.isArray(data.recebimentosMensais) ? data.recebimentosMensais : [];
    const faturas = Array.isArray(data.ultimasFaturas) ? data.ultimasFaturas : [];
    const pedidos = Array.isArray(data.solicitacoesRecentes) ? data.solicitacoesRecentes : [];
    const atividades = Array.isArray(data.atividadeRecente) ? data.atividadeRecente : [];

    const alertas = [];

    if (vencidas > 0) {
      alertas.push({
        nivel: 'danger',
        titulo: vencidas === 1 ? 'Fatura vencida' : 'Faturas vencidas',
        descricao: `${vencidas.toLocaleString('pt-BR')} fatura(s) com vencimento ultrapassado · ${money(valorVencido)}`,
        acao: 'Abrir financeiro',
        pagina: 'finance'
      });
    }

    const faturasNaoVencidas = Math.max(0, pendentes - vencidas);
    if (faturasNaoVencidas > 0) {
      alertas.push({
        nivel: 'warning',
        titulo: 'Cobranças em aberto',
        descricao: `${faturasNaoVencidas.toLocaleString('pt-BR')} fatura(s) pendente(s) sem atraso identificado`,
        acao: 'Ver faturas',
        pagina: 'finance'
      });
    }

    if (isAdmin && ativacoesPendentes > 0) {
      alertas.push({
        nivel: 'info',
        titulo: 'Ativações aguardando andamento',
        descricao: `${ativacoesPendentes.toLocaleString('pt-BR')} serviço(s) aguardando ativação`,
        acao: 'Abrir ativações',
        pagina: 'activations'
      });
    }

    if (isAdmin && solicitacoes > 0) {
      alertas.push({
        nivel: 'warning',
        titulo: 'Solicitações aguardando análise',
        descricao: `${solicitacoes.toLocaleString('pt-BR')} pedido(s) aguardando decisão administrativa`,
        acao: 'Analisar solicitações',
        pagina: 'orders'
      });
    }

    const alertasMarkup = alertas.length
      ? `
        <section class="alert-center content-card" aria-labelledby="alert-center-title">
          <div class="panel-heading">
            <div>
              <span class="section-eyebrow">CENTRAL DE ATENÇÃO</span>
              <h2 id="alert-center-title">Pontos que precisam de atenção</h2>
              <p>Prioridades identificadas a partir dos registros atuais do sistema.</p>
            </div>
            <span class="alert-count">${alertas.length} ${alertas.length === 1 ? 'alerta' : 'alertas'}</span>
          </div>
          <div class="alert-list">
            ${alertas.map(alerta => `
              <article class="dashboard-alert dashboard-alert-${alerta.nivel}">
                <span class="dashboard-alert-symbol" aria-hidden="true">${alerta.nivel === 'danger' ? '!' : alerta.nivel === 'warning' ? '◷' : '↗'}</span>
                <div class="dashboard-alert-copy">
                  <strong>${escapeHTML(alerta.titulo)}</strong>
                  <p>${escapeHTML(alerta.descricao)}</p>
                </div>
                <button type="button" class="btn btn-small" data-page="${escapeHTML(alerta.pagina)}">${escapeHTML(alerta.acao)} <span aria-hidden="true">→</span></button>
              </article>
            `).join('')}
          </div>
        </section>
      `
      : `
        <section class="alert-center content-card alert-center-clear" aria-label="Status operacional">
          <span class="alert-clear-icon" aria-hidden="true">✓</span>
          <div>
            <strong>Nenhum alerta prioritário identificado</strong>
            <p>Não há cobranças em atraso ou pendências operacionais nos indicadores consultados.</p>
          </div>
          <span class="alert-count">Operação monitorada</span>
        </section>
      `;

    content.innerHTML = `
      ${pageHeader(
        'Visão geral',
        `Olá, ${state.user?.name || 'Administrador'}. Estes são os principais indicadores da operação.`
      ,
        'Atualizar dados',
        'refresh-dashboard'
      )}

      ${alertasMarkup}

      <section class="stats-grid ${isAdmin ? 'stats-grid-admin' : ''}">
        ${statCard('Recebido neste mês', money(recebido),
          'Pagamentos registrados no mês atual', 'R$')}
        ${statCard('Em aberto', money(valorPendente),
          `${pendentes.toLocaleString('pt-BR')} fatura(s); inclui as vencidas`, '▤')}
        ${statCard('Vencidas', money(valorVencido),
          `${vencidas.toLocaleString('pt-BR')} fatura(s) com vencimento ultrapassado`, '!')}
        ${isAdmin
          ? statCard('Aguardando ativação', ativacoesPendentes.toLocaleString('pt-BR'),
              'Contratos pendentes ou em provisionamento', '◷')
          : statCard('Clientes ativos', clientes.toLocaleString('pt-BR'),
              'Clientes com cadastro ativo', '♙')}
        ${isAdmin
          ? statCard('Solicitações pendentes', solicitacoes.toLocaleString('pt-BR'),
              'Pedidos de clientes aguardando análise', '✓')
          : ''}

      </section>

      <section class="content-card financial-overview" aria-labelledby="financial-overview-title">
        <div class="panel-heading financial-overview-heading">
          <div>
            <span class="section-eyebrow">VISÃO FINANCEIRA</span>
            <h2 id="financial-overview-title">Resumo financeiro</h2>
            <p>Valores calculados a partir das faturas e dos pagamentos registrados.</p>
          </div>
          <button type="button" class="btn btn-small" data-page="finance">Abrir financeiro <span aria-hidden="true">→</span></button>
        </div>

        <div class="financial-summary-grid">
          <div class="financial-summary-item">
            <span class="financial-summary-label"><span class="financial-dot financial-dot-success"></span>Recebido neste mês</span>
            <strong>${escapeHTML(money(recebido))}</strong>
            <small>Pagamentos registrados no mês atual</small>
          </div>
          <div class="financial-summary-item">
            <span class="financial-summary-label"><span class="financial-dot financial-dot-neutral"></span>Total em aberto</span>
            <strong>${escapeHTML(money(valorPendente))}</strong>
            <small>${pendentes.toLocaleString('pt-BR')} fatura(s) pendente(s) ou vencida(s)</small>
          </div>
          <div class="financial-summary-item">
            <span class="financial-summary-label"><span class="financial-dot financial-dot-danger"></span>Valor vencido</span>
            <strong>${escapeHTML(money(valorVencido))}</strong>
            <small>${vencidas.toLocaleString('pt-BR')} fatura(s) com vencimento ultrapassado</small>
          </div>
        </div>

        <div class="financial-composition">
          <div class="financial-composition-heading">
            <strong>Composição das cobranças em aberto</strong>
            <span>${percentualVencido}% vencido</span>
          </div>
          <div class="financial-progress" role="img" aria-label="${percentualEmDia}% do valor em aberto não está vencido e ${percentualVencido}% está vencido">
            <span class="financial-progress-current" style="width:${percentualEmDia}%"></span>
            <span class="financial-progress-overdue" style="width:${percentualVencido}%"></span>
          </div>
          <div class="financial-legend">
            <span><i class="financial-dot financial-dot-success"></i>Não vencido: ${escapeHTML(money(valorEmDia))}</span>
            <span><i class="financial-dot financial-dot-danger"></i>Vencido: ${escapeHTML(money(valorVencido))}</span>
          </div>
        </div>
      </section>

      <section class="content-card activity-center" aria-labelledby="activity-center-title">
        <div class="panel-heading">
          <div><span class="section-eyebrow">ACOMPANHAMENTO OPERACIONAL</span><h2 id="activity-center-title">Atividade recente</h2><p>Últimos registros de clientes, pagamentos, faturas, ativações e solicitações.</p></div>
          <span class="activity-count">${atividades.length} ${atividades.length === 1 ? "atividade" : "atividades"}</span>
        </div>
        ${atividades.length ? '<div class="activity-list">' + atividades.map(item => {
          const labels = { cliente: "Novo cliente", pagamento: "Pagamento", fatura: "Fatura", ativacao: "Ativação", solicitacao: "Solicitação" };
          const symbols = { cliente: "＋", pagamento: "R$", fatura: "▤", ativacao: "↗", solicitacao: "⋯" };
          const description = [item.descricao, item.data ? date(item.data) : ""].filter(Boolean).join(" · ");
          return '<article class="activity-row"><span class="activity-marker activity-marker-' + escapeHTML(item.tipo) + '" aria-hidden="true">' + (symbols[item.tipo] || "•") + '</span><div class="activity-main"><div class="activity-title-line"><strong>' + escapeHTML(item.titulo || labels[item.tipo] || "Atividade") + '</strong><span class="activity-type activity-type-' + escapeHTML(item.tipo) + '">' + (labels[item.tipo] || "Atividade") + '</span></div><p>' + escapeHTML(description) + '</p></div><div class="activity-side">' + (item.valor !== null && item.valor !== undefined ? '<strong>' + escapeHTML(money(item.valor)) + '</strong>' : "") + '<button type="button" class="btn btn-small" data-page="' + escapeHTML(item.pagina || "dashboard") + '">Abrir <span aria-hidden="true">→</span></button></div></article>';
        }).join("") + '</div>' : '<div class="empty-state">Ainda não há atividades recentes para exibir.</div>'}
      </section>

      <section class="dashboard-grid">
        <article class="content-card">
          <div class="panel-heading">
            <div>
              <h2>Recebimentos</h2>
              <p>Pagamentos registrados nos últimos 6 meses</p>
            </div>
            <div class="quick-actions">
              ${isAdmin ? '<button type="button" class="btn btn-small" data-action="new-invoice">+ Nova fatura</button>' : ''}
              <button type="button" class="btn btn-small" data-action="new-client">+ Novo cliente</button>
            </div>
          </div>
          ${monthlyChart(serie)}
        </article>

        <article class="content-card">
          <div class="panel-heading">
            <div>
              <h2>Operação</h2>
              <p>Cadastros e serviços da operação</p>
            </div>
            ${isAdmin ? '<button type="button" class="btn btn-small" data-page="services">Gerenciar serviços</button>' : ''}
          </div>
          <div class="mini-stats">
            <div><strong>${clientes.toLocaleString('pt-BR')}</strong><span>Clientes ativos</span></div>
            <div><strong>${servicos.toLocaleString('pt-BR')}</strong><span>Serviços contratados ativos</span></div>
            ${isAdmin ? `<div><strong>${servicosCatalogo.toLocaleString('pt-BR')}</strong><span>Itens ativos no catálogo</span></div>` : ''}
            ${isAdmin ? `<div><strong>${Number(data.usuarios ?? 0).toLocaleString('pt-BR')}</strong><span>Usuários ativos</span></div>` : ''}
          </div>
        </article>
      </section>

      <section class="dashboard-grid dashboard-grid-secondary">
        <article class="content-card">
          <div class="panel-heading">
            <div>
              <h2>Últimas faturas</h2>
              <p>As cinco faturas mais recentes</p>
            </div>
            <button type="button" class="btn btn-small" data-page="finance">Ver todas</button>
          </div>
          ${faturas.length ? `
            <div class="list-rows">
              ${faturas.map(item => `
                <div class="list-row">
                  <div class="list-row-main">
                    <strong>${escapeHTML(item.client_name)}</strong>
                    <small>${escapeHTML(item.description || '—')} · vence em ${date(item.due_date)}</small>
                  </div>
                  <div class="list-row-side">
                    <strong>${escapeHTML(money(item.amount))}</strong>
                    ${statusLabel(item.status)}
                  </div>
                </div>
              `).join('')}
            </div>
          ` : '<div class="empty-state">Nenhuma fatura emitida ainda.</div>'}
        </article>

        <article class="content-card">
          <div class="panel-heading">
            <div>
              <h2>${isAdmin ? 'Solicitações aguardando análise' : 'Acesso rápido'}</h2>
              <p>${isAdmin ? 'Pedidos recentes feitos pelos clientes' : 'Principais áreas do painel'}</p>
            </div>
            ${isAdmin ? '<button type="button" class="btn btn-small" data-page="orders">Ver todas</button>' : ''}
          </div>
          ${isAdmin ? (pedidos.length ? `
            <div class="list-rows">
              ${pedidos.map(item => `
                <div class="list-row">
                  <div class="list-row-main">
                    <strong>${escapeHTML(item.client_name)}</strong>
                    <small>${escapeHTML(item.description_snapshot || '—')} · ${escapeHTML(cycleLabel(item.billing_cycle_snapshot))} · ${date(item.created_at)}</small>
                  </div>
                  <div class="list-row-side">
                    <strong>${escapeHTML(money(item.amount_snapshot))}</strong>
                    <button type="button" class="btn btn-small btn-primary" data-action="review-order" data-id="${escapeHTML(item.id)}">Analisar</button>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : '<div class="empty-state">Nenhuma solicitação pendente. Tudo em dia.</div>') : `
            <div class="quick-link-list">
              <button type="button" class="quick-link" data-page="clients">
                <span class="quick-link-icon">♙</span><span><strong>Clientes</strong><small>Consulte e cadastre clientes</small></span><span class="quick-link-arrow">›</span>
              </button>
              <button type="button" class="quick-link" data-page="finance">
                <span class="quick-link-icon">▤</span><span><strong>Financeiro</strong><small>Faturas, vencimentos e pagamentos</small></span><span class="quick-link-arrow">›</span>
              </button>
            </div>
          `}
        </article>
      </section>
    `;
  }

  // --------------------------------------------------
  // CLIENTES
  // --------------------------------------------------

  async function renderClients() {
    const result = await api('/api/clients');
    state.cache.clients = getArray(result, 'clients');

    const term = state.clientSearch.trim().toLocaleLowerCase('pt-BR');
    const filtered = state.cache.clients.filter(client => {
      const searchable = [client.name, client.email, client.phone, client.document]
        .join(' ').toLocaleLowerCase('pt-BR');
      const matchesText = !term || searchable.includes(term);
      const matchesStatus = state.clientStatus === 'all' ||
        (client.status || 'active') === state.clientStatus;
      return matchesText && matchesStatus;
    });

    content.innerHTML = `
      ${pageHeader('Clientes',
        'Cadastre, pesquise e gerencie os clientes da VortexGrid.',
        'Novo cliente', 'new-client')}

      <section class="content-card" style="margin-bottom:18px">
        <div class="form-grid" style="align-items:end">
          <label class="form-field">
            <span>Pesquisar cliente</span>
            <input id="client-search" type="search"
              placeholder="Nome, e-mail, telefone ou CPF/CNPJ"
              value="${escapeHTML(state.clientSearch)}">
          </label>
          <label class="form-field">
            <span>Status do cadastro</span>
            <select id="client-status-filter">
              <option value="all" ${state.clientStatus === 'all' ? 'selected' : ''}>Todos</option>
              <option value="active" ${state.clientStatus === 'active' ? 'selected' : ''}>Ativos</option>
              <option value="inactive" ${state.clientStatus === 'inactive' ? 'selected' : ''}>Inativos</option>
            </select>
          </label>
        </div>
        <p class="summary-footer">${filtered.length} cliente(s) exibido(s). A lista consulta até 500 registros.</p>
      </section>

      ${table(['Cliente', 'E-mail', 'Telefone', 'CPF / CNPJ', 'Status', 'Cadastro', 'Ações'],
        filtered.map(client => clientTableRow(client)))}
    `;

    const search = $('#client-search', content);
    const statusFilter = $('#client-status-filter', content);

    if (search) {
      search.addEventListener('input', () => {
        const position = search.selectionStart;
        state.clientSearch = search.value;
        filterClientTable();
        const newSearch = $('#client-search', content);
        if (newSearch) {
          newSearch.focus();
          newSearch.setSelectionRange(position, position);
        }
      });
    }

    if (statusFilter) {
      statusFilter.addEventListener('change', () => {
        state.clientStatus = statusFilter.value;
        renderClients();
      });
    }
  }

  function clientTableRow(client) {
    const id = escapeHTML(client.id);
    const inactive = client.status === 'inactive';

    return [
      `<strong>${escapeHTML(client.name)}</strong>`,
      escapeHTML(client.email || '—'),
      escapeHTML(client.phone || '—'),
      escapeHTML(client.document || '—'),
      statusLabel(client.status || 'active'),
      date(client.created_at),
      `<div class="quick-actions">
        <button type="button" class="btn btn-small" data-action="client-record" data-id="${id}">Ficha</button>
        <button type="button" class="btn btn-small" data-action="edit-client" data-id="${id}">Editar</button>
        ${state.user?.role === 'admin' ? `<button type="button" class="btn btn-small" data-action="toggle-client" data-id="${id}" data-status="${inactive ? 'active' : 'inactive'}">${inactive ? 'Ativar' : 'Inativar'}</button>` : ''}
      </div>`
    ];
  }

  function filterClientTable() {
    const term = state.clientSearch.trim().toLocaleLowerCase('pt-BR');
    const filtered = state.cache.clients.filter(client => {
      const searchable = [client.name, client.email, client.phone, client.document]
        .join(' ').toLocaleLowerCase('pt-BR');
      const matchesText = !term || searchable.includes(term);
      const matchesStatus = state.clientStatus === 'all' ||
        (client.status || 'active') === state.clientStatus;
      return matchesText && matchesStatus;
    });

    const wrapper = content.querySelector('.table-wrapper');
    const empty = content.querySelector('.empty-state');
    const tableHTML = table(
      ['Cliente', 'E-mail', 'Telefone', 'CPF / CNPJ', 'Status', 'Cadastro', 'Ações'],
      filtered.map(client => clientTableRow(client))
    );

    const oldTable = wrapper || empty;
    if (oldTable) oldTable.outerHTML = tableHTML;

    const summary = content.querySelector('.summary-footer');
    if (summary) {
      summary.textContent = `${filtered.length} cliente(s) exibido(s). A lista consulta até 500 registros.`;
    }
  }

  // --------------------------------------------------
  // FICHA DO CLIENTE
  // --------------------------------------------------

  async function openClientRecord(id) {
    if (!id || !Number.isInteger(Number(id)) || Number(id) < 1) {
      notify('Identificador de cliente inválido.', true);
      return;
    }

    state.currentClientId = Number(id);
    state.page = 'client-record';

    document.querySelectorAll('[data-page]').forEach(el => {
      el.classList.toggle('active', el.dataset.page === 'clients');
    });

    const pageTitle = $('#page-title');
    if (pageTitle) pageTitle.textContent = 'Ficha do cliente';

    setLoading('Carregando ficha do cliente...');

    try {
      const record = await api(`/api/clients/${encodeURIComponent(id)}/record`);
      renderClientRecord(record);
    } catch (error) {
      content.innerHTML = `
        <div class="error-state">
          <h2>Não foi possível carregar a ficha</h2>
          <p>${escapeHTML(error.message)}</p>
          <div class="quick-actions">
            <button type="button" class="btn" data-action="clients-back">Voltar aos clientes</button>
            <button type="button" class="btn btn-primary" data-action="client-record" data-id="${escapeHTML(id)}">Tentar novamente</button>
          </div>
        </div>
      `;
    }
  }

  function contractedServiceAction(service) {
    const status = String(service.status || 'pending');

    if (state.user?.role !== 'admin') return '—';

    if (status === 'cancelled') {
      return '<span class="summary-footer">Status final</span>';
    }

    return `
      <div class="quick-actions" style="gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-small"
          data-action="edit-contracted-service-details"
          data-id="${escapeHTML(service.id)}"
          data-name="${escapeHTML(service.name || 'Serviço')}">Informações</button>
        <button type="button" class="btn btn-small btn-primary"
          data-action="change-contracted-service-status"
          data-id="${escapeHTML(service.id)}"
          data-status="${escapeHTML(status)}"
          data-name="${escapeHTML(service.name || 'Serviço')}">Alterar status</button>
      </div>
    `;
  }

  async function openContractedServiceDetails(serviceId, serviceName) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem editar estas informações.', true);
      return;
    }
    try {
      const result = await api(`/api/contracted-services/${encodeURIComponent(serviceId)}/details`);
      const details = Array.isArray(result.details) ? result.details : [];
      const textValue = details.map(item => `${item.label} | ${item.value}`).join('\\n');
      openModal(
        `Informações do serviço — ${serviceName || 'Serviço'}`,
        `
          <div class="form-field">
            <label for="contracted-service-details-text">Informações visíveis ao cliente</label>
            <textarea id="contracted-service-details-text" name="details_text" rows="12" maxlength="20000" placeholder="IP do servidor | 192.0.2.10&#10;Painel | https://exemplo.com&#10;Usuário | cliente123&#10;Instruções | Acesse o painel para gerenciar seu serviço">${escapeHTML(textValue)}</textarea>
            <small>Uma informação por linha, no formato <strong>Título | Valor</strong>. Até 30 linhas. Não inclua fornecedor, custos internos ou outras informações confidenciais.</small>
          </div>
        `,
        async values => {
          const details = String(values.details_text || '')
            .split(/\\r?\\n/)
            .map(line => {
              const separator = line.indexOf('|');
              if (separator < 0) return { label: line.trim(), value: '' };
              return { label: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
            })
            .filter(item => item.label || item.value);
          if (details.length > 30) throw new Error('Use no máximo 30 informações.');
          if (details.some(item => !item.label || item.label.length > 80 || item.value.length > 4000)) {
            throw new Error('Confira as linhas. Use Título | Valor; título até 80 caracteres e valor até 4000.');
          }
          return api(`/api/contracted-services/${encodeURIComponent(serviceId)}/details`, {
            method: 'PUT',
            body: JSON.stringify({ details })
          });
        },
        { successMessage: 'Informações do serviço salvas.' }
      );
    } catch (error) {
      notify(error.message || 'Não foi possível carregar as informações do serviço.', true);
    }
  }

  function renderClientRecord(record) {
    const client = record?.cliente;
    const financial = record?.financeiro || {};
    const invoices = Array.isArray(record?.faturas) ? record.faturas : [];
    const payments = Array.isArray(record?.pagamentos) ? record.pagamentos : [];
    const contractedServices = Array.isArray(record?.servicosContratados)
      ? record.servicosContratados
      : [];

    if (!client) {
      throw new Error('Os dados do cliente não foram retornados pela API.');
    }

    state.currentClientId = Number(client.id);
    state.page = 'client-record';

    const pageTitle = $('#page-title');
    if (pageTitle) pageTitle.textContent = 'Ficha do cliente';

    const documentNumber = client.document || 'Não informado';
    const notes = client.notes || '';
    const clientStatus = client.status || 'active';

    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>Ficha do cliente</h1>
          <p>Cadastro, serviços contratados, situação financeira e histórico de movimentações.</p>
        </div>
        <div class="quick-actions">
          <button type="button" class="btn" data-action="clients-back">← Voltar</button>
          <button type="button" class="btn btn-primary" data-action="edit-client" data-id="${escapeHTML(client.id)}">Editar cadastro</button>
          <button type="button" class="btn" data-action="refresh-client-record" data-id="${escapeHTML(client.id)}">Atualizar ficha</button>
        </div>
      </div>

      <section class="content-card client-record-profile" style="margin-bottom:18px">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">CADASTRO DO CLIENTE</span>
            <h2>${escapeHTML(client.name || 'Cliente sem nome')}</h2>
            <p>Identificador #${escapeHTML(client.id)}</p>
          </div>
          ${statusLabel(clientStatus)}
        </div>
        <div class="form-grid">
          <div class="form-field"><span>E-mail</span><div>${escapeHTML(client.email || 'Não informado')}</div></div>
          <div class="form-field"><span>Telefone</span><div>${escapeHTML(client.phone || 'Não informado')}</div></div>
          <div class="form-field"><span>CPF / CNPJ</span><div>${escapeHTML(documentNumber)}</div></div>
          <div class="form-field"><span>Data de cadastro</span><div>${date(client.created_at)}</div></div>
          <div class="form-field" style="grid-column:1/-1">
            <span>Observações</span>
            <div style="white-space:pre-wrap">${escapeHTML(notes || 'Nenhuma observação cadastrada.')}</div>
          </div>
        </div>
      </section>

      <section class="content-card" style="margin-bottom:18px">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">CONTRATOS E SERVIÇOS</span>
            <h2>Serviços do cliente</h2>
            <p>Serviços vinculados a este cadastro e suas situações atuais.</p>
          </div>
          ${state.user?.role === 'admin' && clientStatus === 'active' ? `
            <button type="button" class="btn btn-primary" data-action="add-contracted-service" data-id="${escapeHTML(client.id)}">+ Adicionar serviço</button>
          ` : ''}
        </div>

        ${contractedServices.length ? table(
          [
            'Serviço', 'Categoria', 'Valor', 'Cobrança', 'Status',
            ...(state.user?.role === 'admin' ? ['Estado operacional interno'] : []),
            'Próximo vencimento', 'Vinculado em', 'Ação'
          ],
          contractedServices.map(service => [
            `<strong>${escapeHTML(service.name || 'Serviço')}</strong>${service.description ? `<div class="summary-footer">${escapeHTML(service.description)}</div>` : ''}`,
            escapeHTML(service.service_category || '—'),
            money(service.sale_price),
            escapeHTML({
              one_time: 'Única',
              monthly: 'Mensal',
              yearly: 'Anual'
            }[service.billing_cycle] || service.billing_cycle || '—'),
            statusLabel(service.status),
            ...(state.user?.role === 'admin' ? [
              `<div><strong>${escapeHTML(operationalStatusLabel(service.operational_status))}</strong><div class="summary-footer" style="margin-top:6px"><button type="button" class="btn btn-small" data-action="change-operational-status" data-id="${escapeHTML(service.id)}" data-status="${escapeHTML(service.operational_status || 'awaiting_payment')}" data-name="${escapeHTML(service.name || 'Serviço')}">Alterar estado interno</button> <button type="button" class="btn btn-small" data-action="view-operational-history" data-id="${escapeHTML(service.id)}" data-name="${escapeHTML(service.name || 'Serviço')}">Histórico</button></div></div>`
            ] : []),
            date(service.next_due_date),
            date(service.created_at),
            contractedServiceAction(service)
          ])
        ) : `
          <div class="empty-state">
            <p>Este cliente ainda não possui serviços vinculados.</p>
            ${state.user?.role === 'admin' && clientStatus === 'active' ? `
              <p>Clique em <strong>Adicionar serviço</strong> para selecionar um item do catálogo da VortexGrid.</p>
            ` : ''}
          </div>
        `}
      </section>

      <section class="stats-grid client-record-stats">
        ${statCard('Total faturado', money(financial.totalInvoiced), `${Number(financial.invoiceCount || 0)} fatura(s) no histórico`, 'R$')}
        ${statCard('Em aberto', money(financial.totalOpen), `${Number(financial.pendingCount || 0)} pendente(s) e ${Number(financial.overdueCount || 0)} vencida(s)`, '▤')}
        ${statCard('Valor vencido', money(financial.totalOverdue), `${Number(financial.overdueCount || 0)} fatura(s) vencida(s)`, '!')}
        ${statCard('Faturas pagas', money(financial.totalPaidInvoices), `${Number(financial.paidCount || 0)} fatura(s) paga(s)`, '✓')}
        ${statCard('Pagamentos registrados', money(financial.totalPayments), `${payments.length} pagamento(s) registrado(s)`, '↗')}
      </section>

      <section class="content-card" style="margin-top:18px">
        <div class="panel-heading">
          <div><h2>Histórico de faturas</h2><p>Faturas vinculadas a este cliente.</p></div>
          ${state.user?.role === 'admin' ? `<button type="button" class="btn btn-primary" data-action="new-invoice-for-client" data-id="${escapeHTML(client.id)}">+ Nova fatura</button>` : ''}
        </div>
        ${table(
          ['ID', 'Descrição', 'Valor', 'Vencimento', 'Status', 'Criada em', 'Ação'],
          invoices.map(invoice => [
            `#${escapeHTML(invoice.id)}`,
            escapeHTML(invoice.description || 'Fatura'),
            money(invoice.amount),
            date(invoice.due_date),
            statusLabel(invoice.status),
            date(invoice.created_at),
            state.user?.role === 'admin' && invoice.status !== 'paid' && invoice.status !== 'cancelled' ? `
              <button type="button" class="btn btn-small" data-action="pay-invoice-from-record" data-id="${escapeHTML(invoice.id)}">Registrar pagamento</button>
            ` : '—'
          ])
        )}
      </section>

      <section class="content-card" style="margin-top:18px">
        <div class="panel-heading">
          <div><h2>Histórico de pagamentos</h2><p>Pagamentos registrados nas faturas deste cliente.</p></div>
        </div>
        ${table(
          ['ID da fatura', 'Valor', 'Método', 'Referência', 'Data do pagamento'],
          payments.map(payment => [
            `#${escapeHTML(payment.invoice_id)}`,
            money(payment.amount),
            escapeHTML(payment.method || 'Não informado'),
            escapeHTML(payment.reference || '—'),
            dateTime(payment.paid_at)
          ])
        )}
      </section>

      <div class="quick-actions" style="margin-top:18px">
        <button type="button" class="btn" data-action="clients-back">← Voltar à lista de clientes</button>
        <button type="button" class="btn btn-primary" data-action="edit-client" data-id="${escapeHTML(client.id)}">Editar cadastro</button>
      </div>
    `;
  }


  const operationalStatusNames = {
    awaiting_payment: 'Aguardando pagamento',
    preparing: 'Em preparação',
    awaiting_supplier: 'Aguardando fornecedor',
    awaiting_client: 'Aguardando informações do cliente',
    activating: 'Em ativação',
    active: 'Ativo',
    activation_failed: 'Falha na ativação',
    suspended: 'Suspenso',
    cancelled: 'Cancelado'
  };

  function operationalStatusLabel(value) {
    return operationalStatusNames[String(value || 'awaiting_payment')] || 'Aguardando pagamento';
  }

  function changeOperationalStatus(serviceId, currentStatus, serviceName) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem alterar o estado operacional.', true);
      return;
    }
    const id = Number(serviceId);
    if (!Number.isSafeInteger(id) || id < 1) {
      notify('Identificador de serviço inválido.', true);
      return;
    }
    const options = Object.entries(operationalStatusNames).map(([value, label]) => ({ value, label }));
    openModal(
      `Estado operacional interno — ${serviceName || 'Serviço'}`,
      `
        <p class="summary-footer" style="margin-bottom:14px">
          Exclusivo da Central Administrativa. Não altera pagamento, fatura nem o status público do serviço.
        </p>
        ${field('Estado atual', 'current_status', 'text', true, [{ value: currentStatus, label: operationalStatusLabel(currentStatus) }], currentStatus)}
        ${field('Novo estado', 'operational_status', 'text', true, options, currentStatus)}
        ${field('Observação interna obrigatória', 'note', 'textarea', true, null, '')}
      `,
      async values => {
        if (!options.some(option => option.value === values.operational_status)) throw new Error('Selecione um estado operacional válido.');
        if (values.operational_status === currentStatus) throw new Error('Selecione um estado diferente do atual.');
        if (values.operational_status === 'cancelled' && !confirm(`Confirma marcar "${serviceName || 'Serviço'}" como cancelado no fluxo operacional?`)) {
          throw new Error('Cancelamento não confirmado.');
        }
        const result = await api(`/api/contracted-services/${encodeURIComponent(id)}/operational-status`, {
          method: 'PATCH',
          body: JSON.stringify({ operational_status: values.operational_status, note: values.note })
        });
        if (state.page === 'client-record' && state.currentClientId) {
          await openClientRecord(state.currentClientId);
        } else if (state.page === 'orders') {
          await renderOrders();
        } else if (state.page === 'services') {
          await renderServices();
        } else if (state.page === 'activations') {
          await renderActivations();
        }
        return result;
      }
    );
  }

  async function viewOperationalHistory(serviceId, serviceName) {
    if (state.user?.role !== 'admin') {
      notify('O histórico operacional é restrito a administradores.', true);
      return;
    }
    try {
      const result = await api(`/api/contracted-services/${encodeURIComponent(serviceId)}/operational-history`);
      const rows = Array.isArray(result.historico) ? result.historico : [];
      const body = rows.length ? table(
        ['Data', 'Estado anterior', 'Novo estado', 'Responsável', 'Observação interna'],
        rows.map(item => [
          dateTime(item.changed_at),
          escapeHTML(operationalStatusLabel(item.previous_status)),
          escapeHTML(operationalStatusLabel(item.new_status)),
          escapeHTML(item.changed_by_name || 'Usuário indisponível'),
          escapeHTML(item.note || '—')
        ])
      ) : '<div class="empty-state"><p>Nenhuma alteração operacional registrada ainda.</p></div>';
      openModal(`Histórico operacional — ${serviceName || 'Serviço'}`, body, async () => ({ mensagem: 'Histórico consultado.' }), { submitLabel: 'Fechar', successMessage: 'Histórico consultado.' });
    } catch (error) {
      notify(error.message || 'Não foi possível carregar o histórico.', true);
    }
  }

  // --------------------------------------------------
  // STATUS DO SERVIÇO CONTRATADO
  // --------------------------------------------------

  function changeContractedServiceStatus(serviceId, currentStatus, serviceName) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem alterar o status de serviços.', true);
      return;
    }

    const id = Number(serviceId);

    if (!Number.isSafeInteger(id) || id < 1) {
      notify('Identificador de serviço inválido.', true);
      return;
    }

    if (currentStatus === 'cancelled') {
      notify('Um serviço cancelado não pode ser reativado por esta tela.', true);
      return;
    }

    const statusOptions = [
      { value: 'pending', label: 'Pendente' },
      { value: 'provisioning', label: 'Em provisionamento' },
      { value: 'active', label: 'Ativo' },
      { value: 'suspended', label: 'Suspenso' },
      { value: 'cancelled', label: 'Cancelado' }
    ];

    openModal(
      `Alterar status — ${serviceName || 'Serviço'}`,
      `
        <p class="summary-footer" style="margin-bottom:14px">
          Selecione o novo status para este serviço contratado.
          Essa alteração não gera faturas automaticamente.
        </p>
        ${field('Status atual', 'current_status', 'text', true, [
          {
            value: currentStatus,
            label: ({
              pending: 'Pendente',
              provisioning: 'Em provisionamento',
              active: 'Ativo',
              suspended: 'Suspenso'
            }[currentStatus] || currentStatus)
          }
        ], currentStatus)}
        ${field('Novo status', 'status', 'text', true, statusOptions, currentStatus)}
        <p class="summary-footer">
          Atenção: cancelar um serviço é uma ação final e não poderá ser desfeita por esta tela.
        </p>
      `,
      async values => {
        const newStatus = values.status;

        if (!statusOptions.some(option => option.value === newStatus)) {
          throw new Error('Selecione um status válido.');
        }

        if (newStatus === currentStatus) {
          throw new Error('Selecione um status diferente do atual.');
        }

        if (newStatus === 'cancelled' && !confirm(
          `Confirma o cancelamento do serviço "${serviceName || 'Serviço'}"?\n\n` +
          'O serviço permanecerá registrado no histórico e não poderá ser reativado por esta tela.'
        )) {
          throw new Error('Cancelamento não confirmado.');
        }

        return api(`/api/contracted-services/${encodeURIComponent(id)}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus })
        });
      }
    );
  }

  // --------------------------------------------------
  // VINCULAR SERVIÇO A CLIENTE
  // --------------------------------------------------

  async function addContractedService(clientId) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem vincular serviços a clientes.', true);
      return;
    }

    const id = Number(clientId);
    if (!Number.isSafeInteger(id) || id < 1) {
      notify('Identificador de cliente inválido.', true);
      return;
    }

    try {
      const client = state.cache.clients.find(item => String(item.id) === String(id));

      if (client && client.status === 'inactive') {
        notify('Não é possível vincular serviços a um cliente inativo.', true);
        return;
      }

      const result = await api('/api/services');
      const allServices = getArray(result, 'services');
      const services = allServices.filter(isActive);

      state.cache.services = allServices;

      if (!services.length) {
        notify('Não há serviços ativos no catálogo. Cadastre um serviço antes de vinculá-lo.', true);
        return;
      }

      const options = [
        { value: '', label: 'Selecione um serviço...' },
        ...services.map(service => ({
          value: service.id,
          label: `${service.name} — ${money(service.price)} / ` +
            ({
              one_time: 'cobrança única',
              monthly: 'mês',
              yearly: 'ano'
            }[service.billing_cycle] || service.billing_cycle || 'cobrança')
        }))
      ];

      openModal(
        'Adicionar serviço ao cliente',
        `<p class="summary-footer" style="margin-bottom:14px">
          O serviço será vinculado ao cliente com status Pendente.
          O preço e o ciclo de cobrança serão copiados do catálogo.
          Esta ação não gera uma fatura automaticamente.
        </p>${field('Serviço do catálogo', 'service_id', 'text', true, options, '')}`,
        values => {
          const serviceId = Number(values.service_id);

          if (!Number.isSafeInteger(serviceId) || serviceId < 1) {
            throw new Error('Selecione um serviço válido.');
          }

          return api(`/api/clients/${encodeURIComponent(id)}/contracted-services`, {
            method: 'POST',
            body: JSON.stringify({ service_id: serviceId })
          });
        }
      );
    } catch (error) {
      notify(error.message || 'Não foi possível carregar o catálogo de serviços.', true);
    }
  }

  // --------------------------------------------------
  // EDITAR CLIENTE
  // --------------------------------------------------

  function editClient(id) {
    const client = state.cache.clients.find(item => String(item.id) === String(id));

    if (!client) {
      notify('Cliente não encontrado na lista atual. Atualize a tela.', true);
      return;
    }

    openModal('Editar cliente', [
      field('Nome completo / empresa', 'name', 'text', true, null, client.name),
      field('E-mail', 'email', 'email', false, null, client.email || ''),
      field('Telefone', 'phone', 'tel', false, null, client.phone || ''),
      field('CPF / CNPJ', 'document', 'text', false, null, client.document || ''),
      field('Observações', 'notes', 'textarea', false, null, client.notes || '')
    ].join(''), values => api(`/api/clients/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(values)
    }));
  }

  async function toggleClient(id, status) {
    const client = state.cache.clients.find(item => String(item.id) === String(id));

    if (!client) {
      notify('Cliente não encontrado na lista atual.', true);
      return;
    }

    const action = status === 'inactive' ? 'inativar' : 'ativar';

    if (!confirm(
      `Deseja ${action} o cadastro de "${client.name}"?\n\n` +
      'O registro e o histórico financeiro serão preservados.'
    )) return;

    try {
      await api(`/api/clients/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });

      notify(status === 'inactive' ? 'Cliente inativado.' : 'Cliente ativado.');

      if (state.page === 'client-record' &&
          String(state.currentClientId) === String(id)) {
        await openClientRecord(id);
      } else {
        await navigate('clients');
      }
    } catch (error) {
      notify(error.message, true);
    }
  }

  // --------------------------------------------------
  // SERVIÇOS — CATÁLOGO
  // --------------------------------------------------

  async function renderServices() {
    const [servicesResult, categoriesResult] = await Promise.all([
      api('/api/services'),
      state.user?.role === 'admin'
        ? api('/api/service-categories')
        : Promise.resolve([])
    ]);

    const services = getArray(servicesResult, 'services');
    const categories = getArray(categoriesResult, 'categories').length
      ? getArray(categoriesResult, 'categories')
      : getArray(categoriesResult, 'items').length
        ? getArray(categoriesResult, 'items')
        : Array.isArray(categoriesResult) ? categoriesResult : [];

    state.cache.services = services;
    state.cache.categories = categories;

    content.innerHTML = `
      ${pageHeader(
        'Serviços',
        'Catálogo de serviços comercializados pela VortexGrid.',
        state.user?.role === 'admin' ? 'Novo serviço' : '',
        'new-service'
      )}

      ${state.user?.role === 'admin' ? `
        <section class="content-card" style="margin-bottom:18px">
          <div class="panel-heading">
            <div>
              <h2>Categorias do catálogo</h2>
              <p>Organize os serviços por categoria e mantenha as opções de cadastro atualizadas.</p>
            </div>
            <button type="button" class="btn"
              data-action="manage-categories">Gerenciar categorias</button>
          </div>
          <p class="summary-footer">
            ${categories.length} categoria(s) cadastrada(s).
          </p>
        </section>
      ` : ''}

      ${table(
        [
          'Serviço',
          'Categoria',
          'Preço',
          'Cobrança',
          'Vitrine principal',
          'Status',
          ...(state.user?.role === 'admin' ? ['Ações'] : [])
        ],
        services.map(service => {
          const active = isActive(service);

          return [
            `<strong>${escapeHTML(service.name)}</strong>`,
            escapeHTML(
              service.parent_category_name && service.linked_category_name
                ? `${service.parent_category_name} → ${service.linked_category_name}`
                : service.linked_category_name || service.category || '—'
            ),
            money(service.price),
            escapeHTML({
              one_time: 'Única',
              monthly: 'Mensal',
              yearly: 'Anual'
            }[service.billing_cycle] || service.billing_cycle || '—'),
            featuredLabel(service),
            statusLabel(active ? 'active' : 'inactive'),
            ...(state.user?.role === 'admin' ? [
              `<div class="quick-actions" style="gap:6px;flex-wrap:wrap">
                <button type="button" class="btn btn-small"
                  data-action="edit-service"
                  data-id="${escapeHTML(service.id)}">Editar</button>
                <button type="button"
                  class="btn btn-small ${active ? '' : 'btn-primary'}"
                  data-action="toggle-service"
                  data-id="${escapeHTML(service.id)}"
                  data-status="${active ? 'inactive' : 'active'}"
                  data-name="${escapeHTML(service.name || 'serviço')}">
                  ${active ? 'Inativar' : 'Ativar'}
                </button>
              </div>`
            ] : [])
          ];
        })
      )}
    `;
  }

  async function toggleService(id, status, name) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem alterar o status dos serviços.', true);
      return;
    }

    const serviceId = Number(id);

    if (!Number.isSafeInteger(serviceId) || serviceId < 1) {
      notify('Identificador de serviço inválido.', true);
      return;
    }

    const activating = status === 'active';

    if (!['active', 'inactive'].includes(status)) {
      notify('Status de serviço inválido.', true);
      return;
    }

    const action = activating ? 'ativar' : 'inativar';

    if (!confirm(
      `Deseja ${action} o serviço "${name || 'serviço'}"?\n\n` +
      (activating
        ? 'O serviço poderá ficar disponível para contratação, conforme as regras do catálogo.'
        : 'O serviço deixará de estar disponível para novas contratações. Os registros existentes serão preservados.')
    )) {
      return;
    }

    try {
      await api(`/api/services/${encodeURIComponent(serviceId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active: activating })
      });

      notify(activating ? 'Serviço ativado.' : 'Serviço inativado.');
      await navigate('services');
    } catch (error) {
      notify(error.message || 'Não foi possível alterar o status do serviço.', true);
    }
  }

  // --------------------------------------------------
  // CATEGORIAS DE SERVIÇOS
  // --------------------------------------------------

  async function renderCategories() {
    if (state.user?.role !== 'admin') {
      throw new Error('Apenas administradores podem gerenciar categorias.');
    }

    const result = await api('/api/service-categories');

    const categories = Array.isArray(result)
      ? result
      : getArray(result, 'categories').length
        ? getArray(result, 'categories')
        : getArray(result, 'items');

    state.cache.categories = categories;

    content.innerHTML = `
      <div class="page-header">
        <div>
          <h1>Categorias de serviços</h1>
          <p>Cadastre e organize as categorias utilizadas no catálogo da VortexGrid.</p>
        </div>
        <div class="quick-actions">
          <button type="button" class="btn"
            data-action="back-to-services">← Voltar aos serviços</button>
          <button type="button" class="btn btn-primary"
            data-action="new-category">+ Nova categoria</button>
        </div>
      </div>

      <section class="content-card" style="margin-bottom:18px">
        <div class="panel-heading">
          <div>
            <h2>Catálogo de categorias</h2>
            <p>As categorias ativas ficam disponíveis no cadastro de novos serviços.</p>
          </div>
        </div>
        ${table(
          ['Categoria / hierarquia', 'Identificador', 'Ordem', 'Status', 'Ações'],
          categories.map(category => {
            const active = isActive(category);
            return [
              `${category.parent_id ? '<span style="color:var(--muted,#8b95a7);padding-left:14px">↳ </span>' : ''}<strong>${escapeHTML(category.name || 'Sem nome')}</strong>${category.parent_name ? `<div class="summary-footer">Subcategoria de ${escapeHTML(category.parent_name)}</div>` : ''}`,
              escapeHTML(category.slug || '—'),
              escapeHTML(category.sort_order ?? 0),
              statusLabel(active ? 'active' : 'inactive'),
              `<div class="quick-actions" style="gap:6px;flex-wrap:wrap">
                <button type="button" class="btn btn-small"
                  data-action="edit-category"
                  data-id="${escapeHTML(category.id)}">Editar</button>
                <button type="button" class="btn btn-small"
                  data-action="toggle-category"
                  data-id="${escapeHTML(category.id)}"
                  data-status="${active ? 'inactive' : 'active'}"
                  data-name="${escapeHTML(category.name || 'categoria')}">
                  ${active ? 'Inativar' : 'Ativar'}
                </button>
                <button type="button" class="btn btn-small"
                  data-action="delete-category"
                  data-id="${escapeHTML(category.id)}"
                  data-name="${escapeHTML(category.name || 'categoria')}">Excluir</button>
              </div>`
            ];
          })
        )}
      </section>

      <p class="summary-footer">
        ${categories.length} categoria(s) cadastrada(s). Inativar uma categoria não exclui os serviços já cadastrados nela.
      </p>
    `;
  }

  async function createCategory() {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem cadastrar categorias.', true);
      return;
    }

    const mainCategories = state.cache.categories.filter(category =>
      isActive(category) && !category.parent_id
    );
    const parentOptions = [
      { value: '', label: 'Categoria principal (sem categoria superior)' },
      ...mainCategories.map(category => ({ value: String(category.id), label: category.name }))
    ];

    openModal(
      'Nova categoria ou subcategoria',
      `
        ${field('Nome da categoria', 'name', 'text', true)}
        ${field('Categoria principal', 'parent_id', 'text', false, parentOptions, '')}
        <p class="summary-footer">
          Deixe como categoria principal ou selecione uma categoria para criar uma subcategoria. São permitidos apenas dois níveis.
        </p>
      `,
      async values => {
        const name = String(values.name || '').trim();

        if (!name) {
          throw new Error('Informe o nome da categoria.');
        }

        if (name.length > 80) {
          throw new Error('O nome da categoria deve ter no máximo 80 caracteres.');
        }

        await api('/api/service-categories', {
          method: 'POST',
          body: JSON.stringify({
            name,
            parent_id: values.parent_id ? Number(values.parent_id) : null
          })
        });

        state.cache.categories = [];
      }
    );
  }

  async function editCategory(id) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem editar categorias.', true);
      return;
    }

    const category = state.cache.categories.find(item => String(item.id) === String(id));
    if (!category) {
      notify('Categoria não encontrada. Atualize a lista e tente novamente.', true);
      return;
    }

    const parentOptions = [
      { value: '', label: 'Categoria principal (sem categoria superior)' },
      ...state.cache.categories
        .filter(item => !item.parent_id && String(item.id) !== String(category.id) && isActive(item))
        .map(item => ({ value: String(item.id), label: item.name }))
    ];

    openModal('Editar categoria ou subcategoria', [
      field('Nome da categoria', 'name', 'text', true, null, category.name || ''),
      field('Categoria principal', 'parent_id', 'text', false, parentOptions, category.parent_id ? String(category.parent_id) : '')
    ].join(''), async values => {
      const name = String(values.name || '').trim();
      if (!name) throw new Error('Informe o nome da categoria.');
      if (name.length > 80) throw new Error('O nome deve ter no máximo 80 caracteres.');
      const parentId = values.parent_id ? Number(values.parent_id) : null;
      if (parentId && (String(parentId) === String(category.id) || state.cache.categories.some(item => String(item.id) === String(parentId) && item.parent_id))) {
        throw new Error('Escolha uma categoria principal válida. Não é permitido criar níveis adicionais.');
      }
      await api(`/api/service-categories/${encodeURIComponent(category.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, parent_id: parentId })
      });
      state.cache.categories = [];
    });
  }

  async function deleteCategory(id, name) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem excluir categorias.', true);
      return;
    }

    const categoryId = Number(id);
    if (!Number.isSafeInteger(categoryId) || categoryId < 1) {
      notify('Identificador de categoria inválido.', true);
      return;
    }

    if (!confirm(`Deseja excluir definitivamente a categoria "${name || 'categoria'}"?\n\nA exclusão será bloqueada se houver serviços ou subcategorias vinculados.`)) return;

    try {
      await api(`/api/service-categories/${encodeURIComponent(categoryId)}`, {
        method: 'DELETE'
      });
      state.cache.categories = [];
      notify('Categoria excluída.');
      await navigate('categories');
    } catch (error) {
      notify(error.message || 'Não foi possível excluir a categoria.', true);
    }
  }

  async function toggleCategory(id, status, name) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem alterar categorias.', true);
      return;
    }

    const categoryId = Number(id);

    if (!Number.isSafeInteger(categoryId) || categoryId < 1) {
      notify('Identificador de categoria inválido.', true);
      return;
    }

    const activating = status === 'active';

    if (!confirm(
      `Deseja ${activating ? 'ativar' : 'inativar'} a categoria "${name || 'categoria'}"?\n\n` +
      (activating
        ? 'Ela ficará disponível para novos serviços.'
        : 'Ela deixará de aparecer nas opções de novos serviços. Os serviços existentes serão preservados.')
    )) return;

    try {
      await api(`/api/service-categories/${encodeURIComponent(categoryId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: activating })
      });

      notify(activating ? 'Categoria ativada.' : 'Categoria inativada.');
      await navigate('categories');
    } catch (error) {
      notify(error.message || 'Não foi possível atualizar a categoria.', true);
    }
  }

  // --------------------------------------------------
  // FINANCEIRO
  // --------------------------------------------------

  async function renderFinance() {
    // Somente administradores podem executar a atualização operacional dos vencimentos.
    if (state.user?.role === 'admin') {
      await api('/api/invoices/refresh-overdue', { method: 'POST' }).catch(() => {});
    }

    const invoicesResult = await api('/api/invoices');

    // Operadores não podem consultar a lista completa de clientes.
    state.cache.clients = [];
    state.cache.invoices = getArray(invoicesResult, 'invoices');

    drawFinance();
  }

  function filteredInvoices() {
    const term = state.financeSearch.trim().toLocaleLowerCase('pt-BR');

    return state.cache.invoices.filter(invoice => {
      const matchesStatus = state.financeStatus === 'all' ||
        invoice.status === state.financeStatus;

      const searchable = [
        invoice.client_name,
        invoice.description,
        invoice.id
      ].join(' ').toLocaleLowerCase('pt-BR');

      return matchesStatus && (!term || searchable.includes(term));
    });
  }

  function invoiceRow(invoice) {
    const open = invoice.status === 'pending' || invoice.status === 'overdue';
    const id = escapeHTML(invoice.id);

    return [
      escapeHTML(invoice.id),
      `<strong>${escapeHTML(invoice.client_name || `Cliente #${invoice.client_id}`)}</strong>`,
      escapeHTML(invoice.description),
      money(invoice.amount),
      date(invoice.due_date),
      statusLabel(invoice.status),
      state.user?.role === 'admin' && open ? `
        <div class="quick-actions">
          <button type="button" class="btn btn-small"
            data-action="view-invoice" data-id="${id}">Ver fatura</button>
          <button type="button" class="btn btn-small btn-primary"
            data-action="checkout-pro" data-id="${id}">Checkout Pro</button>
          <button type="button" class="btn btn-small"
            data-action="pay-invoice" data-id="${id}">Registrar pagamento</button>
          <button type="button" class="btn btn-small"
            data-action="cancel-invoice" data-id="${id}">Cancelar</button>
        </div>
      ` : `
        <button type="button" class="btn btn-small"
          data-action="view-invoice" data-id="${id}">Ver fatura</button>
      `
    ];
  }

  function findInvoice(invoiceId) {
    return state.cache.invoices.find(invoice => String(invoice.id) === String(invoiceId));
  }

  function viewInvoice(invoiceId) {
    const invoice = findInvoice(invoiceId);
    if (!invoice) {
      notify('Fatura não encontrada na lista atual. Atualize a página e tente novamente.', true);
      return;
    }

    const canGenerateCheckoutPro = state.user?.role === 'admin' &&
      ['pending', 'overdue'].includes(invoice.status);

    const modalElement = ensureModal();
    modalElement.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 id="modal-title">Fatura #${escapeHTML(invoice.id)}</h2>
          <button type="button" class="btn btn-small" data-action="close-modal">Fechar</button>
        </div>
        <div class="modal-body">
          <div class="form-field"><span>Cliente</span><strong>${escapeHTML(invoice.client_name || `Cliente #${invoice.client_id}`)}</strong></div>
          <div class="form-field"><span>Descrição</span><strong>${escapeHTML(invoice.description || '—')}</strong></div>
          <div class="form-field"><span>Valor</span><strong>${money(invoice.amount)}</strong></div>
          <div class="form-field"><span>Vencimento</span><strong>${date(invoice.due_date)}</strong></div>
          <div class="form-field"><span>Status</span><strong>${statusLabel(invoice.status)}</strong></div>
          ${canGenerateCheckoutPro ? `<p>Crie uma preferência do Checkout Pro para gerar um link seguro de pagamento no Mercado Pago.</p>` : ''}
        </div>
        <div class="modal-footer">
          ${canGenerateCheckoutPro ? `<button type="button" class="btn btn-primary" data-action="checkout-pro" data-id="${escapeHTML(invoice.id)}">Criar link Checkout Pro</button>` : ''}
          <button type="button" class="btn" data-action="close-modal">Fechar</button>
        </div>
      </section>
    `;
    modalElement.hidden = false;
    modalElement.style.display = 'block';
    modalElement.setAttribute('aria-hidden', 'false');
  }

  function showCheckoutProResult(result) {
    const initPoint = typeof result.checkout_url === 'string' ? result.checkout_url : (typeof result.init_point === 'string' ? result.init_point : '');
    let safeUrl = '';
    try {
      const parsed = new URL(initPoint);
      if (parsed.protocol === 'https:' && /(^|\.)mercadopago\.com(\.br)?$/i.test(parsed.hostname)) {
        safeUrl = parsed.href;
      }
    } catch (_) {}

    const modalElement = ensureModal();
    modalElement.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 id="modal-title">Checkout Pro criado — Fatura #${escapeHTML(result.invoice_id)}</h2>
          <button type="button" class="btn btn-small" data-action="close-modal">Fechar</button>
        </div>
        <div class="modal-body">
          <p><strong>Valor:</strong> ${money(result.amount)}</p>
          <p><strong>Preferência:</strong> ${escapeHTML(result.preference_id || '—')}</p>
          <p>A preferência foi criada. O pagamento só será confirmado após a notificação validada do Mercado Pago.</p>
          ${safeUrl
            ? `<p><a class="btn btn-primary" href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">Abrir Checkout Pro</a></p>
               <label class="form-field"><span>Link para enviar ao cliente</span><input id="checkout-pro-link" type="url" readonly value="${escapeHTML(safeUrl)}"></label>
               <button type="button" class="btn" data-action="copy-checkout-pro">Copiar link</button>`
            : '<p>O Mercado Pago não retornou um link de checkout válido. Consulte os logs da aplicação.</p>'}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-action="close-modal">Fechar</button>
        </div>
      </section>
    `;
    modalElement.hidden = false;
    modalElement.style.display = 'block';
    modalElement.setAttribute('aria-hidden', 'false');
  }

  async function generateInvoiceCheckoutPro(invoiceId) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem criar links de Checkout Pro.', true);
      return;
    }

    const invoice = findInvoice(invoiceId);
    if (!invoice) {
      notify('Fatura não encontrada na lista atual. Atualize a página e tente novamente.', true);
      return;
    }
    if (!['pending', 'overdue'].includes(invoice.status)) {
      notify('Somente faturas pendentes ou vencidas podem receber um link de Checkout Pro.', true);
      return;
    }

    if (!confirm(`Criar um link de Checkout Pro de ${money(invoice.amount)} para a fatura #${invoice.id}?`)) {
      return;
    }

    try {
      const result = await api(`/api/invoices/${encodeURIComponent(invoice.id)}/mercadopago/checkout-pro`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      showCheckoutProResult(result);
      notify('Preferência Checkout Pro criada.');
    } catch (error) {
      notify(error.message || 'Não foi possível criar o link Checkout Pro.', true);
    }
  }

  function showPixResult(result) {
    const pixCode = typeof result.pix_code === 'string' ? result.pix_code : '';
    const pixUrl = typeof result.pix_url === 'string' ? result.pix_url : '';
    const safeUrl = /^https:\/\//i.test(pixUrl) ? pixUrl : '';
    const modalElement = ensureModal();

    modalElement.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 id="modal-title">PIX emitido pelo Mercado Pago — Fatura #${escapeHTML(result.invoice_id)}</h2>
          <button type="button" class="btn btn-small" data-action="close-modal">Fechar</button>
        </div>
        <div class="modal-body">
          <p><strong>Valor:</strong> ${money(result.amount)}</p>
          <p><strong>Status:</strong> Pendente de pagamento</p>
          ${pixCode ? `
            <label class="form-field">
              <span>PIX copia e cola</span>
              <textarea id="pix-copy-code" rows="5" readonly>${escapeHTML(pixCode)}</textarea>
            </label>
            <button type="button" class="btn btn-primary" data-action="copy-pix">Copiar código PIX</button>
          ` : '<p>O Mercado Pago não retornou o código copia e cola. Consulte o link da cobrança, se disponível.</p>'}
          ${safeUrl ? `<p><a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">Abrir QR Code / cobrança PIX</a></p>` : ''}
          <p>Guarde o código e confira o pagamento na área Financeiro. Nenhum pagamento foi marcado manualmente como recebido.</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-action="close-modal">Fechar</button>
        </div>
      </section>
    `;
    modalElement.hidden = false;
    modalElement.style.display = 'block';
    modalElement.setAttribute('aria-hidden', 'false');
  }

  function generateInvoicePix(invoiceId) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem emitir PIX.', true);
      return;
    }

    const invoice = findInvoice(invoiceId);
    if (!invoice) {
      notify('Fatura não encontrada na lista atual. Atualize a página e tente novamente.', true);
      return;
    }
    if (!['pending', 'overdue'].includes(invoice.status)) {
      notify('Somente faturas pendentes ou vencidas podem receber PIX.', true);
      return;
    }

    openModal('Gerar PIX — Fatura #' + invoice.id, `
      <p>Cliente: <strong>${escapeHTML(invoice.client_name || `Cliente #${invoice.client_id}`)}</strong></p>
      <p>Descrição: <strong>${escapeHTML(invoice.description || 'Fatura VortexGrid')}</strong></p>
      <p>Valor: <strong>${money(invoice.amount)}</strong></p>
      <p>Ao confirmar, será criada uma cobrança PIX real pelo Mercado Pago.</p>
      <label class="form-field"><span>CPF ou CNPJ do pagador (somente números)</span>
        <input name="payer_cpf_cnpj" type="text" inputmode="numeric" autocomplete="off" pattern="(?:\\d{11}|\\d{14})" minlength="11" maxlength="14" placeholder="CPF com 11 ou CNPJ com 14 números" required>
      </label>
      <label class="form-field"><span>Prazo do PIX (dias, máximo 30)</span>
        <input name="days_due_date" type="number" min="1" max="30" step="1" value="1" required>
      </label>
    `, async values => {
      return await api(`/api/invoices/${encodeURIComponent(invoice.id)}/mercadopago/pix`, {
        method: 'POST',
        body: JSON.stringify({
          payer_cpf_cnpj: values.payer_cpf_cnpj,
          days_due_date: Number(values.days_due_date)
        })
      });
    }, {
      submitLabel: 'Confirmar e emitir PIX',
      successMessage: 'PIX emitido pelo Mercado Pago.',
      onSuccess: result => showPixResult(result)
    });
  }

  function drawFinance() {
    const all = state.cache.invoices;
    const sum = list => list.reduce((total, item) => total + Number(item.amount || 0), 0);

    const open = all.filter(item => ['pending', 'overdue'].includes(item.status));
    const overdue = all.filter(item => item.status === 'overdue');
    const paid = all.filter(item => item.status === 'paid');

    const rows = filteredInvoices();
    const statuses = [
      ['all', 'Todas'],
      ['pending', 'Pendentes'],
      ['overdue', 'Vencidas'],
      ['paid', 'Pagas'],
      ['cancelled', 'Canceladas']
    ];

    content.innerHTML = `
      ${pageHeader('Financeiro',
        state.user?.role === 'admin'
          ? 'Acompanhe faturas, vencimentos e pagamentos.'
          : 'Consulte as faturas e cadastre novos clientes. As demais operações são restritas ao administrador.',
        state.user?.role === 'admin' ? 'Nova fatura' : 'Novo cliente',
        state.user?.role === 'admin' ? 'new-invoice' : 'new-client')}

      <section class="stats-grid">
        ${statCard('Em aberto', money(sum(open)), `${open.length} fatura(s)`, '▤')}
        ${statCard('Vencidas', money(sum(overdue)), `${overdue.length} fatura(s)`, '!')}
        ${statCard('Pagas', money(sum(paid)), `${paid.length} fatura(s)`, 'R$')}
        ${statCard('Total de faturas', String(all.length), 'Consulta até 500 registros', '#')}
      </section>

      <section class="content-card" style="margin-bottom:18px">
        <div class="filter-bar">
          <div class="filter-tabs" role="tablist">
            ${statuses.map(([value, label]) => `
              <button type="button" role="tab"
                class="filter-tab ${state.financeStatus === value ? 'active' : ''}"
                data-action="finance-filter" data-status="${value}">${label}</button>
            `).join('')}
          </div>
          <label class="form-field filter-search">
            <span>Pesquisar</span>
            <input id="finance-search" type="search"
              placeholder="Cliente, descrição ou nº da fatura"
              value="${escapeHTML(state.financeSearch)}">
          </label>
        </div>
        <p class="summary-footer">${rows.length} fatura(s) exibida(s).</p>
      </section>

      <div id="finance-table">
        ${table(['ID', 'Cliente', 'Descrição', 'Valor', 'Vencimento', 'Status', 'Ação'],
          rows.map(invoiceRow))}
      </div>
    `;

    const search = $('#finance-search', content);

    if (search) {
      search.addEventListener('input', () => {
        state.financeSearch = search.value;

        const target = $('#finance-table', content);
        const footer = content.querySelector('.summary-footer');
        const list = filteredInvoices();

        if (target) {
          target.innerHTML = table(
            ['ID', 'Cliente', 'Descrição', 'Valor', 'Vencimento', 'Status', 'Ação'],
            list.map(invoiceRow)
          );
        }

        if (footer) footer.textContent = `${list.length} fatura(s) exibida(s).`;
      });
    }
  }

  async function cancelInvoice(id) {
    if (!confirm('Deseja cancelar esta fatura?\n\nEssa ação não pode ser desfeita.')) return;

    try {
      const result = await api(`/api/invoices/${encodeURIComponent(id)}/cancel`, {
        method: 'PATCH'
      });

      notify(result.mensagem || 'Fatura cancelada.');
      await navigate('finance');
    } catch (error) {
      notify(error.message, true);
    }
  }

  // --------------------------------------------------
  // SOLICITAÇÕES DOS CLIENTES
  // --------------------------------------------------

  async function refreshOrdersBadge() {
    const badge = $('#orders-badge');

    if (!badge || state.user?.role !== 'admin') return;

    try {
      const result = await api('/api/service-orders?status=pending');
      const total = getArray(result, 'orders').length;

      badge.textContent = total > 99 ? '99+' : String(total);
      badge.hidden = total === 0;
    } catch {
      badge.hidden = true;
    }
  }

  // --------------------------------------------------
  // ATIVAÇÕES — SERVIÇOS CONTRATADOS
  // --------------------------------------------------

  async function renderActivations() {
    const result = await api('/api/contracted-services');
    const services = getArray(result, 'services');
    const status = state.activationStatus || 'in_progress';

    const matches = service => {
      const operational = service.operational_status || 'awaiting_payment';
      if (status === 'in_progress') {
        return ['awaiting_payment', 'preparing', 'awaiting_supplier', 'awaiting_client', 'activating'].includes(operational);
      }
      if (status === 'active') return operational === 'active';
      if (status === 'attention') return ['activation_failed', 'awaiting_supplier', 'awaiting_client'].includes(operational);
      if (status === 'paused') return ['suspended', 'cancelled'].includes(operational);
      return true;
    };

    const filtered = services.filter(matches);
    const inProgress = services.filter(service => ['awaiting_payment', 'preparing', 'awaiting_supplier', 'awaiting_client', 'activating'].includes(service.operational_status || 'awaiting_payment')).length;
    const active = services.filter(service => service.operational_status === 'active').length;
    const attention = services.filter(service => ['activation_failed', 'awaiting_supplier', 'awaiting_client'].includes(service.operational_status)).length;

    const tabs = [
      ['in_progress', 'Em andamento'],
      ['active', 'Ativados'],
      ['attention', 'Precisam de atenção'],
      ['paused', 'Suspensos / cancelados'],
      ['all', 'Todos']
    ];

    content.innerHTML = `
      ${pageHeader('Ativações e serviços contratados',
        'Acompanhe todos os serviços vendidos, desde a confirmação do pagamento até a ativação, sem precisar abrir cada perfil de cliente.')}

      <section class="stats-grid" style="margin-bottom:18px">
        ${statCard('Em andamento', String(inProgress), 'Aguardando preparação ou ativação', '◷')}
        ${statCard('Ativados', String(active), 'Serviços prontos para o cliente', '✓')}
        ${statCard('Precisam de atenção', String(attention), 'Pendências com fornecedor ou cliente e falhas', '!')}
      </section>

      <section class="content-card" style="margin-bottom:18px">
        <div class="filter-tabs" role="tablist" aria-label="Filtrar serviços contratados">
          ${tabs.map(([value, label]) => `
            <button type="button" role="tab"
              class="filter-tab ${status === value ? 'active' : ''}"
              aria-selected="${status === value ? 'true' : 'false'}"
              data-action="activations-filter" data-status="${value}">${label}</button>
          `).join('')}
        </div>
        <p class="summary-footer">${filtered.length} serviço(s) exibido(s) de ${services.length} contratado(s).</p>
      </section>

      ${table(
        ['ID', 'Cliente', 'Serviço', 'Valor', 'Pagamento / contrato', 'Etapa operacional', 'Criado em', 'Ações'],
        filtered.map(service => [
          `#${escapeHTML(service.id)}`,
          `<strong>${escapeHTML(service.client_name || 'Cliente')}</strong><br><small>${escapeHTML(service.client_email || '—')}</small>`,
          `<strong>${escapeHTML(service.name || 'Serviço')}</strong>${service.service_category ? `<br><small>${escapeHTML(service.service_category)}</small>` : ''}`,
          money(service.sale_price),
          statusLabel(service.status),
          `<div><strong>${escapeHTML(operationalStatusLabel(service.operational_status))}</strong><div class="summary-footer" style="margin-top:6px">${service.operational_status !== 'active' && service.operational_status !== 'cancelled' ? `<button type="button" class="btn btn-small btn-primary" data-action="change-operational-status" data-id="${escapeHTML(service.id)}" data-status="${escapeHTML(service.operational_status || 'awaiting_payment')}" data-name="${escapeHTML(service.name || 'Serviço')}">Atualizar etapa</button> ` : ''}<button type="button" class="btn btn-small" data-action="view-operational-history" data-id="${escapeHTML(service.id)}" data-name="${escapeHTML(service.name || 'Serviço')}">Histórico</button></div></div>`,
          dateTime(service.created_at),
          `<button type="button" class="btn btn-small" data-action="client-record" data-id="${escapeHTML(service.client_id)}">Abrir cliente</button>`
        ])
      )}
    `;
  }

  async function renderOrders() {
    const status = state.orderStatus;
    const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;

    const result = await api(`/api/service-orders${query}`);
    const orders = getArray(result, 'orders');
    state.cache.orders = orders;

    const tabs = [
      ['pending', 'Pendentes'],
      ['approved', 'Aprovadas'],
      ['rejected', 'Rejeitadas'],
      ['all', 'Todas']
    ];

    content.innerHTML = `
      ${pageHeader('Solicitações',
        'Analise os pedidos de serviço feitos pelos clientes no portal.')}

      <section class="content-card" style="margin-bottom:18px">
        <div class="filter-tabs" role="tablist">
          ${tabs.map(([value, label]) => `
            <button type="button" role="tab"
              class="filter-tab ${status === value ? 'active' : ''}"
              data-action="orders-filter" data-status="${value}">${label}</button>
          `).join('')}
        </div>
        <p class="summary-footer">${orders.length} solicitação(ões) exibida(s).</p>
      </section>

      ${table(['Nº', 'Cliente', 'Serviço', 'Valor', 'Ciclo', 'Pagamento', 'Estado operacional', 'Solicitada em', 'Aprovação', 'Ação'],
        orders.map(order => [
          escapeHTML(order.id),
          `<strong>${escapeHTML(order.client_name)}</strong>
           <br><small>${escapeHTML(order.client_email || '—')}</small>`,
          `${escapeHTML(order.service_name || order.description_snapshot)}
           ${order.customer_notes
             ? `<br><small>Cliente: ${escapeHTML(order.customer_notes)}</small>`
             : ''}`,
          money(order.amount_snapshot),
          escapeHTML(cycleLabel(order.billing_cycle_snapshot)),
          paymentStatusLabel(order.payment_status),
          operationalStatusLabel(order.operational_status),
          dateTime(order.created_at),
          statusLabel(order.approval_status),
          `<div class="quick-actions">
            ${order.approval_status === 'pending'
              ? `<button type="button" class="btn btn-small btn-primary"
                   data-action="review-order" data-id="${escapeHTML(order.id)}">Analisar</button>`
              : `<small>${escapeHTML(order.reviewed_by_name || 'Automático')}<br>${dateTime(order.reviewed_at)}
                   ${order.admin_notes ? `<br>“${escapeHTML(order.admin_notes)}”` : ''}</small>`}
            ${order.contracted_service_id && order.payment_status === 'paid'
              ? `<button type="button" class="btn btn-small"
                   data-action="change-operational-status"
                   data-id="${escapeHTML(order.contracted_service_id)}"
                   data-status="${escapeHTML(order.operational_status || 'awaiting_payment')}"
                   data-name="${escapeHTML(order.service_name || order.description_snapshot)}">Atualizar etapa</button>
                 <button type="button" class="btn btn-small"
                   data-action="view-operational-history"
                   data-id="${escapeHTML(order.contracted_service_id)}"
                   data-name="${escapeHTML(order.service_name || order.description_snapshot)}">Histórico</button>`
              : ''}
          </div>`
        ]))}
    `;
  }

  async function reviewOrder(id) {
    let order = state.cache.orders.find(item => String(item.id) === String(id));

    if (!order) {
      const result = await api('/api/service-orders?status=pending');
      order = getArray(result, 'orders').find(item => String(item.id) === String(id));
    }

    if (!order) {
      notify('Solicitação não encontrada ou já analisada.', true);
      return;
    }

    openModal(`Analisar solicitação #${order.id}`, `
      <div class="order-summary">
        <div><span>Cliente</span><strong>${escapeHTML(order.client_name)}</strong></div>
        <div><span>Serviço</span><strong>${escapeHTML(order.service_name || order.description_snapshot)}</strong></div>
        <div><span>Valor</span><strong>${escapeHTML(money(order.amount_snapshot))} · ${escapeHTML(cycleLabel(order.billing_cycle_snapshot))}</strong></div>
        ${order.customer_notes ? `<div><span>Observação do cliente</span><strong>${escapeHTML(order.customer_notes)}</strong></div>` : ''}
      </div>
      ${field('Decisão', 'decision', 'text', true, [
        { value: 'approved', label: 'Aprovar — criar serviço pendente de ativação' },
        { value: 'rejected', label: 'Rejeitar solicitação' }
      ])}
      ${field('Observações para o histórico (opcional)', 'admin_notes', 'textarea', false)}
    `, async values => {
      await api(`/api/service-orders/${encodeURIComponent(order.id)}/review`, {
        method: 'PATCH',
        body: JSON.stringify({
          decision: values.decision,
          admin_notes: values.admin_notes || ''
        })
      });
    }, {
      submitLabel: 'Confirmar decisão',
      successMessage: 'Solicitação analisada com sucesso.'
    });
  }

  // --------------------------------------------------
  // ATENDIMENTO / TICKETS
  // --------------------------------------------------

  const ticketStatusLabel = value => ({
    open: 'Aberto', in_progress: 'Em atendimento',
    waiting_customer: 'Aguardando cliente', resolved: 'Resolvido', closed: 'Encerrado'
  }[value] || value || '—');
  const ticketPriorityLabel = value => ({
    low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente'
  }[value] || value || 'Normal');

  async function renderTickets() {
    state.currentTicketId = null;
    const filters = state.ticketFilters || { status: 'all', priority: 'all', assigned_to: 'all' };
    const params = new URLSearchParams();
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.priority !== 'all') params.set('priority', filters.priority);
    if (filters.assigned_to !== 'all') params.set('assigned_to', filters.assigned_to);
    const [tickets, stats, staff] = await Promise.all([
      api('/api/tickets' + (params.size ? '?' + params.toString() : '')),
      api('/api/ticket-stats'),
      api('/api/ticket-staff')
    ]);
    state.cache.tickets = Array.isArray(tickets) ? tickets : [];
    const list = state.cache.tickets;
    const people = Array.isArray(staff) ? staff : [];
    const options = (items, current, placeholder) =>
      '<option value="all" '+(current==='all'?'selected':'')+'>'+placeholder+'</option>' +
      items.map(([value,label])=>'<option value="'+escapeHTML(value)+'" '+(String(current)===String(value)?'selected':'')+'>'+escapeHTML(label)+'</option>').join('');
    content.innerHTML = `
      ${pageHeader('Atendimento / Tickets', 'Centralize as solicitações abertas no Portal do Cliente e responda pela equipe VortexGrid.')}
      <div class="stats-grid" style="margin-bottom:20px">
        ${statCard('Abertos', Number(stats.open || 0), 'Aguardando triagem')}
        ${statCard('Em atendimento', Number(stats.in_progress || 0), 'Em andamento')}
        ${statCard('Aguardando cliente', Number(stats.waiting_customer || 0), 'Dependem de retorno')}
        ${statCard('Resolvidos', Number(stats.resolved || 0), 'Atendimentos concluídos')}
      </div>
      <section class="content-card">
        <div class="card-heading"><div><h2>Fila de atendimento</h2><p>Filtre por status, prioridade ou responsável.</p></div>
          <button type="button" class="btn" data-action="refresh-tickets">Atualizar</button></div>
        <div class="form-grid" style="margin:14px 0">
          <div class="form-field"><label for="ticket-filter-status">Status</label><select id="ticket-filter-status">${options([['open','Aberto'],['in_progress','Em atendimento'],['waiting_customer','Aguardando cliente'],['resolved','Resolvido'],['closed','Encerrado']],filters.status,'Todos os status')}</select></div>
          <div class="form-field"><label for="ticket-filter-priority">Prioridade</label><select id="ticket-filter-priority">${options([['urgent','Urgente'],['high','Alta'],['normal','Normal'],['low','Baixa']],filters.priority,'Todas as prioridades')}</select></div>
          <div class="form-field"><label for="ticket-filter-assignee">Responsável</label><select id="ticket-filter-assignee">${options([['unassigned','Sem responsável'],...people.map(p=>[String(p.id),p.name+' ('+(p.role==='admin'?'Administrador':'Equipe')+')'])],filters.assigned_to,'Todos os responsáveis')}</select></div>
        </div>
        ${table(['Ticket','Cliente','Assunto / Serviço','Prioridade','Status','Responsável','Atualização','Última mensagem','Mensagens','Ação'], list.map(t => [
          '<strong>#'+escapeHTML(t.id)+'</strong>',
          '<strong>'+escapeHTML(t.client_name || 'Cliente')+'</strong><br><small>'+escapeHTML(t.client_email || '—')+'</small>',
          '<strong>'+escapeHTML(t.subject)+'</strong><br><small>Serviço: '+escapeHTML(t.service_name || 'Não identificado')+'</small>',
          '<span class="status">'+escapeHTML(ticketPriorityLabel(t.priority))+'</span>',
          '<span class="status status-'+escapeHTML(t.status)+'">'+escapeHTML(ticketStatusLabel(t.status))+'</span>',
          escapeHTML(t.assignee_name || 'Não atribuído'),
          t.last_sender_type === 'client' ? '<span class="status status-open">Resposta do cliente</span>' : '<span class="status">'+(t.last_sender_type === 'staff' ? 'Última resposta da equipe' : 'Sem mensagens')+'</span>',
          dateTime(t.last_message_at),
          escapeHTML(t.message_count || 0),
          '<button type="button" class="btn btn-small btn-primary" data-action="open-ticket" data-id="'+escapeHTML(t.id)+'">Atender</button>'
        ]))}
        ${list.length ? '' : '<p class="empty-state">Nenhum ticket corresponde aos filtros selecionados.</p>'}
      </section>
    `;
    const bindFilter = (selector, key) => {
      $(selector)?.addEventListener('change', event => {
        state.ticketFilters[key] = event.target.value;
        renderTickets().catch(error => notify(error.message, true));
      });
    };
    bindFilter('#ticket-filter-status', 'status');
    bindFilter('#ticket-filter-priority', 'priority');
    bindFilter('#ticket-filter-assignee', 'assigned_to');
  }

  async function openTicket(id) {
    const [result, staffResult] = await Promise.all([
      api('/api/tickets/' + encodeURIComponent(id)),
      api('/api/ticket-staff')
    ]);
    const staff = Array.isArray(staffResult) ? staffResult : [];
    const ticket = result.ticket;
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const attachments = Array.isArray(result.attachments) ? result.attachments : [];
    state.currentTicketId = ticket.id;
    content.innerHTML = `
      <div class="page-heading"><div><h2>Ticket #${escapeHTML(ticket.id)} — ${escapeHTML(ticket.subject)}</h2><p>${escapeHTML(ticket.client_name || 'Cliente')} · ${escapeHTML(ticket.client_email || '')}</p></div>
        <button type="button" class="btn" data-action="tickets-back">← Voltar aos tickets</button></div>
      <section class="content-card" style="margin-bottom:18px">
        <div class="form-grid">
          <div class="form-field"><label>Serviço relacionado</label><input value="${escapeHTML(ticket.service_name || 'Não identificado')}" disabled></div>
          <div class="form-field"><label for="ticket-status-select">Status</label><select id="ticket-status-select">
            ${[['open','Aberto'],['in_progress','Em atendimento'],['waiting_customer','Aguardando cliente'],['resolved','Resolvido'],['closed','Encerrado']].map(([v,l])=>'<option value="'+v+'" '+(ticket.status===v?'selected':'')+'>'+l+'</option>').join('')}
          </select></div>
          <div class="form-field"><label for="ticket-priority-select">Prioridade</label><select id="ticket-priority-select">
            ${[['low','Baixa'],['normal','Normal'],['high','Alta'],['urgent','Urgente']].map(([v,l])=>'<option value="'+v+'" '+(ticket.priority===v?'selected':'')+'>'+l+'</option>').join('')}
          </select></div>
          <div class="form-field"><label for="ticket-assignee-select">Responsável</label><select id="ticket-assignee-select">
            <option value="" ${ticket.assigned_to ? '' : 'selected'}>Não atribuído</option>
            ${staff.map(person=>'<option value="'+escapeHTML(person.id)+'" '+(String(ticket.assigned_to||'')===String(person.id)?'selected':'')+'>'+escapeHTML(person.name)+' ('+(person.role==='admin'?'Administrador':'Equipe')+')</option>').join('')}
          </select></div>
          <div class="form-field"><label>Categoria</label><input value="${escapeHTML(({general:'Geral',billing:'Financeiro',service:'Serviço',technical:'Técnico',account:'Conta'})[ticket.category] || ticket.category)}" disabled></div>
          <div class="form-field"><label>Aberto em</label><input value="${escapeHTML(dateTime(ticket.created_at))}" disabled></div>
        </div>
        <button type="button" class="btn btn-primary" data-action="save-ticket-settings" data-id="${escapeHTML(ticket.id)}">Salvar alterações</button>
      </section>
      <section class="content-card">
        <div class="card-heading"><div><h2>Conversa</h2><p>Histórico completo entre cliente e equipe.</p></div></div>
        <div class="ticket-conversation" style="display:grid;gap:12px;margin:18px 0">
          ${messages.map(m=>'<article style="padding:14px;border:1px solid var(--border-color, #ddd);border-radius:10px"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><strong>'+escapeHTML(m.sender_name)+' · '+(m.sender_type==='client'?'Cliente':'Equipe')+'</strong><small>'+escapeHTML(dateTime(m.created_at))+'</small></div><p style="white-space:pre-wrap;margin:10px 0 0">'+escapeHTML(m.message)+'</p></article>').join('')}
        </div>
        <div class="ticket-attachments" style="margin:14px 0">
          <h3>Anexos</h3>
          ${attachments.length ? '<ul>'+attachments.map(a=>'<li><a href="/api/tickets/'+encodeURIComponent(ticket.id)+'/attachments/'+encodeURIComponent(a.id)+'">'+escapeHTML(a.original_name)+'</a> <small>('+Math.max(1,Math.round(Number(a.size_bytes||0)/1024))+' KB · '+(a.uploaded_by_type==='client'?'Cliente':'Equipe')+')</small></li>').join('')+'</ul>' : '<p class="empty-state">Nenhum anexo neste ticket.</p>'}
        </div>
        ${ticket.status === 'closed' ? '<p class="empty-state">Este ticket está encerrado. Altere o status para reabrir e responder.</p>' : `
          <form id="ticket-reply-form" class="form-field">
            <label for="ticket-reply-message">Sua resposta</label>
            <textarea id="ticket-reply-message" name="message" rows="5" maxlength="5000" required placeholder="Escreva uma resposta clara para o cliente..."></textarea>
            <label for="ticket-reply-file">Anexo (opcional)</label>
            <input id="ticket-reply-file" name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt">
            <small>PDF, PNG, JPG ou TXT · até 5 MB.</small>
            <button class="btn btn-primary" type="submit">Enviar resposta ao cliente</button>
          </form>`}
      </section>`;
    const form = $('#ticket-reply-form');
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const message = $('#ticket-reply-message')?.value.trim();
      const file = $('#ticket-reply-file')?.files?.[0];
      if (!message) return;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api('/api/tickets/' + encodeURIComponent(ticket.id) + '/messages', { method:'POST', body:JSON.stringify({message}) });
        if (file) {
          const formData = new FormData();
          formData.append('file', file);
          await api('/api/tickets/' + encodeURIComponent(ticket.id) + '/attachments', { method:'POST', body:formData });
        }
        notify(file ? 'Resposta e anexo enviados ao cliente.' : 'Resposta enviada ao cliente.');
        await openTicket(ticket.id);
      } catch (error) { notify(error.message, true); button.disabled = false; }
    });
  }

  async function saveTicketSettings(id) {
    const status = $('#ticket-status-select')?.value;
    const priority = $('#ticket-priority-select')?.value;
    const assigned_to = $('#ticket-assignee-select')?.value || null;
    await api('/api/tickets/' + encodeURIComponent(id), { method:'PATCH', body:JSON.stringify({status,priority,assigned_to}) });
    notify('Ticket atualizado.');
    await openTicket(id);
  }

  // --------------------------------------------------
  // USUÁRIOS
  // --------------------------------------------------

  async function renderUsers() {
    const result = await api('/api/users');
    const users = getArray(result, 'users');
    state.cache.users = users;

    const roleLabel = role => role === 'admin' ? 'Administrador' : 'Equipe';

    content.innerHTML = `
      ${pageHeader('Usuários',
        'Gerencie os acessos administrativos da plataforma.',
        'Novo usuário', 'new-user')}
      ${table(['Nome', 'E-mail', 'Perfil', 'Status', 'Cadastro', 'Ações'],
        users.map(user => {
          const inactive = user.active === 0 || user.active === false;
          const self = Number(user.id) === Number(state.user?.id);
          const id = escapeHTML(user.id);

          return [
            `<strong>${escapeHTML(user.name)}</strong>${self ? ' <small>(você)</small>' : ''}`,
            escapeHTML(user.email),
            escapeHTML(roleLabel(user.role)),
            statusLabel(inactive ? 'inactive' : 'active'),
            date(user.created_at),
            `<div class="quick-actions">
              <button type="button" class="btn btn-small" data-action="edit-user" data-id="${id}">Editar</button>
              <button type="button" class="btn btn-small" data-action="reset-user-password" data-id="${id}">Senha</button>
              ${self ? '' : `<button type="button" class="btn btn-small" data-action="toggle-user" data-id="${id}" data-status="${inactive ? 'active' : 'inactive'}" data-name="${escapeHTML(user.name)}">${inactive ? 'Ativar' : 'Inativar'}</button>`}
            </div>`
          ];
        }))}
    `;
  }

  function editUser(id) {
    const user = state.cache.users.find(item => String(item.id) === String(id));

    if (!user) {
      notify('Usuário não encontrado.', true);
      return;
    }

    openModal('Editar usuário', [
      field('Nome', 'name', 'text', true, null, user.name),
      field('Perfil de acesso', 'role', 'text', true, [
        { value: 'staff', label: 'Equipe — acesso operacional' },
        { value: 'admin', label: 'Administrador — acesso total' }
      ], user.role)
    ].join(''), values => api(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: values.name, role: values.role })
    }));
  }

  function resetUserPassword(id) {
    const user = state.cache.users.find(item => String(item.id) === String(id));

    openModal(`Redefinir senha${user ? ` — ${user.name}` : ''}`, [
      field('Nova senha (mínimo 12 caracteres)', 'password', 'password')
    ].join(''), values => api(`/api/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: values.password })
    }), {
      submitLabel: 'Redefinir senha',
      successMessage: 'Senha redefinida com sucesso.'
    });
  }

  async function toggleUser(id, status, name) {
    const activate = status === 'active';

    if (!confirm(`${activate ? 'Ativar' : 'Inativar'} o usuário "${name || 'selecionado'}"?`)) return;

    try {
      const result = await api(`/api/users/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active: activate })
      });

      notify(result.mensagem || 'Status atualizado.');
      await navigate('users');
    } catch (error) {
      notify(error.message, true);
    }
  }

  function changeOwnPassword() {
    openModal('Minha conta — alterar senha', [
      field('Senha atual', 'current_password', 'password'),
      field('Nova senha (mínimo 12 caracteres)', 'new_password', 'password'),
      field('Confirmar nova senha', 'confirm_password', 'password')
    ].join(''), async values => {
      if (values.new_password !== values.confirm_password) {
        throw new Error('A confirmação não confere com a nova senha.');
      }

      await api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: values.current_password,
          new_password: values.new_password
        })
      });
    }, {
      submitLabel: 'Alterar senha',
      successMessage: 'Senha alterada com sucesso.'
    });
  }

  // --------------------------------------------------
  // CAMPOS E MODAIS
  // --------------------------------------------------

  function field(label, name, type = 'text', required = true, options = null, value = '') {
    let control;
    const safeValue = escapeHTML(value);

    if (options) {
      control = `
        <select name="${escapeHTML(name)}" ${required ? 'required' : ''}>
          ${options.map(option => `
            <option value="${escapeHTML(option.value)}"
              ${String(option.value) === String(value) ? 'selected' : ''}>
              ${escapeHTML(option.label)}
            </option>
          `).join('')}
        </select>
      `;
    } else if (type === 'textarea') {
      control = `<textarea name="${escapeHTML(name)}" ${required ? 'required' : ''}>${safeValue}</textarea>`;
    } else {
      control = `
        <input name="${escapeHTML(name)}" type="${escapeHTML(type)}"
          value="${safeValue}" ${required ? 'required' : ''}
          ${type === 'number' ? 'min="0" step="0.01"' : ''}
          ${type === 'password' ? 'minlength="12" maxlength="128"' : ''}>
      `;
    }

    return `<label class="form-field"><span>${escapeHTML(label)}</span>${control}</label>`;
  }

  function ensureModal() {
    modal = $('#modal');

    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal';
      modal.hidden = true;
      document.body.appendChild(modal);
    }

    return modal;
  }

  function openModal(title, fieldsHTML, onSubmit, options = {}) {
    const submitLabel = options.submitLabel || 'Salvar';
    const successMessage = options.successMessage || 'Registro salvo com sucesso.';
    const modalElement = ensureModal();

    modalElement.innerHTML = `
      <div class="modal-backdrop" data-action="close-modal"></div>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 id="modal-title">${escapeHTML(title)}</h2>
          <button type="button" class="btn btn-small" data-action="close-modal" aria-label="Fechar janela">Fechar</button>
        </div>
        <form id="record-form">
          <div class="modal-body">${fieldsHTML}</div>
          <div class="modal-footer">
            <button type="button" class="btn" data-action="close-modal">Cancelar</button>
            <button type="submit" class="btn btn-primary">${escapeHTML(submitLabel)}</button>
          </div>
        </form>
      </div>
    `;

    modalElement.hidden = false;
    modalElement.style.display = 'block';
    modalElement.setAttribute('aria-hidden', 'false');

    const form = $('#record-form', modalElement);

    if (!form) {
      notify('Não foi possível montar o formulário.', true);
      return;
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;

      const button = form.querySelector('[type="submit"]');
      const values = Object.fromEntries(new FormData(form).entries());

      button.disabled = true;
      button.textContent = 'Salvando...';

      try {
        const result = await onSubmit(values);
        if (typeof options.onSuccess === 'function') {
          await options.onSuccess(result, values);
          return;
        }

        closeModal();
        notify(successMessage);

        if (state.page === 'client-record' && state.currentClientId) {
          await refreshClientRecord(state.currentClientId);
        } else {
          await navigate(state.page);
        }
      } catch (error) {
        notify(error.message || 'Erro ao salvar o registro.', true);
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = submitLabel;
        }
      }
    });

    const first = form.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function closeModal() {
    modal = $('#modal');
    if (!modal) return;

    modal.hidden = true;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = '';
  }

  // --------------------------------------------------
  // CADASTROS
  // --------------------------------------------------

  function createClient() {
    openModal('Novo cliente', [
      field('Nome completo / empresa', 'name'),
      field('E-mail', 'email', 'email', false),
      field('Telefone', 'phone', 'tel', false),
      field('CPF / CNPJ', 'document', 'text', false),
      field('Observações', 'notes', 'textarea', false)
    ].join(''), values => api('/api/clients', {
      method: 'POST',
      body: JSON.stringify(values)
    }));
  }

  async function createService() {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem cadastrar serviços.', true);
      return;
    }

    try {
      const result = await api('/api/service-categories');
      const categories = Array.isArray(result)
        ? result
        : getArray(result, 'categories').length
          ? getArray(result, 'categories')
          : getArray(result, 'items');

      state.cache.categories = categories;
      const activeCategories = categories.filter(isActive);

      if (!activeCategories.length) {
        notify('Cadastre e ative pelo menos uma categoria antes de criar um serviço.', true);
        await navigate('categories');
        return;
      }

      const categoryOptions = [
        { value: '', label: 'Selecione uma categoria...' },
        ...activeCategories.map(category => {
          const parent = category.parent_id
            ? categories.find(item => String(item.id) === String(category.parent_id))
            : null;

          return {
            value: String(category.id),
            label: parent ? `${parent.name} → ${category.name}` : category.name
          };
        })
      ];

      openModal('Novo serviço', [
        field('Nome do serviço', 'name'),
        field('Descrição', 'description', 'textarea', false),
        field('Categoria / subcategoria', 'category_id', 'text', true, categoryOptions, ''),
        field('Preço (R$)', 'price', 'number'),
        field('Ciclo de cobrança', 'billing_cycle', 'text', true, [
          { value: 'one_time', label: 'Cobrança única' },
          { value: 'monthly', label: 'Mensal' },
          { value: 'yearly', label: 'Anual' }
        ]),
        field('Exibir na vitrine principal?', 'featured', 'text', true, [
          { value: '1', label: 'Sim — exibir na vitrine' },
          { value: '0', label: 'Não — somente no catálogo da categoria' }
        ], '0')
      ].join(''), values => {
        const selectedCategory = activeCategories.find(
          category => String(category.id) === String(values.category_id)
        );

        if (!selectedCategory) {
          throw new Error('Selecione uma categoria ou subcategoria ativa.');
        }

        const name = String(values.name || '').trim();
        if (!name) throw new Error('Informe o nome do serviço.');

        const price = Number(values.price);
        if (!Number.isFinite(price) || price < 0) {
          throw new Error('Informe um preço válido.');
        }

        return api('/api/services', {
          method: 'POST',
          body: JSON.stringify({
            name,
            description: values.description || '',
            category_id: Number(selectedCategory.id),
            category: selectedCategory.name,
            price,
            billing_cycle: values.billing_cycle,
            featured: values.featured === '1'
          })
        });
      });
    } catch (error) {
      notify(error.message || 'Não foi possível carregar as categorias.', true);
    }
  }

  async function editService(id) {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem editar serviços.', true);
      return;
    }

    const service = state.cache.services.find(item => String(item.id) === String(id));

    if (!service) {
      notify('Serviço não encontrado na lista atual. Atualize a tela.', true);
      return;
    }

    try {
      const result = await api('/api/service-categories');
      const categories = Array.isArray(result)
        ? result
        : getArray(result, 'categories').length
          ? getArray(result, 'categories')
          : getArray(result, 'items');

      state.cache.categories = categories;

      const categoryOptions = [
        { value: '', label: 'Selecione uma categoria...' },
        ...categories.filter(isActive).map(category => {
          const parent = category.parent_id
            ? categories.find(item => String(item.id) === String(category.parent_id))
            : null;

          return {
            value: String(category.id),
            label: parent ? `${parent.name} → ${category.name}` : category.name
          };
        })
      ];

      const selectedId = service.category_id != null
        ? String(service.category_id)
        : String((categories.find(category =>
            category.name === service.category
          )?.id) || '');

      openModal('Editar serviço', [
        field('Nome do serviço', 'name', 'text', true, null, service.name || ''),
        field('Descrição', 'description', 'textarea', false, null, service.description || ''),
        field('Categoria / subcategoria', 'category_id', 'text', true, categoryOptions, selectedId),
        field('Preço (R$)', 'price', 'number', true, null, String(service.price ?? 0)),
        field('Ciclo de cobrança', 'billing_cycle', 'text', true, [
          { value: 'one_time', label: 'Cobrança única' },
          { value: 'monthly', label: 'Mensal' },
          { value: 'yearly', label: 'Anual' }
        ], service.billing_cycle || 'monthly'),
        field('Exibir na vitrine principal?', 'featured', 'text', true, [
          { value: '1', label: 'Sim — exibir na vitrine' },
          { value: '0', label: 'Não — somente no catálogo da categoria' }
        ], isFeatured(service) ? '1' : '0')
      ].join(''), values => {
        const selectedCategory = categories.find(category =>
          String(category.id) === String(values.category_id) && isActive(category)
        );

        if (!selectedCategory) {
          throw new Error('Selecione uma categoria ou subcategoria ativa.');
        }

        const name = String(values.name || '').trim();
        if (!name) throw new Error('Informe o nome do serviço.');

        const price = Number(values.price);
        if (!Number.isFinite(price) || price < 0) {
          throw new Error('Informe um preço válido.');
        }

        return api(`/api/services/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name,
            description: values.description || '',
            category_id: Number(selectedCategory.id),
            category: selectedCategory.name,
            price,
            billing_cycle: values.billing_cycle,
            featured: values.featured === '1'
          })
        });
      });
    } catch (error) {
      notify(error.message || 'Não foi possível carregar o serviço para edição.', true);
    }
  }

  function createUser() {
    if (state.user?.role !== 'admin') {
      notify('Apenas administradores podem cadastrar usuários.', true);
      return;
    }

    openModal('Novo usuário', [
      field('Nome', 'name'),
      field('E-mail', 'email', 'email'),
      field('Senha (mínimo 12 caracteres)', 'password', 'password'),
      field('Perfil', 'role', 'text', true, [
        { value: 'staff', label: 'Equipe' },
        { value: 'admin', label: 'Administrador' }
      ])
    ].join(''), values => api('/api/users', {
      method: 'POST',
      body: JSON.stringify(values)
    }));
  }

  async function createInvoice(clientId = null) {
    let clients = state.cache.clients;

    if (!clients.length) {
      clients = getArray(await api('/api/clients'), 'clients');
      state.cache.clients = clients;
    }

    clients = clients.filter(client => !client.status || client.status === 'active');

    if (!clients.length) {
      notify('Cadastre um cliente ativo antes de criar uma fatura.', true);
      return;
    }

    const selectedClient = clients.find(client => String(client.id) === String(clientId));

    openModal('Nova fatura', [
      field('Cliente', 'client_id', 'text', true,
        clients.map(client => ({
          value: client.id,
          label: `${client.name} (${client.email || 'sem e-mail'})`
        })),
        selectedClient ? selectedClient.id : ''),
      field('Descrição', 'description'),
      field('Valor (R$)', 'amount', 'number'),
      field('Data de vencimento', 'due_date', 'date', false)
    ].join(''), values => api('/api/invoices', {
      method: 'POST',
      body: JSON.stringify({
        ...values,
        client_id: Number(values.client_id),
        amount: Number(values.amount),
        due_date: values.due_date || null
      })
    }));
  }

  async function payInvoice(id, returnToClient = false) {
    const invoice = state.cache.invoices.find(item => String(item.id) === String(id));

    if (!invoice) {
      notify('Não foi possível localizar a fatura na lista atual.', true);
      return;
    }

    if (invoice.status === 'paid' || invoice.status === 'cancelled') {
      notify('Esta fatura não aceita registro de pagamento.', true);
      return;
    }

    if (!confirm(`Registrar o pagamento integral de ${money(invoice.amount)} da fatura #${invoice.id}?`)) return;

    try {
      await api(`/api/invoices/${encodeURIComponent(id)}/payments`, {
        method: 'POST',
        body: JSON.stringify({ method: 'manual' })
      });

      notify('Pagamento registrado.');

      if (returnToClient && state.currentClientId) {
        await refreshClientRecord(state.currentClientId);
      } else {
        await navigate('finance');
      }
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function refreshClientRecord(id) {
    await openClientRecord(id);
  }

  async function loadInvoiceForClientPayment(invoiceId) {
    try {
      if (!state.cache.invoices.length) {
        const result = await api('/api/invoices');
        state.cache.invoices = getArray(result, 'invoices');
      }

      await payInvoice(invoiceId, true);
    } catch (error) {
      notify(error.message || 'Não foi possível carregar a fatura.', true);
    }
  }

  async function logout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      // Encerra a sessão visual mesmo se a requisição falhar.
    }

    closeModal();
    showLogin();
  }

  // --------------------------------------------------
  // LOGIN
  // --------------------------------------------------

  async function handleLogin(event) {
    event.preventDefault();
    if (loginError) loginError.textContent = '';

    const form = event.currentTarget;
    const email = $('[name="email"]', form)?.value?.trim();
    const password = $('[name="password"]', form)?.value;

    if (!email || !password) {
      if (loginError) loginError.textContent = 'Informe o e-mail e a senha.';
      return;
    }

    const button = form.querySelector('[type="submit"]');

    if (button) {
      button.disabled = true;
      button.textContent = 'Entrando...';
    }

    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      let user = normalizeUser(result);

      if (!user || !user.email) {
        try {
          user = normalizeUser(await api('/api/me'));
        } catch {
          user = null;
        }
      }

      if (!user) {
        throw new Error('A API não retornou os dados do usuário autenticado.');
      }

      state.user = user;
      showApp();
    } catch (error) {
      if (loginError) loginError.textContent = error.message;
      else alert(error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Entrar no painel';
      }
    }
  }

  const loginForm = $('#login-form');

  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);

    const loginButton = loginForm.querySelector('button[type="submit"], button:not([type])');

    if (loginButton) {
      loginButton.addEventListener('click', event => {
        event.preventDefault();
        handleLogin({
          preventDefault() {},
          currentTarget: loginForm
        });
      });
    }
  } else {
    console.error('VortexGrid: formulário #login-form não encontrado. Verifique se o index.html correto está publicado.');
  }

  // --------------------------------------------------
  // CLIQUES
  // --------------------------------------------------

  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const element = target.closest('[data-page], [data-action], [data-logout]');
    if (!element) return;

    if (element.dataset.page) {
      event.preventDefault();
      navigate(element.dataset.page);
      return;
    }

    if (element.hasAttribute('data-logout') || element.dataset.action === 'logout') {
      event.preventDefault();
      logout();
      return;
    }

    const action = element.dataset.action;
    if (!action) return;

    event.preventDefault();

    try {
      switch (action) {
        case 'open-ticket':
          openTicket(element.dataset.id).catch(error => notify(error.message, true));
          break;
        case 'refresh-tickets':
          renderTickets().catch(error => notify(error.message, true));
          break;
        case 'tickets-back':
          state.currentTicketId = null;
          navigate('tickets');
          break;
        case 'save-ticket-settings':
          saveTicketSettings(element.dataset.id).catch(error => notify(error.message, true));
          break;

        case 'new-client':
          createClient();
          break;

        case 'client-record':
          openClientRecord(element.dataset.id);
          break;

        case 'clients-back':
          state.currentClientId = null;
          navigate('clients');
          break;

        case 'refresh-client-record':
          refreshClientRecord(element.dataset.id);
          break;

        case 'add-contracted-service':
          addContractedService(element.dataset.id).catch(error => notify(error.message, true));
          break;

        case 'edit-contracted-service-details':
          openContractedServiceDetails(element.dataset.id, element.dataset.name);
          break;

        case 'change-contracted-service-status':
          changeContractedServiceStatus(
            element.dataset.id,
            element.dataset.status,
            element.dataset.name
          );
          break;

        case 'change-operational-status':
          changeOperationalStatus(element.dataset.id, element.dataset.status, element.dataset.name);
          break;

        case 'view-operational-history':
          viewOperationalHistory(element.dataset.id, element.dataset.name);
          break;

        case 'new-invoice-for-client':
          createInvoice(element.dataset.id).catch(error => notify(error.message, true));
          break;

        case 'pay-invoice-from-record':
          loadInvoiceForClientPayment(element.dataset.id);
          break;

        case 'edit-client':
          editClient(element.dataset.id);
          break;

        case 'toggle-client':
          toggleClient(element.dataset.id, element.dataset.status);
          break;

        case 'new-service':
          createService();
          break;

        case 'edit-service':
          editService(element.dataset.id);
          break;

        case 'toggle-service':
          toggleService(
            element.dataset.id,
            element.dataset.status,
            element.dataset.name
          );
          break;

        case 'manage-categories':
          navigate('categories');
          break;

        case 'back-to-services':
          navigate('services');
          break;

        case 'new-category':
          createCategory();
          break;

        case 'edit-category':
          editCategory(element.dataset.id);
          break;

        case 'delete-category':
          deleteCategory(element.dataset.id, element.dataset.name);
          break;

        case 'toggle-category':
          toggleCategory(
            element.dataset.id,
            element.dataset.status,
            element.dataset.name
          );
          break;

        case 'new-user':
          createUser();
          break;

        case 'edit-user':
          editUser(element.dataset.id);
          break;

        case 'reset-user-password':
          resetUserPassword(element.dataset.id);
          break;

        case 'toggle-user':
          toggleUser(element.dataset.id, element.dataset.status, element.dataset.name);
          break;

        case 'my-account':
          changeOwnPassword();
          break;

        case 'orders-filter':
          state.orderStatus = element.dataset.status || 'pending';
          navigate('orders');
          break;

        case 'activations-filter':
          state.activationStatus = element.dataset.status || 'in_progress';
          navigate('activations');
          break;

        case 'review-order':
          reviewOrder(element.dataset.id).catch(error => notify(error.message, true));
          break;

        case 'finance-filter':
          state.financeStatus = element.dataset.status || 'all';
          drawFinance();
          break;

        case 'cancel-invoice':
          cancelInvoice(element.dataset.id);
          break;

        case 'new-invoice':
          createInvoice().catch(error => notify(error.message, true));
          break;

        case 'pay-invoice':
          payInvoice(element.dataset.id);
          break;

        case 'view-invoice':
          viewInvoice(element.dataset.id);
          break;

        case 'checkout-pro':
          generateInvoiceCheckoutPro(element.dataset.id);
          break;

        case 'copy-checkout-pro': {
          const linkField = $('#checkout-pro-link');
          const link = linkField?.value || '';
          if (!link) {
            notify('O link do Checkout Pro não está disponível para copiar.', true);
            break;
          }
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(link)
              .then(() => notify('Link do Checkout Pro copiado.'))
              .catch(() => {
                linkField.focus();
                linkField.select();
                notify('Selecione o link e copie manualmente.', true);
              });
          } else {
            linkField.focus();
            linkField.select();
            const copied = document.execCommand('copy');
            notify(copied ? 'Link do Checkout Pro copiado.' : 'Selecione o link e copie manualmente.', !copied);
          }
          break;
        }


        case 'copy-pix': {
          const codeField = $('#pix-copy-code');
          const code = codeField?.value || '';
          if (!code) {
            notify('O código PIX não está disponível para copiar.', true);
            break;
          }
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(code)
              .then(() => notify('Código PIX copiado.'))
              .catch(() => {
                codeField.focus();
                codeField.select();
                notify('Selecione o código PIX e copie manualmente.', true);
              });
          } else {
            codeField.focus();
            codeField.select();
            const copied = document.execCommand('copy');
            notify(copied ? 'Código PIX copiado.' : 'Selecione o código PIX e copie manualmente.', !copied);
          }
          break;
        }

        case 'close-modal':
          closeModal();
          break;

        case 'refresh-dashboard':
          if (state.page === 'dashboard') {
            navigate('dashboard');
          }
          break;

        case 'reload':
          if (state.page === 'client-record' && state.currentClientId) {
            refreshClientRecord(state.currentClientId);
          } else {
            navigate(state.page);
          }
          break;

        default:
          console.warn('VortexGrid: ação sem manipulador:', action);
      }
    } catch (error) {
      console.error('VortexGrid: falha ao executar ação:', error);
      notify(error.message || 'Não foi possível executar esta ação.', true);
    }
  });



  // --------------------------------------------------
  // DASHBOARD LAYOUT — COMPOSIÇÃO SAAS PREMIUM
  // Reorganiza os blocos já renderizados sem duplicar dados
  // nem alterar endpoints ou ações existentes.
  // --------------------------------------------------
  function arrangePremiumDashboard() {
    const root = document.querySelector('#page-content');
    if (!root || !root.querySelector('.stats-grid')) return;
    if (root.querySelector('.vg-dashboard-layout')) return;

    const header = root.querySelector(':scope > .page-header');
    const alerts = root.querySelector(':scope > .alert-center');
    const stats = root.querySelector(':scope > .stats-grid');
    const finance = root.querySelector(':scope > .financial-overview');
    const activity = root.querySelector(':scope > .activity-center');
    const primary = root.querySelector(':scope > .dashboard-grid:not(.dashboard-grid-secondary)');
    const secondary = root.querySelector(':scope > .dashboard-grid-secondary');
    if (!header || !stats || !primary) return;

    const layout = document.createElement('div');
    layout.className = 'vg-dashboard-layout';
    const intro = document.createElement('div');
    intro.className = 'vg-dashboard-intro';
    const main = document.createElement('div');
    main.className = 'vg-dashboard-main';
    const bottom = document.createElement('div');
    bottom.className = 'vg-dashboard-bottom';

    root.insertBefore(layout, header);
    layout.appendChild(intro);
    intro.appendChild(header);
    intro.appendChild(stats);
    if (alerts) layout.appendChild(alerts);
    main.appendChild(primary);
    layout.appendChild(main);
    if (finance) layout.appendChild(finance);
    if (activity) bottom.appendChild(activity);
    if (secondary) {
      Array.from(secondary.children).forEach(function (card) {
        bottom.appendChild(card);
      });
      secondary.remove();
    }
    if (bottom.children.length) layout.appendChild(bottom);
    root.classList.add('vg-dashboard-ready');
  }

  const dashboardLayoutObserver = new MutationObserver(function () {
    arrangePremiumDashboard();
  });
  const dashboardLayoutRoot = document.querySelector('#page-content');
  if (dashboardLayoutRoot) {
    dashboardLayoutObserver.observe(dashboardLayoutRoot, { childList: true });
    arrangePremiumDashboard();
  }

  // --------------------------------------------------
  // INICIALIZAÇÃO
  // --------------------------------------------------

  async function init() {
    if (!loginView || !app || !content) {
      console.error('VortexGrid: confira #login-view, #app-view e #page-content no index.html.');
      return;
    }

    try {
      const result = await api('/api/me');
      const user = normalizeUser(result);

      if (!user) {
        showLogin();
        return;
      }

      state.user = user;
      showApp();
    } catch {
      showLogin();
    }
  }


  const globalSearchInput=$('#global-search-input'),globalSearchResults=$('#global-search-results'),globalSearchWrap=$('#global-search-wrap'),shortcutsButton=$('#shortcuts-button'),shortcutsMenu=$('#shortcuts-menu'),alertsButton=$('#header-alerts-button'),collapseButton=$('#sidebar-collapse-toggle');
  const mobileMenuButton = $('#mobile-menu-toggle');
  const mobileSidebarBackdrop = $('#sidebar-backdrop');
  function setMobileSidebarOpen(open) {
    document.body.classList.toggle('sidebar-open', Boolean(open));
    mobileMenuButton?.setAttribute('aria-expanded', String(Boolean(open)));
    mobileMenuButton?.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
    if (mobileSidebarBackdrop) mobileSidebarBackdrop.hidden = !open;
  }
  mobileMenuButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setMobileSidebarOpen(!document.body.classList.contains('sidebar-open'));
  });
  mobileSidebarBackdrop?.addEventListener('click', () => setMobileSidebarOpen(false));
  document.querySelectorAll('#sidebar [data-page]').forEach(item => {
    item.addEventListener('click', () => setMobileSidebarOpen(false));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setMobileSidebarOpen(false);
  });
  let globalSearchTimer=null,globalSearchRequest=0;
  function updateHeaderAlerts(d){const b=$('#header-alerts-badge');if(!b||state.user?.role!=='admin')return;const n=Number(d?.faturasVencidas||0)+Number(d?.ativacoesPendentes||0)+Number(d?.solicitacoesPendentes||0);b.textContent=n>99?'99+':String(n);b.hidden=n<=0;}
  function closeGlobalSearch(){if(globalSearchResults)globalSearchResults.hidden=true;globalSearchInput?.setAttribute('aria-expanded','false');}
  function closeShortcuts(){if(shortcutsMenu)shortcutsMenu.hidden=true;shortcutsButton?.setAttribute('aria-expanded','false');}
  function searchText(v){return v.filter(x=>x!==null&&x!==undefined).join(' ').toLocaleLowerCase('pt-BR');}
  async function globalData(){if(state.globalSearchCache)return state.globalSearchCache;const admin=state.user?.role==='admin';const [clients,services,invoices]=await Promise.all([admin?api('/api/clients').then(r=>getArray(r,'clients')).catch(()=>[]):Promise.resolve([]),admin?api('/api/services').then(r=>getArray(r,'services')).catch(()=>[]):Promise.resolve([]),api('/api/invoices').then(r=>getArray(r,'invoices')).catch(()=>[])]);return state.globalSearchCache={clients,services,invoices};}
  function resultButton(o){const k=o.type==='client'?'Cliente':o.type==='service'?'Serviço':'Fatura',sym=o.type==='client'?'♙':o.type==='service'?'▦':'R$';const page=o.action?'':o.page;return `<button type="button" class="global-search-result" role="option" data-page="${escapeHTML(page||'')}" data-action="${escapeHTML(o.action||'')}" data-id="${escapeHTML(o.id??'')}"><span class="global-search-result-icon global-search-result-${o.type}">${sym}</span><span class="global-search-result-copy"><strong>${escapeHTML(o.title||'Registro')}</strong><small>${escapeHTML(o.description||'')}</small></span><span class="global-search-result-kind">${k}</span></button>`;}
  async function runGlobalSearch(term,id){globalSearchResults.hidden=false;globalSearchResults.innerHTML='<div class="global-search-message">Buscando registros...</div>';try{const d=await globalData();if(id!==globalSearchRequest)return;const q=term.toLocaleLowerCase('pt-BR'),out=[];d.clients.filter(x=>searchText([x.name,x.email,x.phone,x.document,x.id]).includes(q)).slice(0,5).forEach(x=>out.push(resultButton({type:'client',id:x.id,action:'client-record',title:x.name||x.email||'Cliente #'+x.id,description:[x.email,x.phone].filter(Boolean).join(' · ')})));d.services.filter(x=>searchText([x.name,x.title,x.description,x.category_name,x.id,x.status]).includes(q)).slice(0,4).forEach(x=>out.push(resultButton({type:'service',id:x.id,page:'services',title:x.name||x.title||'Serviço #'+x.id,description:[x.category_name,x.status,x.description].filter(Boolean).join(' · ')})));d.invoices.filter(x=>searchText([x.client_name,x.description,x.id,x.status]).includes(q)).slice(0,4).forEach(x=>out.push(resultButton({type:'invoice',id:x.id,page:'finance',title:x.client_name||'Fatura #'+x.id,description:[x.description,x.status,x.amount!==undefined?money(x.amount):''].filter(Boolean).join(' · ')})));globalSearchResults.innerHTML=out.length?'<div class="global-search-heading">RESULTADOS ENCONTRADOS</div>'+out.join(''):'<div class="global-search-message">Nenhum resultado para “'+escapeHTML(term)+'”.</div>';}catch{if(id===globalSearchRequest)globalSearchResults.innerHTML='<div class="global-search-message">Não foi possível concluir a busca agora.</div>';}}
  if(globalSearchInput&&globalSearchResults){globalSearchInput.addEventListener('input',()=>{clearTimeout(globalSearchTimer);const q=globalSearchInput.value.trim(),id=++globalSearchRequest;globalSearchInput.setAttribute('aria-expanded','true');if(q.length<2){globalSearchResults.innerHTML='<div class="global-search-message">Digite pelo menos 2 caracteres.</div>';globalSearchResults.hidden=false;return;}globalSearchTimer=setTimeout(()=>runGlobalSearch(q,id),220);});globalSearchInput.addEventListener('focus',()=>{if(globalSearchInput.value.trim().length<2){globalSearchResults.innerHTML='<div class="global-search-message">Busque clientes, serviços e faturas.</div>';globalSearchResults.hidden=false;}});}
  if(globalSearchInput&&globalSearchResults){
    globalSearchInput.addEventListener('keydown',event=>{
      const results=[...globalSearchResults.querySelectorAll('.global-search-result')];
      if(event.key==='Enter' && !globalSearchResults.hidden && results.length){
        event.preventDefault();
        results[0].click();
        return;
      }
      if(event.key==='Escape'){
        closeGlobalSearch();
        return;
      }
      if(!['ArrowDown','ArrowUp'].includes(event.key) || !results.length) return;
      event.preventDefault();
      if(event.key==='ArrowDown') results[0].focus();
      else results[results.length-1].focus();
    });
    globalSearchResults.addEventListener('focusin',event=>{
      const focused=event.target.closest('.global-search-result');
      globalSearchResults.querySelectorAll('.global-search-result').forEach(item=>{
        item.setAttribute('aria-selected',String(item===focused));
      });
    });
    globalSearchResults.addEventListener('keydown',event=>{
      const item=event.target.closest('.global-search-result');
      if(!item) return;
      const results=[...globalSearchResults.querySelectorAll('.global-search-result')];
      const index=results.indexOf(item);
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();
        const next=(index+(event.key==='ArrowDown'?1:-1)+results.length)%results.length;
        results[next].focus();
      } else if(event.key==='Escape'){
        closeGlobalSearch();
        globalSearchInput.focus();
      }
    });
  }
  document.addEventListener('click',e=>{const t=e.target;if(!(t instanceof Element))return;if(globalSearchWrap&&!globalSearchWrap.contains(t))closeGlobalSearch();if(shortcutsMenu&&!shortcutsMenu.contains(t)&&!shortcutsButton?.contains(t))closeShortcuts();});
  shortcutsButton?.addEventListener('click',()=>{const open=shortcutsMenu?.hidden??true;closeGlobalSearch();if(shortcutsMenu)shortcutsMenu.hidden=!open;shortcutsButton.setAttribute('aria-expanded',String(open));});
  alertsButton?.addEventListener('click',async()=>{closeGlobalSearch();closeShortcuts();if(state.user?.role!=='admin'){navigate('finance');return;}await navigate('dashboard');requestAnimationFrame(()=>{const p=$('#alert-center-title')?.closest('.alert-center');if(p){p.scrollIntoView({behavior:'smooth',block:'center'});p.classList.add('alert-center-highlight');setTimeout(()=>p.classList.remove('alert-center-highlight'),1800);}});});
  collapseButton?.addEventListener('click',()=>{const on=document.body.classList.toggle('sidebar-collapsed');collapseButton.setAttribute('aria-pressed',String(on));collapseButton.setAttribute('aria-label',on?'Expandir menu':'Recolher menu');collapseButton.title=on?'Expandir menu':'Recolher menu';const l=collapseButton.querySelector('.collapse-toggle-label');if(l)l.textContent=on?'Expandir menu':'Recolher menu';const i=collapseButton.querySelector('span[aria-hidden="true"]');if(i)i.textContent=on?'›':'‹';try{localStorage.setItem('vortexgrid-sidebar-collapsed',on?'1':'0');}catch{}});
  try{if(localStorage.getItem('vortexgrid-sidebar-collapsed')==='1'){document.body.classList.add('sidebar-collapsed');collapseButton?.setAttribute('aria-pressed','true');collapseButton?.setAttribute('aria-label','Expandir menu');if(collapseButton)collapseButton.title='Expandir menu';const l=collapseButton?.querySelector('.collapse-toggle-label');if(l)l.textContent='Expandir menu';const i=collapseButton?.querySelector('span[aria-hidden="true"]');if(i)i.textContent='›';}}catch{}
  document.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if((e.ctrlKey||e.metaKey)&&k==='k'){e.preventDefault();globalSearchInput?.focus();globalSearchInput?.select();}else if(k==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();globalSearchInput?.focus();}else if(e.key==='Escape'){closeGlobalSearch();closeShortcuts();}});

  // Atualiza a fila automaticamente quando a equipe está na lista de tickets.
  window.setInterval(() => {
    if (state.user && state.page === 'tickets' && !state.currentTicketId) {
      renderTickets().catch(error => notify(error.message, true));
    }
  }, 30000);

  init();
})();
