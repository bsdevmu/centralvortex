-- VortexGrid Central: estado operacional interno de serviços contratados
-- Aplicar manualmente somente após backup e validação do esquema.
-- Não altera invoices.status, payments ou contracted_services.status.

ALTER TABLE contracted_services
  ADD COLUMN operational_status VARCHAR(40) NOT NULL DEFAULT 'awaiting_payment';

UPDATE contracted_services
SET operational_status = CASE status
  WHEN 'active' THEN 'active'
  WHEN 'provisioning' THEN 'activating'
  WHEN 'suspended' THEN 'suspended'
  WHEN 'cancelled' THEN 'cancelled'
  ELSE 'awaiting_payment'
END;

CREATE TABLE IF NOT EXISTS contracted_service_status_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contracted_service_id BIGINT UNSIGNED NOT NULL,
  previous_status VARCHAR(40) NOT NULL,
  new_status VARCHAR(40) NOT NULL,
  note VARCHAR(2000) NOT NULL,
  changed_by BIGINT UNSIGNED DEFAULT NULL,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cssh_service (contracted_service_id, id),
  KEY idx_cssh_changed_by (changed_by),
  KEY idx_cssh_changed_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
