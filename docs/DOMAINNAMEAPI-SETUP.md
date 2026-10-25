# DomainNameAPI — integração isolada para testes

Esta integração adiciona uma rota de consulta de disponibilidade separada da integração ResellerClub já existente.

## Rota

`GET /api/domains/dna/availability?domain=exemplo.com.br`

A rota não registra, renova, transfere nem cobra por domínios. Não substitui `/api/domains/availability`.

## Variáveis de ambiente

Configure apenas no ambiente do servidor, nunca no repositório:

- `DOMAINNAMEAPI_RESELLER_ID`: ID do revendedor.
- `DOMAINNAMEAPI_API_KEY`: chave de API do ambiente de teste.
- `DOMAINNAMEAPI_TEST_MODE=true`: mantém o SDK no ambiente de teste.
- `DOMAIN_SEARCH_ALLOWED_ORIGINS`: origens autorizadas, separadas por vírgula (opcional).

Use a chave de teste até a validação estar concluída. Não configure a chave de produção nem altere `DOMAINNAMEAPI_TEST_MODE` para `false` sem autorização e revisão explícitas.

## Validação antes de implantar

1. Instale as dependências com `npm install` no ambiente de desenvolvimento.
2. Execute verificações sintáticas e testes locais.
3. Configure as variáveis de ambiente de teste na hospedagem de homologação.
4. Teste a rota com um domínio de exemplo e confirme a resposta do provedor.
5. Revise o comportamento do SDK e o formato real de resposta antes de usar a integração em produção.

## Importante

Esta alteração está em uma branch de trabalho. Não está implantada em produção e não foi validada com credenciais reais da DomainNameAPI. A disponibilidade e o preço devem ser reconfirmados antes de qualquer pedido.
