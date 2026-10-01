"""Private encrypted file storage. Callers never see ciphertext: put_file/get_file encrypt/decrypt."""
from pathlib import Path

import httpx

from .config import get_settings
from .security import decrypt, encrypt


class LocalStorage:
    def __init__(self, base: str):
        self.base = Path(base).resolve()
        self.base.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = (self.base / key).resolve()
        if self.base not in p.parents:
            raise ValueError("invalid storage key")
        return p

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class SupabaseStorage:
    """Private Supabase Storage bucket, accessed only with the service key from the backend."""

    def __init__(self, url: str, service_key: str, bucket: str):
        self.base = f"{url.rstrip('/')}/storage/v1/object"
        self.bucket = bucket
        self.headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}

    def put(self, key: str, data: bytes) -> None:
        r = httpx.post(
            f"{self.base}/{self.bucket}/{key}",
            content=data,
            headers={**self.headers, "Content-Type": "application/octet-stream", "x-upsert": "true"},
            timeout=60,
        )
        r.raise_for_status()

    def get(self, key: str) -> bytes:
        r = httpx.get(f"{self.base}/authenticated/{self.bucket}/{key}", headers=self.headers, timeout=60)
        r.raise_for_status()
        return r.content

    def delete(self, key: str) -> None:
        r = httpx.delete(f"{self.base}/{self.bucket}/{key}", headers=self.headers, timeout=60)
        if r.status_code in (200, 204, 404):
            return
        if r.status_code == 400 and ("not_found" in r.text or "NoSuchKey" in r.text or "Object not found" in r.text):
            return
        r.raise_for_status()


_storage = None


def get_storage():
    global _storage
    if _storage is None:
        s = get_settings()
        if s.storage_backend == "supabase":
            _storage = SupabaseStorage(s.supabase_url, s.supabase_service_key, s.supabase_bucket)
        else:
            _storage = LocalStorage(s.local_storage_dir)
    return _storage


def reset_storage() -> None:
    global _storage
    _storage = None


def put_file(key: str, data: bytes) -> None:
    get_storage().put(key, encrypt(data))


def get_file(key: str) -> bytes:
    return decrypt(get_storage().get(key))


def delete_file(key: str) -> None:
    get_storage().delete(key)
