'use strict';

const multer = require('multer');
const path = require('path');

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
        await db.query(`CREATE TABLE IF NOT EXISTS support_ticket_attachments (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          ticket_id BIGINT UNSIGNED NOT NULL,
          uploaded_by_type ENUM('client','staff') NOT NULL,
          uploaded_by_id BIGINT UNSIGNED NULL,
          original_name VARCHAR(180) NOT NULL,
          mime_type VARCHAR(100) NOT NULL,
          size_bytes INT UNSIGNED NOT NULL,
          file_data LONGBLOB NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_support_ticket_attachments_ticket (ticket_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
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
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  const uploadTicketFile = (req, res, next) => upload.single('file')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return erro(res, 413, 'O anexo deve ter no máximo 5 MB.');
    return erro(res, 400, 'Não foi possível receber o anexo. Envie um PDF, PNG, JPG ou TXT de até 5 MB.');
  });
  function validateTicketFile(file) {
    if (!file || !Buffer.isBuffer(file.buffer)) return false;
    const ext = path.extname(file.originalname || '').toLowerCase();
    const b = file.buffer;
    if (ext === '.pdf' && file.mimetype === 'application/pdf') return b.length >= 5 && b.subarray(0,5).toString() === '%PDF-';
    if (ext === '.png' && file.mimetype === 'image/png') return b.length >= 8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if ((ext === '.jpg' || ext === '.jpeg') && file.mimetype === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (ext === '.txt' && file.mimetype === 'text/plain') return !b.includes(0);
    return false;
  }

  app.get('/api/tickets', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const filters = [];
      const params = [];
      if (statuses.includes(req.query.status)) {
        filters.push('t.status = ?');
        params.push(req.query.status);
      }
      if (priorities.includes(req.query.priority)) {
        filters.push('t.priority = ?');
        params.push(req.query.priority);
      }
      if (req.query.assigned_to === 'unassigned') {
        filters.push('t.assigned_to IS NULL');
      } else if (req.query.assigned_to) {
        const assignedTo = validarId(req.query.assigned_to);
        if (assignedTo) {
          filters.push('t.assigned_to = ?');
          params.push(assignedTo);
        }
      }
      const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
      const [rows] = await db.query(`
        SELECT t.id,t.client_id,t.contracted_service_id,t.subject,t.category,t.priority,t.status,t.assigned_to,
          t.created_at,t.updated_at,t.last_message_at,c.name AS client_name,c.email AS client_email,
          cs.name AS service_name,u.name AS assignee_name,
          (SELECT COUNT(*) FROM support_ticket_messages m WHERE m.ticket_id=t.id) AS message_count,
          (SELECT m.sender_type FROM support_ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_sender_type
        FROM support_tickets t
        LEFT JOIN clients c ON c.id=t.client_id
        LEFT JOIN contracted_services cs ON cs.id=t.contracted_service_id
        LEFT JOIN users u ON u.id=t.assigned_to
        ${where}
        ORDER BY FIELD(t.priority,'urgent','high','normal','low'),FIELD(t.status,'open','in_progress','waiting_customer','resolved','closed'),t.last_message_at DESC
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
      const [attachments] = await db.query('SELECT id,original_name,mime_type,size_bytes,uploaded_by_type,created_at FROM support_ticket_attachments WHERE ticket_id=? ORDER BY created_at ASC,id ASC', [id]);
      return res.json({ ticket: rows[0], messages, attachments });
    } catch (error) {
      console.error('Erro ao abrir ticket:', error.code || error.message);
      return erro(res, 500, 'Não foi possível abrir o ticket.');
    }
  });

  app.post('/api/tickets/:id/attachments', autenticado, uploadTicketFile, async (req, res) => {
    try {
      await ensureSchema();
      const id = validarId(req.params.id);
      if (!id || !validateTicketFile(req.file)) return erro(res, 400, 'Anexo inválido. Formatos aceitos: PDF, PNG, JPG e TXT.');
      const [tickets] = await db.query('SELECT id,status FROM support_tickets WHERE id=? LIMIT 1', [id]);
      if (!tickets.length) return erro(res, 404, 'Ticket não encontrado.');
      if (tickets[0].status === 'closed') return erro(res, 409, 'Não é possível anexar arquivos a um ticket encerrado.');
      const file = req.file;
      const originalName = path.basename(file.originalname).replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0,180) || 'anexo';
      const [result] = await db.query(
        'INSERT INTO support_ticket_attachments(ticket_id,uploaded_by_type,uploaded_by_id,original_name,mime_type,size_bytes,file_data) VALUES(?,?,?,?,?,?,?)',
        [id,'staff',req.session.user.id,originalName,file.mimetype,file.size,file.buffer]
      );
      await db.query('UPDATE support_tickets SET last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?', [id]);
      return res.status(201).json({ id: result.insertId, mensagem: 'Anexo enviado.' });
    } catch (error) {
      console.error('Erro ao anexar arquivo ao ticket:', error.code || error.message);
      return erro(res, 500, 'Não foi possível salvar o anexo.');
    }
  });

  app.get('/api/tickets/:id/attachments/:attachmentId', autenticado, async (req, res) => {
    try {
      await ensureSchema();
      const id = validarId(req.params.id);
      const attachmentId = validarId(req.params.attachmentId);
      if (!id || !attachmentId) return erro(res, 400, 'Identificador de anexo inválido.');
      const [rows] = await db.query('SELECT original_name,mime_type,file_data FROM support_ticket_attachments WHERE id=? AND ticket_id=? LIMIT 1', [attachmentId,id]);
      if (!rows.length) return erro(res, 404, 'Anexo não encontrado.');
      const name = rows[0].original_name.replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0,180) || 'anexo';
      res.setHeader('Content-Type', rows[0].mime_type);
      res.setHeader('Content-Disposition', 'attachment; filename="attachment"; filename*=UTF-8\'\'' + encodeURIComponent(name));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(rows[0].file_data);
    } catch (error) {
      console.error('Erro ao baixar anexo do ticket:', error.code || error.message);
      return erro(res, 500, 'Não foi possível baixar o anexo.');
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
        await connection.query("UPDATE support_tickets SET status='waiting_customer',last_message_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
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

  app.get('/api/ticket-staff', autenticado, async (req, res) => {
    try {
      const [rows] = await db.query(
        "SELECT id,name,role FROM users WHERE active=1 AND role IN ('admin','staff') ORDER BY name ASC"
      );
      return res.json(rows);
    } catch (error) {
      console.error('Erro ao listar responsáveis dos tickets:', error.code || error.message);
      return erro(res, 500, 'Não foi possível carregar a equipe de atendimento.');
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
