from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import ensure_db
from .logging_conf import setup_logging
from .routes_admin import router as admin_router
from .routes_portal import router as portal_router
from .routes_public import router as public_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    ensure_db()
    yield


from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store, no-cache, must-revalidate")
        return response


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Secure Document Collection API", lifespan=lifespan)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origin_list, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(admin_router)
    app.include_router(portal_router)
    app.include_router(public_router)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    return app


app = create_app()
