-- VortexGrid: modalidade de preço e fluxo de orçamentos personalizados.
-- Faça backup do banco antes de executar esta migração.
-- Produtos nas categorias Empresas, Sistemas e Gestão Comercial/SmartPOS passam
-- a solicitar orçamento; os demais mantêm contratação direta por preço fixo.

ALTER TABLE services
  ADD COLUMN pricing_mode ENUM('fixed', 'quote') NOT NULL DEFAULT 'fixed' AFTER price;

UPDATE services s
LEFT JOIN service_categories c ON c.id = s.category_id
LEFT JOIN service_categories p ON p.id = c.parent_id
SET s.pricing_mode = CASE
  WHEN LOWER(CONCAT_WS(' ', s.category, c.name, p.name))
       REGEXP 'empresas|sistemas|gestão comercial|gestao comercial|smartpos'
    THEN 'quote'
  ELSE 'fixed'
END;

CREATE TABLE IF NOT EXISTS quote_requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id INT UNSIGNED NOT NULL,
  service_id INT UNSIGNED NOT NULL,
  customer_notes TEXT DEFAULT NULL,
  status ENUM('requested', 'proposed', 'accepted', 'declined', 'cancelled') NOT NULL DEFAULT 'requested',
  proposed_amount DECIMAL(12,2) DEFAULT NULL,
  billing_cycle ENUM('one_time', 'monthly', 'yearly') DEFAULT NULL,
  proposal_notes TEXT DEFAULT NULL,
  valid_until DATE DEFAULT NULL,
  responded_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_quote_requests_client (client_id, created_at),
  KEY idx_quote_requests_service (service_id),
  KEY idx_quote_requests_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
