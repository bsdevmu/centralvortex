'use strict';

const express = require('express');

function criarRotasDominios({ db, autenticado, somenteAdmin }) {
  const router = express.Router();
  const estados = ['awaiting_payment', 'awaiting_registration', 'registered', 'registration_failed', 'cancelled'];

  async function prepararTabela() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS domain_orders (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        client_id BIGINT UNSIGNED NOT NULL,
        domain_name VARCHAR(253) NOT NULL,
        registrar VARCHAR(40) NOT NULL DEFAULT 'manual',
        status VARCHAR(32) NOT NULL DEFAULT 'awaiting_payment',
        sale_price DECIMAL(12,2) NOT NULL,
        provider_cost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        invoice_id BIGINT UNSIGNED NULL,
        payment_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        registrant_data JSON NULL,
        provider_reference VARCHAR(190) NULL,
        failure_reason TEXT NULL,
        internal_notes TEXT NULL,
        created_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        registered_at DATETIME NULL,
        INDEX idx_domain_orders_client (client_id),
        INDEX idx_domain_orders_status (status),
        INDEX idx_domain_orders_invoice (invoice_id),
        INDEX idx_domain_orders_domain (domain_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  router.get('/api/domains/orders', autenticado, somenteAdmin, async (req, res) => {
    try {
      await prepararTabela();
      const [rows] = await db.query(`
        SELECT d.*, c.name AS client_name, c.email AS client_email
        FROM domain_orders d
        LEFT JOIN clients c ON c.id = d.client_id
        ORDER BY d.created_at DESC LIMIT 500
      `);
      res.json({ orders: rows, statuses: estados });
    } catch (error) {
      console.error('Erro ao listar pedidos de domínio:', error.code || error.message);
      res.status(500).json({ erro: 'Não foi possível carregar os pedidos de domínio.' });
    }
  });

  router.post('/api/domains/orders', autenticado, somenteAdmin, async (req, res) => {
    try {
      await prepararTabela();
      const body = req.body || {};
      const clientId = Number(body.client_id);
      const domain = String(body.domain_name || '').trim().toLowerCase().replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
      const salePrice = Number(body.sale_price);
      const providerCost = Number(body.provider_cost || 0);
      if (!Number.isSafeInteger(clientId) || clientId < 1) return res.status(400).json({ erro: 'Selecione um cliente válido.' });
      if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$/.test(domain)) return res.status(400).json({ erro: 'Informe um domínio válido, como exemplo.com.br.' });
      if (!Number.isFinite(salePrice) || salePrice < 0 || !Number.isFinite(providerCost) || providerCost < 0) return res.status(400).json({ erro: 'Informe valores válidos para venda e custo.' });
      const [clients] = await db.query('SELECT id FROM clients WHERE id = ? LIMIT 1', [clientId]);
      if (!clients.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
      const [result] = await db.query(`
        INSERT INTO domain_orders
          (client_id, domain_name, status, sale_price, provider_cost, payment_status, registrant_data, internal_notes, created_by)
        VALUES (?, ?, 'awaiting_payment', ?, ?, 'pending', ?, ?, ?)
      `, [clientId, domain, salePrice.toFixed(2), providerCost.toFixed(2), JSON.stringify(body.registrant_data || {}), String(body.internal_notes || '').slice(0, 5000) || null, req.session.user.id]);
      res.status(201).json({ id: result.insertId, message: 'Pedido de domínio criado.' });
    } catch (error) {
      console.error('Erro ao criar pedido de domínio:', error.code || error.message);
      res.status(500).json({ erro: 'Não foi possível criar o pedido de domínio.' });
    }
  });

  router.patch('/api/domains/orders/:id', autenticado, somenteAdmin, async (req, res) => {
    try {
      await prepararTabela();
      const id = Number(req.params.id);
      const body = req.body || {};
      if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ erro: 'Pedido inválido.' });
      const [found] = await db.query('SELECT id, status FROM domain_orders WHERE id = ? LIMIT 1', [id]);
      if (!found.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
      const updates = [];
      const values = [];
      if (body.status !== undefined) {
        if (!estados.includes(body.status)) return res.status(400).json({ erro: 'Status inválido.' });
        updates.push('status = ?'); values.push(body.status);
        if (body.status === 'registered') updates.push('registered_at = COALESCE(registered_at, NOW())');
      }
      if (body.payment_status !== undefined) {
        if (!['pending', 'paid', 'refunded', 'review'].includes(body.payment_status)) return res.status(400).json({ erro: 'Situação de pagamento inválida.' });
        updates.push('payment_status = ?'); values.push(body.payment_status);
        if (body.payment_status === 'paid') {
          updates.push("status = IF(status = 'awaiting_payment', 'awaiting_registration', status)");
        }
      }
      if (body.provider_cost !== undefined) {
        const cost = Number(body.provider_cost);
        if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ erro: 'Custo inválido.' });
        updates.push('provider_cost = ?'); values.push(cost.toFixed(2));
      }
      for (const field of ['provider_reference', 'failure_reason', 'internal_notes']) {
        if (body[field] !== undefined) { updates.push(field + ' = ?'); values.push(String(body[field] || '').slice(0, field === 'failure_reason' || field === 'internal_notes' ? 5000 : 190) || null); }
      }
      if (!updates.length) return res.status(400).json({ erro: 'Nenhuma alteração informada.' });
      values.push(id);
      await db.query('UPDATE domain_orders SET ' + updates.join(', ') + ' WHERE id = ?', values);
      res.json({ message: 'Pedido atualizado.' });
    } catch (error) {
      console.error('Erro ao atualizar pedido de domínio:', error.code || error.message);
      res.status(500).json({ erro: 'Não foi possível atualizar o pedido.' });
    }
  });

  router.get('/api/domains/health', autenticado, somenteAdmin, async (_req, res) => {
    try {
      await prepararTabela();
      res.json({ ok: true, mode: process.env.DOMAIN_REGISTRATION_MODE || 'manual', realRegistrationEnabled: false });
    } catch (error) {
      console.error('Erro ao verificar módulo de domínios:', error.code || error.message);
      res.status(500).json({ ok: false, erro: 'Tabela do módulo de domínios indisponível.' });
    }
  });

  return router;
}

module.exports = criarRotasDominios;
