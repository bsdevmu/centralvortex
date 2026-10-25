# Integração de domínios ResellerClub — configuração

## O que esta versão entrega

- Endpoint público de consulta de disponibilidade: `GET /api/domains/availability?domain=exemplo.com.br`.
- Validação básica do domínio, limite simples de 25 consultas por IP por minuto e CORS restrito ao site VortexGrid.
- A chave da ResellerClub fica exclusivamente no ambiente do servidor.
- A página de hospedagem permite consultar um domínio e encaminha a escolha (já tenho / quero registrar / decidirei depois) para a Área do Cliente.
- A solicitação de registro ainda **não registra nem cobra o domínio automaticamente**. A equipe deve confirmar preço, disponibilidade final, dados de contato e saldo da conta antes de registrar.

## Variáveis de ambiente na Central

Configure-as no painel de ambiente da hospedagem da Central ou no arquivo `.env` mantido fora do Git:

```dotenv
RESELLERCLUB_RESELLER_ID=SEU_RESELLER_ID
RESELLERCLUB_API_KEY=SUA_CHAVE_API
DOMAIN_SEARCH_ALLOWED_ORIGINS=https://www.vortexgrid.com.br,https://vortexgrid.com.br
```

Não coloque os valores reais no repositório, em commits, no JavaScript do navegador ou no chat. Se a chave já foi exposta, gere uma nova no painel da ResellerClub e atualize somente o ambiente do servidor.

## IP autorizado na ResellerClub

A API HTTP legada exige que o IP público de saída do servidor que faz as requisições esteja na lista de permissões da conta. Adicione o IP de saída do servidor da Central em **Settings → API → Whitelist your IP Addresses**. Não use o IP do computador do cliente. Não adicione um IP até confirmar o IP público de saída da hospedagem da Central.

Guia oficial da ResellerClub: https://cp.resellerclub.com/kb/answer/753

## Endpoint

```http
GET https://central.vortexgrid.com.br/api/domains/availability?domain=exemplo.com.br
Accept: application/json
```

Resposta de sucesso:

```json
{
  "domain": "exemplo.com.br",
  "status": "available",
  "available": true,
  "message": "O domínio parece estar disponível para registro. A disponibilidade será confirmada novamente no pedido."
}
```

Os status possíveis são `available`, `registered`, `unavailable` e `unknown`. `unknown` não deve ser tratado como domínio disponível.

## Publicação manual

1. Atualize `src/server.js` na Central.
2. Configure as variáveis de ambiente sem colocá-las no Git.
3. Confirme o IP público de saída da Central e adicione-o à lista de permissões da ResellerClub.
4. Reinicie o processo Node.js da Central.
5. Atualize `hospedagem.html` no site principal.
6. Atualize `public/app.js` e `src/server.js` na Área do Cliente.
7. Teste uma consulta de domínio disponível, uma indisponível, domínio inválido e o comportamento quando as credenciais não estiverem configuradas.

## Limitações desta etapa

- Não existe registro automático, transferência, renovação, checkout do domínio ou sincronização do domínio no cadastro de serviços nesta versão.
- A consulta da API depende de credenciais válidas, IP autorizado e disponibilidade da API da ResellerClub.
- O preço final e o estado do domínio precisam ser consultados novamente antes de qualquer operação paga.
- O limite de requisições em memória reinicia quando o processo Node reinicia; para uso público com maior volume, migrar o limite para armazenamento compartilhado.
