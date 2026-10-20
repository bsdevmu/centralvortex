-- VortexGrid: fluxo operacional de orçamentos aceitos
-- Execute uma única vez no banco bsdevfnk_vortexgrid antes de publicar os arquivos.
-- A coluna é separada de quote_requests.status para preservar "accepted"/"declined"
-- que o portal do cliente já utiliza.
ALTER TABLE quote_requests
  ADD COLUMN workflow_status ENUM(
    'awaiting_contracting',
    'in_contracting',
    'ready_for_billing'
  ) NULL DEFAULT NULL AFTER status;

-- Compatibilidade com orçamentos que já haviam sido aceitos antes desta atualização.
UPDATE quote_requests
SET workflow_status = 'awaiting_contracting'
WHERE status = 'accepted' AND workflow_status IS NULL;