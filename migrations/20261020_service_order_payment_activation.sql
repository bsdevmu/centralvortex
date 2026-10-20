-- VortexGrid Central: vincular solicitação, fatura e serviço contratado.
-- Aplicar manualmente após backup e antes de publicar o código atualizado.
-- Não altera status de faturas, pagamentos ou serviços existentes.

ALTER TABLE service_orders
  ADD COLUMN invoice_id INT(10) UNSIGNED DEFAULT NULL AFTER service_id,
  ADD COLUMN contracted_service_id INT(10) UNSIGNED DEFAULT NULL AFTER invoice_id,
  ADD KEY idx_service_orders_invoice_id (invoice_id),
  ADD KEY idx_service_orders_contracted_service_id (contracted_service_id);
