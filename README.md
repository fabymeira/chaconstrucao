# Chá de Construção — projeto

## O que já está implementado

- Site responsivo com as fotos fornecidas.
- Meta inicial: R$ 42.759,00.
- Materiais/cotas:
  - Cimento: R$ 35,00 × 100
  - Elétrica: R$ 100,00 × 25
  - Hidráulica: R$ 85,00 × 30
  - Revestimento: R$ 50,00 × 250
  - Laje: R$ 70,00 × 100
  - Ferragem: R$ 45,00 × 100
  - Pintura: R$ 35,00 × 250
- Contribuição livre.
- Banco SQLite local.
- Pedido e controle de quantidade.
- Painel `/admin` protegido por Basic Auth.
- Estrutura para Mercado Pago Checkout Pro / Orders API.
- Webhook com validação HMAC.
- Atualização de arrecadação e cotas após confirmação do pagamento.
- O checkout está configurado para manter Pix (`bank_transfer`) e cartões de crédito/débito, excluindo boleto, saldo/carteira, linha de crédito e pré-pago.

## Como rodar

1. Instale Node.js 20+.
2. Rode `npm install`.
3. Copie `.env.example` para `.env`.
4. Para apenas visualizar: mantenha `DEMO_MODE=true`.
5. Rode `npm start`.
6. Abra `http://localhost:3000`.

## Para ativar Mercado Pago

1. No Mercado Pago, crie/seleciona sua aplicação em "Suas integrações".
2. Obtenha o Access Token de produção e coloque em `MP_ACCESS_TOKEN`.
3. Gere/configure o segredo de Webhooks e coloque em `MP_WEBHOOK_SECRET`.
4. Defina `SITE_URL` como o domínio público HTTPS do site.
5. Configure no Mercado Pago um webhook para Orders na URL:
   `https://SEU-DOMINIO.com.br/api/webhooks/mercadopago`
6. Desative `DEMO_MODE` (`DEMO_MODE=false`).
7. Faça um teste com credenciais/cartões de teste antes de liberar a produção.

Nunca coloque Access Token ou segredo de webhook no HTML/JavaScript público.

## Observação

O projeto usa a API de Orders do Checkout Pro, que a documentação atual do Mercado Pago recomenda para novas integrações. O comprador é redirecionado para o checkout do Mercado Pago e volta ao site após o pagamento. O webhook é a fonte para atualizar o pedido após confirmação.

Para produção, hospede este Node.js em um serviço com HTTPS e armazenamento persistente para o SQLite. Em ambientes sem disco persistente, substitua o SQLite por um banco gerenciado.
