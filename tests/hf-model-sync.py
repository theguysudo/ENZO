#!/usr/bin/env python3
"""
Hugging Face Serverless Model Sync Worker
Fetches trending free models daily at midnight for the ENZO AI marketplace.

Requirements:
  pip install requests apscheduler

Run as background service:
  python3 hf-model-sync.py &

Or with systemd (see README at bottom).
"""

import json
import os
import re
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
from apscheduler.schedulers.blocking import BlockingScheduler

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('/tmp/hf-model-sync.log')
    ]
)
logger = logging.getLogger(__name__)

# Configuration
HF_API_URL = "https://huggingface.co/api/models"
CACHE_FILE = Path(__file__).parent / "model-cache.json"
TOP_N_MODELS = 20

# Patterns to exclude (base models, gated, etc.)
EXCLUDE_PATTERNS = re.compile(
    r'-base$|-base-|embeddings?|text-embedding|clip-vit|vit-|raw-',
    re.IGNORECASE
)

def clean_model_name(model_id: str) -> tuple[str, str, str]:
    """
    Extract clean display name and author from Hugging Face model ID.
    Returns: (id, display_name, author)
    """
    parts = model_id.split('/')
    if len(parts) >= 2:
        author = parts[0]
        model_name = parts[-1]
    else:
        author = "unknown"
        model_name = model_id
    return model_id, model_name, author

def should_include_model(model: dict) -> bool:
    """Check if model should be included in marketplace."""
    model_id = model.get('id', '')

    # Exclude base/gated models
    if EXCLUDE_PATTERNS.search(model_id):
        return False

    # Check if model has inference enabled
    # HF Hub API returns inferenceProviderMapping for serverless availability
    tags = model.get('tags', [])

    # Look for serverless inference indicators
    has_serverless = any(
        tag in ['inference', 'serverless', 'inference-api']
        for tag in tags
    )

    # Also check inference providers (hf-inference, together, etc.)
    if not has_serverless:
        # Some models have provider mapping instead
        has_providers = 'inferenceProviderMapping' in model
        if has_providers:
            providers = model.get('inferenceProviderMapping', {})
            has_serverless = any(
                p == 'hf-inference' or 'serverless' in str(providers.get(p, '')).lower()
                for p in providers.keys()
            )

    return has_serverless

def fetch_models_by_pipeline(pipeline_tag: str) -> list[dict]:
    """Fetch models from HF Hub API filtered by pipeline tag."""
    params = {
        'pipeline_tag': pipeline_tag,
        'sort': 'downloads',
        'limit': TOP_N_MODELS * 3,  # Fetch extra to filter down
        'full': 'false',
        'config': 'false'
    }

    headers = {
        'User-Agent': 'ENZO-AI-Tunnel/1.0',
        'Accept': 'application/json'
    }

    try:
        logger.info(f"Fetching {pipeline_tag} models from Hugging Face...")
        response = requests.get(HF_API_URL, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        models = response.json()
        logger.info(f"  Retrieved {len(models)} raw models for {pipeline_tag}")
        return models
    except requests.RequestException as e:
        logger.error(f"  Failed to fetch {pipeline_tag} models: {e}")
        return []

def process_models(models: list[dict], model_type: str) -> list[dict]:
    """Process raw HF models into marketplace format."""
    processed = []

    for model in models:
        if not should_include_model(model):
            continue

        model_id, display_name, author = clean_model_name(model.get('id', ''))

        # Determine if free (hf-inference serverless is free-tier accessible)
        providers = model.get('inferenceProviderMapping', {})
        is_free = 'hf-inference' in providers

        processed.append({
            'id': f'hf/{model_id}',
            'name': display_name,
            'provider': 'HuggingFace',
            'type': model_type,
            'free': is_free,
            'context_length': 4096 if model_type == 'text_chat' else 0,
            'description': f"{model.get('pipeline_tag', '')} model by {author}. Downloads: {model.get('downloads', 'N/A')}.",
            'tags': infer_tags(display_name, model.get('tags', []), model_type),
            'moderated': True,
            'pricing_prompt': '$0.00' if is_free else 'Check HF pricing',
            'added_date': model.get('lastModified', datetime.now().isoformat()),
            'max_output': 4096 if model_type == 'text_chat' else 0,
        })

    # Sort by downloads and limit
    processed.sort(key=lambda x: int(str(x['description']).split('Downloads: ')[-1].split('.')[0] or 0), reverse=True)
    return processed[:TOP_N_MODELS]

def infer_tags(name: str, tags: list[str], model_type: str) -> list[str]:
    """Infer model capabilities from tags."""
    result = []
    combined = f"{name} {' '.join(tags)}".lower()

    if 'reason' in combined or 'thinking' in combined:
        result.append('Reasoning')
    if 'code' in combined or 'coding' in combined:
        result.append('Coding')
    if model_type == 'image_generation' or 'image-gen' in combined:
        result.append('Image Gen')

    if not result:
        result.append('General Chat' if model_type == 'text_chat' else 'Image Gen')

    return list(set(result))

def load_existing_cache() -> dict:
    """Load existing cache file."""
    try:
        if CACHE_FILE.exists():
            with open(CACHE_FILE, 'r') as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Error loading cache: {e}")
    return {'updatedAt': datetime.now().isoformat(), 'models': []}

def upsert_models(cache: dict, new_models: list[dict]) -> dict:
    """
    UPSERT logic: Update existing models, add new ones, avoid duplicates.
    Uses model ID as unique key.
    """
    existing_ids = {m['id'] for m in cache.get('models', [])}
    updated_models = list(cache.get('models', []))

    for model in new_models:
        if model['id'] in existing_ids:
            # Update existing model (e.g., download counts)
            idx = next(i for i, m in enumerate(updated_models) if m['id'] == model['id'])
            updated_models[idx] = model
            logger.info(f"  Updated existing model: {model['id']}")
        else:
            # Add new model
            updated_models.append(model)
            logger.info(f"  Added new model: {model['id']}")

    return {
        'updatedAt': datetime.now().isoformat(),
        'models': updated_models
    }

def sync_models() -> None:
    """Main sync function - fetches and updates model cache."""
    logger.info("=== Starting HF Model Sync ===")

    # Fetch models by category
    text_models = fetch_models_by_pipeline('text-generation')
    image_models = fetch_models_by_pipeline('text-to-image')

    # Process into marketplace format
    processed_text = process_models(text_models, 'text')
    processed_image = process_models(image_models, 'image-gen')

    logger.info(f"Processed {len(processed_text)} text models, {len(processed_image)} image models")

    # Load existing cache
    cache = load_existing_cache()

    # Merge all models
    all_new = processed_text + processed_image
    updated_cache = upsert_models(cache, all_new)

    # Write updated cache
    try:
        with open(CACHE_FILE, 'w') as f:
            json.dump(updated_cache, f, indent=2)
        logger.info(f"Cache updated: {len(updated_cache['models'])} total models")
    except Exception as e:
        logger.error(f"Failed to write cache: {e}")

    logger.info("=== Sync Complete ===\n")

def main():
    """Run initial sync and start scheduler."""
    # Run immediately on startup
    sync_models()

    # Schedule daily runs at midnight
    scheduler = BlockingScheduler()

    # Run at 00:00 (midnight) every day
    scheduler.add_job(
        sync_models,
        trigger='cron',
        hour=0,
        minute=0,
        id='hf-model-sync'
    )

    logger.info("Scheduler started - running daily at midnight")
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler stopped")

if __name__ == '__main__':
    main()