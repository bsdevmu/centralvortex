# Webhook do Mercado Pago

Esta branch adiciona confirmação de pagamento no servidor da Central, sem alterar o checkout existente do Portal.

## Variáveis de ambiente

Configure na Central, pelo painel seguro da hospedagem:

- `MP_ACCESS_TOKEN`: token de acesso do Mercado Pago usado para consultar o pagamento na API.
- `MP_WEBHOOK_SECRET`: chave secreta de assinatura do webhook configurada no Mercado Pago.

Não coloque esses valores no GitHub nem em mensagens. Se alguma variável estiver ausente, o endpoint responde com erro e não marca a fatura como paga.

## Endpoint

`POST /api/webhooks/mercadopago`

O Portal já envia notificações para esse endereço. O handler:

1. valida `x-signature` e `x-request-id`;
2. consulta o pagamento diretamente na API do Mercado Pago;
3. exige status `approved`, moeda `BRL`, referência de fatura e valor compatíveis;
4. registra o pagamento e atualiza a fatura e os pedidos relacionados em uma transação;
5. trata notificações repetidas sem inserir um segundo pagamento.

O retorno de sucesso no navegador não é usado como prova de pagamento.

## Antes de publicar

- Confirmar que Portal e Central usam o mesmo banco e que a tabela `mercadopago_checkout_preferences` é criada pelo checkout.
- Configurar as duas variáveis de ambiente na Central.
- Testar em ambiente de homologação com pagamento aprovado, pendente, recusado, assinatura inválida e notificação repetida.
- Conferir a estrutura real da tabela `payments` e os estados permitidos de `service_orders.payment_status`.
- Não mesclar nem publicar sem revisão e autorização.
