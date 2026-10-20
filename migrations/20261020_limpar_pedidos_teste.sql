-- VortexGrid Central — limpeza dos pedidos e serviços de teste
-- Execute somente após backup do banco.
-- Preserva: users, clients, services (catálogo), configurações e demais dados sem vínculo com pedidos.
-- Remove: todos os service_orders e contracted_services de teste, detalhes/histórico desses serviços,
-- e faturas/pagamentos/transações do Mercado Pago vinculados aos pedidos removidos.
-- A limpeza não cancela nem estorna pagamentos na conta do Mercado Pago; atua apenas no banco local.
--
-- Antes de executar, confirme que este ambiente ainda não tem vendas reais.
-- O script é transacional; se houver erro antes do COMMIT, execute ROLLBACK na mesma sessão.

START TRANSACTION;

-- Guardar os IDs antes de apagar os pedidos.
CREATE TEMPORARY TABLE tmp_vg_test_order_invoice_ids (
  invoice_id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

INSERT IGNORE INTO tmp_vg_test_order_invoice_ids (invoice_id)
SELECT DISTINCT invoice_id
FROM service_orders
WHERE invoice_id IS NOT NULL;

CREATE TEMPORARY TABLE tmp_vg_test_contracted_service_ids (
  contracted_service_id BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB;

INSERT IGNORE INTO tmp_vg_test_contracted_service_ids (contracted_service_id)
SELECT id FROM contracted_services;

-- Apagar dados auxiliares ligados aos serviços contratados.
DELETE d
FROM contracted_service_details d
INNER JOIN tmp_vg_test_contracted_service_ids t
  ON t.contracted_service_id = d.contracted_service_id;

DELETE h
FROM contracted_service_status_history h
INNER JOIN tmp_vg_test_contracted_service_ids t
  ON t.contracted_service_id = h.contracted_service_id;

-- Apagar registros financeiros locais apenas das faturas associadas a pedidos.
DELETE p
FROM payments p
INNER JOIN tmp_vg_test_order_invoice_ids t ON t.invoice_id = p.invoice_id;

DELETE mt
FROM mercadopago_transactions mt
INNER JOIN tmp_vg_test_order_invoice_ids t ON t.invoice_id = mt.invoice_id;

DELETE mp
FROM mercadopago_checkout_preferences mp
INNER JOIN tmp_vg_test_order_invoice_ids t ON t.invoice_id = mp.invoice_id;

DELETE i
FROM invoices i
INNER JOIN tmp_vg_test_order_invoice_ids t ON t.invoice_id = i.id;

-- Zerar todos os pedidos e serviços contratados de teste.
DELETE FROM service_orders;
DELETE FROM contracted_services;

DROP TEMPORARY TABLE tmp_vg_test_order_invoice_ids;
DROP TEMPORARY TABLE tmp_vg_test_contracted_service_ids;

-- Confira as contagens antes de confirmar. Se estiver correto, execute COMMIT.
-- Se algo inesperado aparecer, execute ROLLBACK em vez de COMMIT.
SELECT
  (SELECT COUNT(*) FROM service_orders) AS pedidos_restantes,
  (SELECT COUNT(*) FROM contracted_services) AS servicos_contratados_restantes;
