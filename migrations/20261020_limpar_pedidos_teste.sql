-- VortexGrid Central — zerar dados comerciais de teste antes do início das vendas
-- PRESERVA: users (contas administrativas/login), clients (contas de clientes),
-- services (catálogo da loja) e configurações.
-- REMOVE: TODOS os pedidos, TODOS os serviços contratados (inclusive ativos/confirmados),
-- detalhes/históricos operacionais, faturas e registros locais de pagamento/checkout.
-- Não cancela nem estorna pagamentos na conta externa do Mercado Pago.
--
-- ATENÇÃO: faça backup antes de executar. Use somente se confirmar que não existem
-- vendas reais neste banco. Confira o esquema das tabelas no ambiente antes da execução.
-- Este script não deve ser executado parcialmente. Em caso de erro, não confirme a transação.

START TRANSACTION;

-- Dados auxiliares de serviços contratados.
DELETE FROM contracted_service_details;
DELETE FROM contracted_service_status_history;

-- Como a loja ainda não iniciou vendas reais, limpar todo o financeiro local de teste.
DELETE FROM payments;
DELETE FROM mercadopago_transactions;
DELETE FROM mercadopago_checkout_preferences;
DELETE FROM invoices;

-- Zerar todos os pedidos e serviços contratados, sem filtrar por status.
-- Isso inclui pedidos confirmados/pagos e serviços ativos.
DELETE FROM service_orders;
DELETE FROM contracted_services;

-- Verificação antes de confirmar: os resultados devem ser todos zero.
SELECT
  (SELECT COUNT(*) FROM service_orders) AS pedidos_restantes,
  (SELECT COUNT(*) FROM contracted_services) AS servicos_contratados_restantes,
  (SELECT COUNT(*) FROM invoices) AS faturas_restantes,
  (SELECT COUNT(*) FROM payments) AS pagamentos_restantes,
  (SELECT COUNT(*) FROM mercadopago_transactions) AS transacoes_mp_restantes,
  (SELECT COUNT(*) FROM mercadopago_checkout_preferences) AS preferencias_checkout_restantes;

-- Execute COMMIT somente depois de verificar que todas as contagens estão zeradas.
-- Se houver qualquer erro ou resultado inesperado, execute ROLLBACK na mesma sessão.
-- COMMIT;
-- ROLLBACK;
