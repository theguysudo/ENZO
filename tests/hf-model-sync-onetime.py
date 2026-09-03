#!/usr/bin/env python3
"""
One-time Hugging Face serverless model fetch.
Run this manually or via cron.

Usage:
  python3 hf-model-sync-onetime.py [--output <path>]

Cron entry (runs at midnight):
  0 0 * * * /usr/bin/python3 /Users/aditya/backend/hf-model-sync-onetime.py >> /tmp/hf-sync.log 2>&1
"""

import argparse
import json
import re
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

HF_API_URL = "https://huggingface.co/api/models"
EXCLUDE_PATTERNS = re.compile(r'-base$|-base-|embeddings?|text-embedding|clip-vit|vit-', re.IGNORECASE)

def fetch_serverless_models(pipeline_tag: str, limit: int = 20) -> list[dict]:
    """Fetch models with serverless inference enabled."""
    results = []

    # Fetch in batches
    for offset in range(0, limit * 3, limit):
        params = {
            'pipeline_tag': pipeline_tag,
            'sort': 'downloads',
            'limit': limit,
            'full': 'true'  # Need inferenceProviderMapping
        }
        headers = {'User-Agent': 'ENZO-AI-Tunnel/1.0'}

        try:
            r = requests.get(HF_API_URL, params=params, headers=headers, timeout=30)
            r.raise_for_status()
            models = r.json()

            for m in models:
                if EXCLUDE_PATTERNS.search(m.get('id', '')):
                    continue
                providers = m.get('inferenceProviderMapping', {}) or {}
                if 'hf-inference' in providers:
                    results.append(m)
        except Exception as e:
            logger.error(f"Error fetching {pipeline_tag}: {e}")

    # Sort by downloads
    results.sort(key=lambda x: x.get('downloads', 0), reverse=True)
    return results[:limit]

def to_catalog_format(model: dict, model_type: str) -> dict:
    """Convert HF model to catalog format."""
    model_id = model.get('id', '')
    parts = model_id.split('/')
    author = parts[0] if len(parts) > 1 else 'unknown'
    name = parts[-1] if len(parts) > 1 else model_id

    return {
        'id': f'hf/{model_id}',
        'name': name,
        'provider': 'HuggingFace',
        'type': model_type,
        'free': True,  # hf-inference = serverless free tier
        'context_length': 4096 if model_type == 'text' else 0,
        'description': f"{model_type.replace('_', ' ')} model. Downloads: {model.get('downloads', 0):,}.",
        'tags': ['Reasoning'] if 'reason' in name.lower() else (['Image Gen'] if model_type == 'image-gen' else ['General Chat']),
        'moderated': True,
        'pricing_prompt': '$0.00',
        'added_date': model.get('lastModified', datetime.now().isoformat()),
        'max_output': 4096
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='model-cache.json')
    args = parser.parse_args()

    output_path = Path(__file__).parent / args.output

    logger.info("Fetching Hugging Face serverless models...")

    # Fetch both categories
    text_models = fetch_serverless_models('text-generation', 20)
    image_models = fetch_serverless_models('text-to-image', 20)

    # Format for catalog
    all_models = [to_catalog_format(m, 'text') for m in text_models]
    all_models += [to_catalog_format(m, 'image-gen') for m in image_models]

    # Load existing cache and merge
    if output_path.exists():
        with open(output_path) as f:
            cache = json.load(f)
    else:
        cache = {'updatedAt': '', 'models': []}

    # Upsert (update existing, add new)
    existing_ids = {m['id'] for m in cache['models']}
    for m in all_models:
        if m['id'] in existing_ids:
            # Update existing
            idx = next(i for i, x in enumerate(cache['models']) if x['id'] == m['id'])
            cache['models'][idx] = m
        else:
            cache['models'].append(m)

    cache['updatedAt'] = datetime.now().isoformat()

    with open(output_path, 'w') as f:
        json.dump(cache, f, indent=2)

    logger.info(f"Updated cache with {len(all_models)} models")

if __name__ == '__main__':
    main()