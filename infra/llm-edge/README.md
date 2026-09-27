# llm-edge — llm.trainedassist.store

Public OpenAI-compatible address for the free-ladder gateway (`src/llm-gateway.js`, issue #1526).
Stateless proxy `/v1/*` → `ORIGIN/v1/*`; auth = the gateway bearer token (`agent-tokens/llm-gateway/token`).

opencode provider: `baseURL = https://llm.trainedassist.store/v1`, model `free-ladder`.

Deploy (CF account typeformowner):

    export CLOUDFLARE_ACCOUNT_ID=d740a05e9442c1d0feacae2dfc673e93
    npx wrangler deploy
