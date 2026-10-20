-- VortexGrid Central — mapeamento do esquema antes de limpar dados de teste
-- Somente leitura: não altera nem apaga registros.
-- Execute no banco bsdevfnk_vortexgrid pelo phpMyAdmin.
-- Envie/exporte os resultados das 3 consultas para confirmar as tabelas e relacionamentos reais.

-- 1) Todas as tabelas e estimativa de registros.
-- TABLE_ROWS é estimativa em InnoDB; serve para mapa inicial, não contagem exata.
SELECT
  t.TABLE_NAME AS tabela,
  t.TABLE_TYPE AS tipo,
  t.ENGINE AS mecanismo,
  t.TABLE_ROWS AS registros_estimados
FROM information_schema.TABLES t
WHERE t.TABLE_SCHEMA = DATABASE()
ORDER BY t.TABLE_NAME;

-- 2) Colunas das tabelas comerciais, de conta e pagamento.
SELECT
  c.TABLE_NAME AS tabela,
  c.ORDINAL_POSITION AS posicao,
  c.COLUMN_NAME AS coluna,
  c.COLUMN_TYPE AS tipo,
  c.IS_NULLABLE AS aceita_nulo,
  c.COLUMN_KEY AS chave,
  c.EXTRA AS extra
FROM information_schema.COLUMNS c
WHERE c.TABLE_SCHEMA = DATABASE()
  AND c.TABLE_NAME IN (
    'users', 'clients', 'services', 'service_categories', 'supplier_products',
    'service_orders', 'contracted_services', 'contracted_service_details',
    'contracted_service_status_history', 'invoices', 'payments',
    'mercadopago_transactions', 'mercadopago_checkout_preferences'
  )
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;

-- 3) Relacionamentos de chave estrangeira entre tabelas.
SELECT
  k.TABLE_NAME AS tabela_filha,
  k.COLUMN_NAME AS coluna_filha,
  k.REFERENCED_TABLE_NAME AS tabela_pai,
  k.REFERENCED_COLUMN_NAME AS coluna_pai,
  rc.DELETE_RULE AS regra_ao_excluir
FROM information_schema.KEY_COLUMN_USAGE k
LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
 AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
 AND rc.TABLE_NAME = k.TABLE_NAME
WHERE k.CONSTRAINT_SCHEMA = DATABASE()
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION;

-- 4) Contagens exatas nas tabelas conhecidas (só leitura).
SELECT 'users' AS tabela, COUNT(*) AS registros FROM users
UNION ALL SELECT 'clients', COUNT(*) FROM clients
UNION ALL SELECT 'services', COUNT(*) FROM services
UNION ALL SELECT 'service_categories', COUNT(*) FROM service_categories
UNION ALL SELECT 'supplier_products', COUNT(*) FROM supplier_products
UNION ALL SELECT 'service_orders', COUNT(*) FROM service_orders
UNION ALL SELECT 'contracted_services', COUNT(*) FROM contracted_services
UNION ALL SELECT 'contracted_service_details', COUNT(*) FROM contracted_service_details
UNION ALL SELECT 'contracted_service_status_history', COUNT(*) FROM contracted_service_status_history
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'payments', COUNT(*) FROM payments
UNION ALL SELECT 'mercadopago_transactions', COUNT(*) FROM mercadopago_transactions
UNION ALL SELECT 'mercadopago_checkout_preferences', COUNT(*) FROM mercadopago_checkout_preferences
ORDER BY tabela;
