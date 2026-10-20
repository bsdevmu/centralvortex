-- VortexGrid: vincula o orçamento aceito à fatura criada ao liberar o faturamento.
-- Execute uma única vez no banco bsdevfnk_vortexgrid.
ALTER TABLE quote_requests
  ADD COLUMN invoice_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER workflow_status,
  ADD KEY idx_quote_requests_invoice (invoice_id);
