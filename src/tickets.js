'use strict';

module.exports = function registerTickets(app, { db, autenticado, validarId, erro }) {
  let schemaPromise;
  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.query(`CREATE TABLE IF NOT EXISTS support_tickets (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          client_id BIGINT UNSIGNED NOT NULL,
          contracted_service_id BIGINT UNSIGNED NULL,
          subject VARCHAR(180) NOT NULL,
          category VARCHAR(60) NOT NULL DEFAULT 'general',
          priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
          status ENUM('open','in_progress','waiting_customer','resolved','closed') NOT NULL DEFAULT 'open',
          assigned_to BIGINT UNSIGNED NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          last_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_support_tickets_client (client_id, updated_at),
          KEY idx_support_tickets_status (status, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        try {
          const [columns] = await db.query("SHOW COLUMNS FROM support_tickets LIKE 'contracted_service_id'");
          if (!columns.length) {
            try {
              await db.query('ALTER TABLE support_tickets ADD COLUMN contracted_service_id BIGINT UNSIGNED NULL AFTER client_id');
            } catch (error) {
              if (error.code !== 'ER_DUP_FIELDNAME') throw error;
            }
          }
        } catch (error) {
          throw error;
        }
        await db.query(`CREATE TABLE IF NOT EXISTS support_ticket_messages (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          ticket_id BIGINT UNSIGNED NOT NULL,
          sender_type ENUM('client','staff','system') NOT NULL,
          sender_id BIGINT UNSIGNED NULL,
          sender_name VARCHAR(160) NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_support_ticket_messages_ticket (ticket_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      })().catch(error => { schemaPromise = null; throw error; });
    }
    await schemaPromise;
  }
  const statuses = ['open','in_progress','waiting_customer','resolved','closed'];
  const priorities = ['low','normal','high','urgent'];
  const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

  app.get('/api/tickets', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const status = statuses.includes(req.query.status) ? req.query.status : null;
      const params = [];
      const where = status ? 'WHERE t.status = ?' : '';
      if (status) params.push(status);
      const [rows] = await db.query(`
        SELECT t.id,t.client_id,t.contracted_service_id,t.subject,t.category,t.priority,t.status,t.assigned_to,
          t.created_at,t.updated_at,t.last_message_at,c.name AS client_name,c.email AS client_email,
          cs.name AS service_name,u.name AS assignee_name,
          (SELECT COUNT(*) FROM support_ticket_messages m WHERE m.ticket_id=t.id) AS message_count
        FROM support_tickets t
        LEFT JOIN clients c ON c.id=t.client_id
        LEFT JOIN contracted_services cs ON cs.id=t.contracted_service_id
        LEFT JOIN users u ON u.id=t.assigned_to
        ${where}
        ORDER BY FIELD(t.status,'open','in_progress','waiting_customer','resolved','closed'),t.last_message_at DESC
        LIMIT 500
      `, params);
      return res.json(rows);
    } catch (error) {
      console.error('Erro ao listar tickets:', error.code || error.message);
      return erro(res, 500, 'Não foi possível carregar os tickets.');
    }
  });

  app.get('/api/tickets/:id', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const id = validarId(req.params.id);
      if (!id) return erro(res, 400, 'Ticket inválido.');
      const [rows] = await db.query(`
        SELECT t.*,c.name AS client_name,c.email AS client_email,c.phone AS client_phone,cs.name AS service_name,u.name AS assignee_name
        FROM support_tickets t
        LEFT JOIN clients c ON c.id=t.client_id
        LEFT JOIN contracted_services cs ON cs.id=t.contracted_service_id
        LEFT JOIN users u ON u.id=t.assigned_to
        WHERE t.id=? LIMIT 1
      `, [id]);
      if (!rows.length) return erro(res, 404, 'Ticket não encontrado.');
      const [messages] = await db.query('SELECT id,sender_type,sender_id,sender_name,message,created_at FROM support_ticket_messages WHERE ticket_id=? ORDER BY created_at ASC,id ASC', [id]);
      return res.json({ ticket: rows[0], messages });
    } catch (error) {
      console.error('Erro ao abrir ticket:', error.code || error.message);
      return erro(res, 500, 'Não foi possível abrir o ticket.');
    }
  });

  app.post('/api/tickets/:id/messages', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const id = validarId(req.params.id);
      const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
      if (!id || !validText(message, 5000)) return erro(res, 400, 'Escreva uma mensagem de até 5.000 caracteres.');
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [tickets] = await connection.query('SELECT id,status FROM support_tickets WHERE id=? LIMIT 1 FOR UPDATE', [id]);
        if (!tickets.length) {
          await connection.rollback();
          return erro(res, 404, 'Ticket não encontrado.');
        }
        if (tickets[0].status === 'closed') {
          await connection.rollback();
          return erro(res, 409, 'Este ticket está encerrado.');
        }
        const user = req.session.user;
        await connection.query("INSERT INTO support_ticket_messages(ticket_id,sender_type,sender_id,sender_name,message) VALUES(?,'staff',?,?,?)",
          [id, user.id, String(user.name || 'Equipe VortexGrid').slice(0,160), message]);
        await connection.query("UPDATE support_tickets SET status='in_progress',last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
        await connection.commit();
      } catch (transactionError) {
        await connection.rollback();
        throw transactionError;
      } finally {
        connection.release();
      }
      return res.status(201).json({ mensagem: 'Resposta enviada.' });
    } catch (error) {
      console.error('Erro ao responder ticket:', error.code || error.message);
      return erro(res, 500, 'Não foi possível enviar a resposta.');
    }
  });

  app.patch('/api/tickets/:id', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const id = validarId(req.params.id);
      const body = req.body || {};
      if (!id || (body.status !== undefined && !statuses.includes(body.status)) ||
          (body.priority !== undefined && !priorities.includes(body.priority))) {
        return erro(res, 400, 'Status, prioridade ou ticket inválido.');
      }
      const [exists] = await db.query('SELECT id FROM support_tickets WHERE id=? LIMIT 1', [id]);
      if (!exists.length) return erro(res, 404, 'Ticket não encontrado.');
      const sets = [];
      const params = [];
      if (body.status !== undefined) { sets.push('status=?'); params.push(body.status); }
      if (body.priority !== undefined) { sets.push('priority=?'); params.push(body.priority); }
      if (body.assigned_to !== undefined) {
        const assigned = body.assigned_to === null || body.assigned_to === '' ? null : validarId(body.assigned_to);
        if (body.assigned_to && !assigned) return erro(res, 400, 'Responsável inválido.');
        if (assigned) {
          const [users] = await db.query("SELECT id FROM users WHERE id=? AND active=1 AND role IN ('admin','staff') LIMIT 1", [assigned]);
          if (!users.length) return erro(res, 400, 'Responsável não encontrado ou inativo.');
        }
        sets.push('assigned_to=?'); params.push(assigned);
      }
      if (sets.length) {
        sets.push('updated_at=CURRENT_TIMESTAMP');
        params.push(id);
        await db.query(`UPDATE support_tickets SET ${sets.join(',')} WHERE id=?`, params);
      }
      return res.json({ mensagem: 'Ticket atualizado.' });
    } catch (error) {
      console.error('Erro ao atualizar ticket:', error.code || error.message);
      return erro(res, 500, 'Não foi possível atualizar o ticket.');
    }
  });

  app.get('/api/ticket-stats', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const [rows] = await db.query("SELECT status,COUNT(*) AS total FROM support_tickets GROUP BY status");
      const stats = { open: 0, in_progress: 0, waiting_customer: 0, resolved: 0, closed: 0 };
      rows.forEach(row => { stats[row.status] = Number(row.total) || 0; });
      return res.json(stats);
    } catch (error) {
      console.error('Erro ao contar tickets:', error.code || error.message);
      return erro(res, 500, 'Não foi possível carregar os indicadores de tickets.');
    }
  });
};
