import base64
import hashlib
import os
import secrets

import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import Header, HTTPException

from .config import get_settings


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def generate_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


def _key() -> bytes:
    raw = get_settings().encryption_key
    if not raw:
        raise RuntimeError("ENCRYPTION_KEY is not set. Generate one with: python -m app.security")
    key = base64.urlsafe_b64decode(raw)
    if len(key) != 32:
        raise RuntimeError("ENCRYPTION_KEY must be urlsafe-base64 of exactly 32 bytes")
    return key


def encrypt(data: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(_key()).encrypt(nonce, data, None)


def decrypt(blob: bytes) -> bytes:
    return AESGCM(_key()).decrypt(blob[:12], blob[12:], None)


from jwt import PyJWKClient, PyJWTError

_jwks_client: PyJWKClient | None = None


def get_jwks_client() -> PyJWKClient | None:
    global _jwks_client
    s = get_settings()
    if not s.supabase_url:
        return None
    if _jwks_client is None:
        jwks_url = f"{s.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=3600)
    return _jwks_client


def reset_jwks_client() -> None:
    global _jwks_client
    _jwks_client = None


def set_jwks_client(client: PyJWKClient | None) -> None:
    global _jwks_client
    _jwks_client = client


def require_admin(authorization: str | None = Header(default=None)) -> str:
    """Verifies a Supabase-issued JWT via JWKS (or HS256 secret) and checks the email against ADMIN_EMAILS."""
    s = get_settings()
    if not s.supabase_jwt_secret and not s.supabase_url:
        raise HTTPException(503, "admin_auth_not_configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing_token")
    token = authorization.split(" ", 1)[1].strip()

    claims = None
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "HS256")
        if alg == "HS256" and s.supabase_jwt_secret:
            claims = jwt.decode(token, s.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated")
        else:
            jwks = get_jwks_client()
            if jwks:
                signing_key = jwks.get_signing_key_from_jwt(token)
                claims = jwt.decode(token, signing_key.key, algorithms=[alg, "RS256", "ES256"], audience="authenticated")
            elif s.supabase_jwt_secret:
                claims = jwt.decode(token, s.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated")
    except Exception:
        raise HTTPException(401, "invalid_token")

    if not claims:
        raise HTTPException(401, "invalid_token")

    email = str(claims.get("email", "")).lower()
    if not email or email not in s.admin_email_list:
        raise HTTPException(403, "not_an_admin")
    return email


if __name__ == "__main__":
    print(generate_key())
