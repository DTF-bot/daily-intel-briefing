import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel


ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


MODEL_PROVIDERS: dict[str, dict[str, str]] = {
    "openai": {
        "name": "OpenAI",
        "env_key": "OPENAI_API_KEY",
        "base_url_key": "OPENAI_BASE_URL",
        "default_base_url": "https://api.openai.com/v1",
        "llm_prefix": "openai",
        "default_model": "gpt-4o-mini",
    },
    "deepseek": {
        "name": "DeepSeek",
        "env_key": "DEEPSEEK_API_KEY",
        "base_url_key": "DEEPSEEK_BASE_URL",
        "default_base_url": "https://api.deepseek.com",
        "llm_prefix": "deepseek",
        "default_model": "deepseek-chat",
    },
    "doubao": {
        "name": "豆包",
        "env_key": "OPENAI_API_KEY",
        "base_url_key": "OPENAI_BASE_URL",
        "default_base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "llm_prefix": "openai",
        "default_model": "Doubao-Seed-Evolving",
    },
    "gemini": {
        "name": "Gemini",
        "env_key": "GOOGLE_API_KEY",
        "base_url_key": "GOOGLE_BASE_URL",
        "default_base_url": "",
        "llm_prefix": "google_genai",
        "default_model": "gemini-1.5-flash",
    },
    "custom": {
        "name": "自定义兼容接口",
        "env_key": "OPENAI_API_KEY",
        "base_url_key": "OPENAI_BASE_URL",
        "default_base_url": "",
        "llm_prefix": "openai",
        "default_model": "",
    },
}


class ModelConfigInput(BaseModel):
    provider: str
    api_key: str = ""
    base_url: str = ""
    model_id: str = ""
    embedding: str = "local:hash"


def get_model_config_status() -> dict[str, Any]:
    active_provider = os.getenv("MODEL_PROVIDER", "openai")
    providers = []
    for provider_id, meta in MODEL_PROVIDERS.items():
        env_key = meta["env_key"]
        base_url_key = meta["base_url_key"]
        model_id = _model_for_provider(provider_id, meta)
        providers.append(
            {
                "id": provider_id,
                "name": meta["name"],
                "configured": bool(os.getenv(env_key)),
                "active": provider_id == active_provider,
                "base_url": os.getenv(base_url_key, meta["default_base_url"]),
                "model_id": model_id,
                "api_key_configured": bool(os.getenv(env_key)),
            }
        )
    active_meta = MODEL_PROVIDERS.get(active_provider, MODEL_PROVIDERS["openai"])
    return {
        "active_provider": active_provider,
        "providers": providers,
        "active": {
            "provider": active_provider,
            "provider_name": active_meta["name"],
            "base_url": os.getenv(active_meta["base_url_key"], active_meta["default_base_url"]),
            "model_id": _model_for_provider(active_provider, active_meta),
            "api_key_configured": bool(os.getenv(active_meta["env_key"])),
            "embedding": os.getenv("EMBEDDING", "local:hash"),
        },
    }


def save_model_config(payload: ModelConfigInput) -> dict[str, Any]:
    provider_id = payload.provider if payload.provider in MODEL_PROVIDERS else "custom"
    meta = MODEL_PROVIDERS[provider_id]
    model_id = payload.model_id.strip() or meta["default_model"]
    base_url = payload.base_url.strip() or meta["default_base_url"]
    llm_value = f"{meta['llm_prefix']}:{model_id}" if model_id else os.getenv("FAST_LLM", "")

    updates = {
        "MODEL_PROVIDER": provider_id,
        "FAST_LLM": llm_value,
        "SMART_LLM": llm_value,
        "STRATEGIC_LLM": llm_value,
        "EMBEDDING": payload.embedding.strip() or "local:hash",
        meta["base_url_key"]: base_url,
    }

    api_key = payload.api_key.strip()
    if api_key and not set(api_key) <= {"*", "•"}:
        updates[meta["env_key"]] = api_key

    if provider_id == "doubao" and base_url:
        updates["OPENAI_BASE_URL"] = base_url
    if provider_id == "deepseek":
        updates["DEEPSEEK_BASE_URL"] = base_url
    if provider_id in {"openai", "doubao", "custom"} and base_url:
        updates["OPENAI_BASE_URL"] = base_url

    _update_env_file(updates)
    os.environ.update(updates)
    return get_model_config_status()


def _model_for_provider(provider_id: str, meta: dict[str, str]) -> str:
    active_prefix = meta["llm_prefix"] + ":"
    llm = os.getenv("FAST_LLM", "")
    if os.getenv("MODEL_PROVIDER") == provider_id and llm.startswith(active_prefix):
        return llm.split(":", 1)[1]
    return meta["default_model"]


def _read_env_lines() -> list[str]:
    if not ENV_PATH.exists():
        return []
    return ENV_PATH.read_text(encoding="utf-8").splitlines()


def _update_env_file(updates: dict[str, str]) -> None:
    lines = _read_env_lines()
    seen: set[str] = set()
    next_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            next_lines.append(line)
            continue
        key = line.split("=", 1)[0].strip()
        if key in updates:
            next_lines.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            next_lines.append(line)

    for key, value in updates.items():
        if key not in seen:
            next_lines.append(f"{key}={value}")

    ENV_PATH.write_text("\n".join(next_lines) + "\n", encoding="utf-8")
