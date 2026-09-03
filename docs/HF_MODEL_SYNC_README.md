# HuggingFace Model Sync — Integration Guide

Describes how ENZO fetches, catalogs, and routes HuggingFace free serverless models.

---

## How Model Sync Works

The `fetchHuggingFaceModels()` function in `model-sync.ts` queries the HuggingFace Hub API to retrieve only models that are:

1. **Instruct / chat-tuned** — tagged `conversational`, so they support the `/v1/chat/completions` request format
2. **Warm on the free shared cluster** — filtered by `inference=warm`, meaning they're actively loaded on `hf-inference` hardware and won't 400 with "Model not supported by provider hf-inference"
3. **Sorted by download count** — most battle-tested models appear first in the catalog

### Hub API Queries

#### Text-generation (chat/instruct models)
```
GET https://huggingface.co/api/models
  ?pipeline_tag=text-generation
  &filter=conversational
  &inference=warm
  &sort=downloads
  &direction=-1
  &limit=120
```

#### Multimodal (vision-language models)
```
GET https://huggingface.co/api/models
  ?pipeline_tag=image-text-to-text
  &inference=warm
  &sort=downloads
  &direction=-1
  &limit=30
```

---

## Why These Filters Matter

| Filter | Why needed |
|--------|------------|
| `pipeline_tag=text-generation` | Restricts to text generation architectures |
| `filter=conversational` | **Critical** — only instruct-tuned models support the chat completions format. Without this, base models (e.g. `Qwen2-0.5B`) appear and return `400 Model not supported by provider hf-inference` |
| `inference=warm` | Only returns models actively warm on the free hf-inference shared cluster. Eliminates paid/dedicated endpoint models |
| `sort=downloads&direction=-1` | Most popular first. Well-downloaded instruct models are more reliable |

> **Do not use** `inference_provider=hf-inference` — this parameter is invalid and returns an empty `[]` response from the Hub API.

---

## How Routing Works

All HF models are routed via the OpenAI-compatible chat completions endpoint on HuggingFace's shared inference cluster:

```
POST https://router.huggingface.co/hf-inference/v1/chat/completions
Authorization: Bearer <user-hf-token>
Content-Type: application/json

{
  "model": "Qwen/Qwen3-0.6B",
  "messages": [{ "role": "user", "content": "Hello" }],
  "max_tokens": 2048,
  "temperature": 0.7,
  "stream": true
}
```

**Response format** — standard OpenAI SSE stream:
```
data: {"choices":[{"delta":{"content":"Hello!"}}]}
data: [DONE]
```

---

## Authentication

HuggingFace models require a **free** HF token — no billing required, just a free account.

**Where the token comes from (priority order):**
1. `providerKeys.huggingface` in request body (sent by frontend from `localStorage('enzo.keys.huggingface')`)
2. `x-huggingface-key` request header
3. `process.env.HF_TOKEN` environment variable

**Obtain a token:** https://huggingface.co/settings/tokens

---

## Catalog Output Format

Each HF model in the catalog:

```json
{
  "id": "hf/Qwen/Qwen3-0.6B",
  "name": "Qwen3-0.6B",
  "provider": "HuggingFace",
  "type": "text",
  "free": true,
  "context_length": 4096,
  "description": "HuggingFace free serverless model (Qwen/Qwen3-0.6B). Runs on shared hf-inference cluster.",
  "pricing_prompt": "$0.00",
  "max_output": 4096
}
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `400 Model not supported by provider hf-inference` | Model is a base (non-instruct) model or not on free cluster | Only select models from the catalog — they are pre-filtered |
| `401 Invalid username or password` | Missing or invalid HF token | Add token in VAULT → HuggingFace field |
| `403 Forbidden` | Token doesn't have inference permissions | Create a token with **Inference API** scope at huggingface.co/settings/tokens |
| Model not appearing in catalog | Model is not warm on hf-inference | It's not available on the free cluster at this time |

---

## Notes

- All models in the HF catalog are **free to use** with a token (no Pollen credits, no billing)
- The free cluster has rate limits; heavily loaded models may queue
- The catalog refreshes automatically every 15 minutes via the `syncModels` background worker